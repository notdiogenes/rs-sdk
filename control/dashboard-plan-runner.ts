import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { BotWorldState } from '../sdk/types';
import type { ControllerStatus } from './dashboard-activity';
import { finished, nextWork, type Step, type Work } from './dashboard-plan';
import { activity, type ActivityId, type ActivityOptions } from './dashboard-task-catalog';
import type { DashboardWorkerUpdates, WorkerRelease } from './dashboard-worker-policy';
import type { ActiveTaskUpdate } from './dashboard-task-update';
import type { MeleeGoal } from './melee-training';

export type Plan = {
    bot: string;
    steps: Step[];
    revision: string;
    index: number;
    elapsedMs: number;
    status: 'running' | 'paused' | 'blocked' | 'complete';
    work?: Work;
    message?: string;
};

export type PlanBackend = {
    status(): ControllerStatus;
    prepare(signal: AbortSignal): Promise<void>;
    observe(): Promise<BotWorldState | null>;
    start(task: ActivityId, skill?: string, bankTarget?: number, options?: ActivityOptions, release?: WorkerRelease, meleeGoal?: MeleeGoal): Promise<void>;
    stop(): Promise<void>;
    stopForRuntimeMove?(runId: string): Promise<boolean>;
    activeUpdate?(): ActiveTaskUpdate | undefined;
    safeForUpdate?(): boolean;
    requestCheckpoint?(runId: string, id: string): boolean;
    commitCheckpoint?(runId: string, id: string): void;
    cancelCheckpoint?(runId: string): void;
};

export class PlanEditConflict extends Error {}

type PendingTransition = {
    index: number;
    planRevision: string;
    runId: string;
    attempt?: string;
    applying?: boolean;
} & (
    | { kind: 'release'; mode: 'safe' | 'now'; release: WorkerRelease; reviewed?: Step }
    | { kind: 'runtime'; mode: 'safe' | 'immediate'; stillAssigned: () => boolean;
        stopped?: Promise<{ ok: true } | { ok: false; error: unknown }> }
);
type PlanJob = {
    plan: Plan;
    cancel: AbortController;
    done: Promise<void>;
    backend?: PlanBackend;
    pending?: PendingTransition;
    updateMessage?: string;
};

const initial = (bot: string, steps: Step[]): Plan => ({ bot, steps, revision: randomUUID(), index: 0, elapsedMs: 0, status: 'running' });
const interval = 2500;

function readPlan(data: string): Plan {
    const plan = JSON.parse(data) as Plan;
    // Pre-edit plans have no revision until their next structural change.
    plan.revision ??= 'legacy';
    return plan;
}

const sameOptions = (first?: ActivityOptions, second?: ActivityOptions) =>
    JSON.stringify(first ?? {}) === JSON.stringify(second ?? {});

function sameStep(first: Step | undefined, second: Step | undefined) {
    if (!first || !second) return first === second;
    return first.task === second.task && JSON.stringify(first.finish) === JSON.stringify(second.finish) &&
        JSON.stringify(first.requirements) === JSON.stringify(second.requirements) && sameOptions(first.options, second.options) &&
        (first.configurationVersion ?? 1) === (second.configurationVersion ?? 1);
}

const workSkill = (work: Work) => work.finish.type === 'level' ? work.finish.skill : undefined;
const workMeleeGoal = (work: Work) => work.finish.type === 'melee-levels' ? work.finish : undefined;
const workBankTarget = (work: Work) => work.finish.type === 'bank-stock' ? work.finish.quantity : undefined;

function sameLaunch(first: Work, second: Work) {
    const { finishOnEssenceExhausted: _firstFinishOption, ...firstOptions } = first.options ?? {};
    const { finishOnEssenceExhausted: _secondFinishOption, ...secondOptions } = second.options ?? {};
    return first.task === second.task && workSkill(first) === workSkill(second) &&
        workBankTarget(first) === workBankTarget(second) && JSON.stringify(workMeleeGoal(first)) === JSON.stringify(workMeleeGoal(second)) &&
        sameOptions(firstOptions, secondOptions);
}

function verifiedCompletion(work: Work, status: ControllerStatus) {
    const exit = status.lastTask;
    if (status.task || exit?.name !== work.task || exit.exitCode !== 0) return false;
    if (exit.completion === 'bank-stock') return work.finish.type === 'bank-stock';
    const finishOnEssenceExhausted = !work.inserted && work.task === 'craft-body-runes' && work.options?.finishOnEssenceExhausted;
    return exit.completion === 'essence-exhausted' && (work.finish.type === 'essence-exhausted' || finishOnEssenceExhausted === true);
}

function assignmentMatches(check: () => boolean) {
    try { return check(); }
    catch { return false; }
}

export function createPlanManager(directory: string, backendFor: (bot: string, signal: AbortSignal) => Promise<PlanBackend>,
    updates?: Pick<DashboardWorkerUpdates, 'load' | 'current'>) {
    const db = new Database(join(directory, 'activity-plans.sqlite'), { create: true });
    db.exec('CREATE TABLE IF NOT EXISTS activity_plan (bot TEXT PRIMARY KEY COLLATE NOCASE, data TEXT NOT NULL)');
    const read = db.query<{ data: string }, [string]>('SELECT data FROM activity_plan WHERE bot = ?');
    const write = db.query('INSERT OR REPLACE INTO activity_plan (bot, data) VALUES (?, ?)');
    const jobs = new Map<string, PlanJob>();
    const list = () => db.query<{ data: string }, []>('SELECT data FROM activity_plan ORDER BY bot').all()
        .map(({ data }) => readPlan(data));
    const get = (bot: string): Plan | null => {
        const row = read.get(bot);
        return row ? readPlan(row.data) : null;
    };
    const save = (plan: Plan) => write.run(plan.bot, JSON.stringify(plan));
    function saveRevision(plan: Plan) {
        plan.revision = randomUUID();
        save(plan);
    }

    function advance(plan: Plan) {
        plan.index++;
        plan.elapsedMs = 0;
        plan.work = undefined;
        saveRevision(plan);
    }

    const active = (bot: string) => jobs.has(bot.toLowerCase()) || get(bot)?.status === 'running';

    function cancelPending(job: PlanJob) {
        if (job.pending) job.backend?.cancelCheckpoint?.(job.pending.runId);
        job.pending = undefined;
    }

    function checkpointClosing(job: PlanJob) {
        const attempt = job.pending?.attempt;
        if (!attempt) return false;
        const checkpoint = job.backend?.activeUpdate?.()?.checkpoint;
        const status = job.backend?.status();
        return checkpoint?.id === attempt && (checkpoint.phase === 'committed' || checkpoint.phase === 'accepted') ||
            !status?.task && status?.lastTask?.updateId === attempt;
    }

    function cancelSupersededRuntimeMove(job: PlanJob) {
        const { pending } = job;
        if (pending?.kind !== 'runtime' || pending.applying || assignmentMatches(pending.stillAssigned)) return;
        // A committed checkpoint may already have stopped the activity. Let
        // the replacement use the latest assignment at its own launch.
        if (!checkpointClosing(job)) cancelPending(job);
    }

    function requestUpdate(bot: string, index: number, planRevision: string, runId: string,
        release: WorkerRelease, mode: 'safe' | 'now', reviewed?: Step) {
        const job = jobs.get(bot.toLowerCase());
        const running = job?.backend?.activeUpdate?.();
        if (!job || job.plan.index !== index || job.plan.revision !== planRevision || job.cancel.signal.aborted || running?.runId !== runId) {
            throw new PlanEditConflict('The running activity changed. Reload updates before retrying.');
        }
        if (job.pending) throw new PlanEditConflict(job.pending.kind === 'runtime'
            ? 'A runtime move is already waiting for this activity.'
            : 'An update is already waiting for this activity.');
        const step = reviewed ?? job.plan.steps[index]!;
        const compatibility = release.value.checkStepCompatibility(step);
        if (compatibility.status === 'review') throw new PlanEditConflict(compatibility.reason);
        if (mode === 'safe' && !running.supported) {
            throw new PlanEditConflict('This run does not provide safe checkpoints. Pause it before reviewing settings or use Update now when available.');
        }
        if (mode === 'now' && !job.backend?.safeForUpdate?.()) {
            throw new PlanEditConflict('Wait for fresh game state outside combat with enough health and all game windows closed.');
        }
        job.pending = { kind: 'release', index, planRevision, runId, release, mode, reviewed };
        job.updateMessage = undefined;
    }

    function requestRuntimeMove(bot: string, runId: string, mode: 'safe' | 'immediate',
        stillAssigned: () => boolean): 'queued' | 'relaunching' | 'next-launch' {
        const job = jobs.get(bot.toLowerCase());
        const backend = job?.backend;
        const running = backend?.activeUpdate?.();
        if (!job || !backend || job.plan.status !== 'running' || job.cancel.signal.aborted ||
            running?.runId !== runId || !backend.status().task || !assignmentMatches(stillAssigned)) return 'next-launch';
        cancelSupersededRuntimeMove(job);
        if (job.pending) {
            if (job.pending.kind !== 'runtime' || job.pending.runId !== runId) return 'next-launch';
            return job.pending.mode === 'immediate' ? 'relaunching' : 'queued';
        }
        if (mode === 'safe' && (!running.supported || !backend.requestCheckpoint ||
            !backend.commitCheckpoint || !backend.safeForUpdate)) return 'next-launch';
        if (mode === 'immediate' && !backend.stopForRuntimeMove) return 'next-launch';

        const pending: PendingTransition = {
            kind: 'runtime', mode, stillAssigned, runId, index: job.plan.index, planRevision: job.plan.revision,
        };
        job.pending = pending;
        if (mode === 'safe') return 'queued';

        pending.stopped = Promise.resolve().then(async () => {
            // The request deliberately does not wait for combat or a fresh snapshot.
            // If this run ended before the stop request was dispatched, there is
            // nothing to stop and ordinary plan completion can take over.
            if (job.cancel.signal.aborted || job.pending !== pending ||
                backend.activeUpdate?.()?.runId !== runId || !assignmentMatches(stillAssigned)) {
                if (job.pending === pending) job.pending = undefined;
            } else {
                pending.applying = true;
                if (!await backend.stopForRuntimeMove!(runId) && job.pending === pending) job.pending = undefined;
            }
        }).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
        return 'relaunching';
    }

    function activeUpdate(bot: string) {
        const job = jobs.get(bot.toLowerCase());
        return {
            running: job?.backend?.activeUpdate?.(),
            waiting: job?.pending?.kind === 'release',
            message: job?.updateMessage,
        };
    }

    function cancelUpdate(bot: string, runId: string) {
        const job = jobs.get(bot.toLowerCase());
        if (job?.pending?.kind !== 'release' || job.pending.runId !== runId) throw new PlanEditConflict('This update is no longer pending.');
        const phase = job.backend?.activeUpdate?.()?.checkpoint?.phase;
        if (job.pending.applying || phase === 'committed' || phase === 'accepted' || checkpointClosing(job)) {
            throw new PlanEditConflict('The activity is already switching releases.');
        }
        cancelPending(job);
    }

    async function applyPending(job: PlanJob, backend: PlanBackend, status: ControllerStatus): Promise<PendingTransition | undefined> {
        cancelSupersededRuntimeMove(job);
        const { plan, pending } = job;
        if (!pending) return;
        if (pending.kind === 'runtime' && pending.stopped) {
            const result = await pending.stopped;
            job.cancel.signal.throwIfAborted();
            if (!result.ok) throw result.error;
            if (job.pending !== pending) return;
            job.pending = undefined;
            return pending;
        }
        const running = backend.activeUpdate?.();
        if (plan.index !== pending.index || plan.revision !== pending.planRevision) {
            cancelPending(job);
            return;
        }
        if (!status.task && pending.attempt && status.lastTask?.updateId === pending.attempt && status.lastTask.exitCode === 0) {
            // The script verified the checkpoint again and exited voluntarily.
        } else if (running?.runId !== pending.runId) {
            cancelPending(job);
            return;
        } else if (pending.kind === 'release' && pending.mode === 'now') {
            if (!backend.safeForUpdate?.()) {
                job.updateMessage = 'The bot is busy or needs recovery. Try again at a safe point.';
                cancelPending(job);
                return;
            }
            pending.applying = true;
            await backend.stop();
            job.cancel.signal.throwIfAborted();
            if (job.pending !== pending || plan.revision !== pending.planRevision) return;
        } else {
            const checkpoint = running.checkpoint;
            if (!checkpoint) {
                const id = randomUUID();
                if (backend.requestCheckpoint?.(running.runId, id)) pending.attempt = id;
            } else if (checkpoint.id === pending.attempt && checkpoint.phase === 'ready' && backend.safeForUpdate?.()) {
                backend.commitCheckpoint?.(running.runId, checkpoint.id);
            }
            return;
        }
        if (pending.kind === 'release' && pending.reviewed) {
            const old = plan.steps[pending.index];
            plan.steps[pending.index] = pending.reviewed;
            if (old?.task !== pending.reviewed.task) plan.elapsedMs = 0;
            saveRevision(plan);
        }
        job.pending = undefined;
        return pending;
    }

    async function waitReady(backend: PlanBackend, signal: AbortSignal) {
        const until = Date.now() + 90_000;
        let tick: number | undefined;
        while (Date.now() < until) {
            signal.throwIfAborted();
            if (!backend.status().client) throw new Error('The game client exited before it became ready.');
            const state = await backend.observe().catch(() => null);
            if (state?.player) {
                if (tick !== undefined && state.tick !== tick) return state;
                tick = state.tick;
            }
            await Bun.sleep(interval);
        }
        throw new Error('No fresh game state arrived for the managed client.');
    }

    async function run(job: PlanJob) {
        const { plan } = job;
        const { signal } = job.cancel;
        let backend: PlanBackend | undefined;
        let owned = false;
        let nextLaunch: { release?: WorkerRelease } | undefined;
        try {
            backend = await backendFor(plan.bot, signal);
            job.backend = backend;
            signal.throwIfAborted();
            if (backend.status().task) throw new Error('Stop the current activity before running a plan.');
            await backend.prepare(signal);
            let state = await waitReady(backend, signal);
            let missingSince = 0;
            while (plan.index < plan.steps.length) {
                signal.throwIfAborted();
                let step = plan.steps[plan.index]!;
                let work: Work | null;
                let release: WorkerRelease | undefined;
                try {
                    release = nextLaunch ? nextLaunch.release : await updates?.load();
                    signal.throwIfAborted();
                    // A plan edit can arrive while a new revision is loading.
                    if (step !== plan.steps[plan.index]) continue;
                    work = (release?.value.nextWork ?? nextWork)(step, state, plan.elapsedMs);
                    missingSince = 0;
                } catch (error) {
                    signal.throwIfAborted();
                    if (error instanceof Error && error.name === 'PlanConfigurationConflict') throw error;
                    missingSince ||= Date.now();
                    if (Date.now() - missingSince > 20_000) throw error;
                    await Bun.sleep(interval);
                    state = await backend.observe() ?? state;
                    continue;
                }
                if (!work) {
                    nextLaunch = undefined;
                    advance(plan);
                    continue;
                }
                plan.work = work;
                save(plan);
                signal.throwIfAborted();
                if (backend.status().task) throw new Error('Stop the current activity before running a plan.');
                const launchedWork = { ...work };
                const launchedRelease = release;
                await backend.start(work.task, workSkill(work), workBankTarget(work), work.options, release, workMeleeGoal(work));
                nextLaunch = undefined;
                owned = true;
                let lastLive = Date.now();
                let previous = lastLive;
                let endedAt = 0;
                let missingFinishSince = 0;
                let missingEditSince = 0;
                for (;;) {
                    signal.throwIfAborted();
                    await Bun.sleep(interval);
                    signal.throwIfAborted();
                    const snapshot = await backend.observe().catch(() => null);
                    signal.throwIfAborted();
                    const now = Date.now();
                    const status = backend.status();
                    const revised = plan.steps[plan.index];
                    if (!revised) break;
                    if (!snapshot?.player) {
                        cancelSupersededRuntimeMove(job);
                        const runtime = job.pending?.kind === 'runtime' ? job.pending : undefined;
                        if (runtime && (runtime.stopped || !status.task && runtime.attempt &&
                            status.lastTask?.updateId === runtime.attempt) &&
                            await applyPending(job, backend, status)) {
                            if (verifiedCompletion(work, backend.status())) advance(plan);
                            else nextLaunch = { release: launchedRelease };
                            break;
                        }
                        previous = now;
                        if (!status.client || now - lastLive > 25_000) throw new Error('The managed game client stopped publishing live state.');
                        continue;
                    }
                    state = snapshot;
                    lastLive = now;
                    if (revised !== step) {
                        let replacement: Work | null;
                        let updatedRelease: WorkerRelease | undefined;
                        try {
                            updatedRelease = await updates?.load();
                            signal.throwIfAborted();
                            if (revised !== plan.steps[plan.index]) continue;
                            replacement = (updatedRelease?.value.nextWork ?? nextWork)(revised, state, plan.elapsedMs);
                            missingEditSince = 0;
                        } catch (error) {
                            signal.throwIfAborted();
                            if (error instanceof Error && error.name === 'PlanConfigurationConflict') throw error;
                            missingEditSince ||= now;
                            if (now - missingEditSince > 20_000) throw error;
                            previous = now;
                            continue;
                        }
                        if (!replacement) {
                            advance(plan);
                            break;
                        }
                        if (!sameLaunch(launchedWork, replacement)) break;
                        if (work.finish.type !== 'minutes' || work.inserted) previous = now;
                        step = revised;
                        work = replacement;
                        release = updatedRelease;
                        plan.work = work;
                        save(plan);
                    }
                    if (status.task && !status.task.stopping && !work.inserted && work.finish.type === 'minutes') {
                        // Only charge intervals bounded by live game snapshots from this run.
                        plan.elapsedMs += Math.max(0, now - previous);
                        save(plan);
                    }
                    previous = now;
                    let done = false;
                    try {
                        done = (release?.value.finished ?? finished)(work, state, plan.elapsedMs);
                        missingFinishSince = 0;
                    } catch (error) {
                        missingFinishSince ||= now;
                        if (now - missingFinishSince > 20_000) throw error;
                    }
                    if (done && (work.finish.type !== 'complete' || !status.task)) {
                        if (!work.inserted) advance(plan);
                        break;
                    }
                    if (job.pending?.kind === 'runtime' && verifiedCompletion(work, status)) {
                        advance(plan);
                        break;
                    }
                    const applied = await applyPending(job, backend, status);
                    if (applied) {
                        if (applied.kind === 'runtime' && verifiedCompletion(work, backend.status())) advance(plan);
                        else nextLaunch = { release: applied.kind === 'release' ? applied.release : launchedRelease };
                        break;
                    }
                    if (!status.task) {
                        const exit = status.lastTask;
                        if (verifiedCompletion(work, status)) {
                            advance(plan);
                            break;
                        }
                        if (exit?.name === work.task && exit.exitCode !== 0) {
                            throw new Error(`${(release?.value.activity ?? activity)(work.task).label} exited with code ${exit.exitCode}.`);
                        }
                        endedAt ||= now;
                        if (now - endedAt > 7500) {
                            throw new Error(`${(release?.value.activity ?? activity)(work.task).label} exited before the finish condition was verified.`);
                        }
                    }
                }
                if (job.pending?.kind === 'runtime' && job.pending.stopped) {
                    const result = await job.pending.stopped;
                    if (!result.ok) throw result.error;
                }
                cancelPending(job);
                if (backend.status().task) await backend.stop();
                owned = false;
                signal.throwIfAborted();
                plan.work = undefined;
                save(plan);
            }
            plan.status = 'complete';
            plan.message = undefined;
            saveRevision(plan);
        } catch (error) {
            const moving = job.pending?.kind === 'runtime' && job.pending.stopped ? job.pending : undefined;
            if (moving?.stopped) {
                // A concurrent pause must drain the exact stop already in
                // progress before considering the ordinary stop path.
                const result = await moving.stopped;
                if (signal.aborted && result.ok && plan.index === moving.index &&
                    plan.work && backend && verifiedCompletion(plan.work, backend.status())) advance(plan);
            }
            cancelPending(job);
            if (owned && backend?.status().task) {
                try { await backend.stop(); }
                catch {
                    plan.status = 'blocked';
                    plan.message = 'The controller could not stop the active step. Check the running activity before resuming.';
                    saveRevision(plan);
                    return;
                }
            }
            plan.status = signal.aborted ? 'paused' : 'blocked';
            plan.message = signal.aborted ? undefined : error instanceof Error ? error.message : 'The plan stopped unexpectedly.';
            saveRevision(plan);
        }
    }

    function launch(plan: Plan) {
        const key = plan.bot.toLowerCase();
        const job: PlanJob = { plan, cancel: new AbortController(), done: Promise.resolve() };
        jobs.set(key, job);
        job.done = run(job).finally(() => jobs.delete(key));
        return plan;
    }

    function start(bot: string, steps: Step[]) {
        if (active(bot)) throw new Error('Pause the running plan before replacing it.');
        const plan = initial(bot, steps);
        save(plan);
        return launch(plan);
    }

    function resume(bot: string) {
        const plan = get(bot);
        if (!plan || !['paused', 'blocked'].includes(plan.status) || active(bot)) throw new Error('There is no paused or blocked plan to resume.');
        plan.status = 'running';
        plan.message = undefined;
        saveRevision(plan);
        return launch(plan);
    }

    function update(bot: string, steps: Step[], expectedRevision: string, removedCompletedIndexes: readonly number[] = []) {
        const job = jobs.get(bot.toLowerCase());
        const plan = job?.plan ?? get(bot);
        if (!plan || plan.revision !== expectedRevision || job?.cancel.signal.aborted) {
            throw new PlanEditConflict('The saved plan changed. Reload it before saving your edits.');
        }
        const checkpoint = job?.backend?.activeUpdate?.()?.checkpoint?.phase;
        if (job?.pending?.applying || checkpoint === 'committed' || checkpoint === 'accepted' || job && checkpointClosing(job)) {
            throw new PlanEditConflict('The activity is switching releases.');
        }
        const removed = new Set(removedCompletedIndexes);
        if (removed.size !== removedCompletedIndexes.length || removedCompletedIndexes.some(index =>
            !Number.isSafeInteger(index) || index < 0 || index >= plan.index)) {
            throw new PlanEditConflict('Choose completed activities to remove from this plan.');
        }
        const retained = removed.size ? plan.steps.filter((_, index) => !removed.has(index)) : plan.steps;
        const nextIndex = plan.index - removed.size;
        for (let index = 0; index < nextIndex; index++) {
            if (!sameStep(retained[index], steps[index])) {
                throw new PlanEditConflict('Completed activities cannot be changed.');
            }
        }
        if (!removed.size && plan.steps.length === steps.length && steps.every((step, index) => sameStep(step, retained[index]))) return plan;

        const current = plan.steps[plan.index];
        const revised = steps[nextIndex];
        // Keep unchanged step objects so edits to the tail never re-evaluate
        // the prerequisites or launch arguments of the running child.
        const proposed: Plan = {
            ...plan,
            revision: randomUUID(),
            index: nextIndex,
            steps: steps.map((step, index) => sameStep(step, retained[index]) ? retained[index]! : step),
        };
        if (current?.task !== revised?.task) proposed.elapsedMs = 0;
        if (!sameStep(current, revised)) {
            proposed.message = undefined;
            if (!job) proposed.work = undefined;
        }
        if (proposed.status !== 'running') {
            if (proposed.index === proposed.steps.length) proposed.status = 'complete';
            else if (proposed.status === 'complete') proposed.status = 'paused';
        }
        save(proposed);
        if (job) cancelPending(job);
        Object.assign(plan, proposed);
        return plan;
    }

    function queueMining(bot: string, next: Step) {
        const job = jobs.get(bot.toLowerCase());
        const plan = job?.plan;
        const step = plan?.steps[plan.index];
        if (!plan || plan.status !== 'running' || job?.cancel.signal.aborted ||
            plan.index !== plan.steps.length - 1 || step?.task !== 'craft-body-runes') {
            throw new Error('Mining can be queued after the current final runecrafting step.');
        }
        if (job?.pending?.kind === 'runtime' && (job.pending.applying || checkpointClosing(job))) {
            throw new PlanEditConflict('The activity is switching runtime groups.');
        }
        if (plan.steps.length >= 12 || (updates?.current().activity ?? activity)(next.task).category !== 'Mining') {
            throw new Error('Choose a mining activity to queue.');
        }
        const finish = { type: 'essence-exhausted' } as const;
        step.finish = finish;
        if (plan.work?.task === step.task) plan.work.finish = finish;
        plan.steps.push(next);
        saveRevision(plan);
        return plan;
    }

    async function pause(bot: string) {
        const job = jobs.get(bot.toLowerCase());
        if (!job) return get(bot);
        job.cancel.abort();
        await job.done;
        return get(bot);
    }

    function restore() {
        for (const plan of list()) {
            if (plan.status === 'running' && !jobs.has(plan.bot.toLowerCase())) launch(plan);
        }
    }

    return { get, list, active, activeUpdate, requestUpdate, requestRuntimeMove, cancelUpdate, start, resume, update, pause, queueMining, restore,
        supportsCompletedRemoval: true as const, supportsFinishOnEssenceExhausted: true as const, close: () => db.close() };
}

import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { BotWorldState } from '../sdk/types';
import type { ControllerStatus } from './dashboard-activity';
import { finished, nextWork, type Step, type Work } from './dashboard-plan';
import { activity, type ActivityId } from './dashboard-task-catalog';

export type Plan = {
    bot: string;
    steps: Step[];
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
    start(task: ActivityId, skill?: string): Promise<void>;
    stop(): Promise<void>;
};

const initial = (bot: string, steps: Step[]): Plan => ({ bot, steps, index: 0, elapsedMs: 0, status: 'running' });
const interval = 2500;

export function createPlanManager(directory: string, backendFor: (bot: string, signal: AbortSignal) => Promise<PlanBackend>) {
    const db = new Database(join(directory, 'activity-plans.sqlite'), { create: true });
    db.exec('CREATE TABLE IF NOT EXISTS activity_plan (bot TEXT PRIMARY KEY COLLATE NOCASE, data TEXT NOT NULL)');
    const read = db.query<{ data: string }, [string]>('SELECT data FROM activity_plan WHERE bot = ?');
    const write = db.query('INSERT OR REPLACE INTO activity_plan (bot, data) VALUES (?, ?)');
    const jobs = new Map<string, { plan: Plan; cancel: AbortController; done: Promise<void> }>();
    const get = (bot: string): Plan | null => {
        const row = read.get(bot);
        return row ? JSON.parse(row.data) as Plan : null;
    };
    const save = (plan: Plan) => write.run(plan.bot, JSON.stringify(plan));
    const active = (bot: string) => jobs.has(bot.toLowerCase()) || get(bot)?.status === 'running';

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

    async function run(plan: Plan, signal: AbortSignal) {
        let backend: PlanBackend | undefined;
        let owned = false;
        try {
            backend = await backendFor(plan.bot, signal);
            signal.throwIfAborted();
            if (backend.status().task) throw new Error('Stop the current activity before running a plan.');
            await backend.prepare(signal);
            let state = await waitReady(backend, signal);
            let missingSince = 0;
            while (plan.index < plan.steps.length) {
                signal.throwIfAborted();
                const step = plan.steps[plan.index]!;
                let work: Work | null;
                try {
                    work = nextWork(step, state, plan.elapsedMs);
                    missingSince = 0;
                } catch (error) {
                    missingSince ||= Date.now();
                    if (Date.now() - missingSince > 20_000) throw error;
                    await Bun.sleep(interval);
                    state = await backend.observe() ?? state;
                    continue;
                }
                if (!work) {
                    plan.index++;
                    plan.elapsedMs = 0;
                    plan.work = undefined;
                    save(plan);
                    continue;
                }
                plan.work = work;
                save(plan);
                signal.throwIfAborted();
                await backend.start(work.task, work.finish.type === 'level' ? work.finish.skill : undefined);
                owned = true;
                let lastLive = Date.now();
                let previous = lastLive;
                let endedAt = 0;
                let missingFinishSince = 0;
                for (;;) {
                    signal.throwIfAborted();
                    await Bun.sleep(interval);
                    signal.throwIfAborted();
                    const snapshot = await backend.observe().catch(() => null);
                    signal.throwIfAborted();
                    const now = Date.now();
                    const status = backend.status();
                    if (!snapshot?.player) {
                        previous = now;
                        if (!status.client || now - lastLive > 25_000) throw new Error('The managed game client stopped publishing live state.');
                        continue;
                    }
                    state = snapshot;
                    lastLive = now;
                    if (status.task && !status.task.stopping && !work.inserted && work.finish.type === 'minutes') {
                        // Only charge intervals bounded by live game snapshots from this run.
                        plan.elapsedMs += Math.max(0, now - previous);
                        save(plan);
                    }
                    previous = now;
                    let done = false;
                    try {
                        done = finished(work, state, plan.elapsedMs);
                        missingFinishSince = 0;
                    } catch (error) {
                        missingFinishSince ||= now;
                        if (now - missingFinishSince > 20_000) throw error;
                    }
                    if (done && (work.finish.type !== 'complete' || !status.task)) break;
                    if (!status.task) {
                        const exit = status.lastTask;
                        if (work.finish.type === 'essence-exhausted' && exit?.name === work.task &&
                            exit.exitCode === 0 && exit.completion === 'essence-exhausted') {
                            plan.index++;
                            plan.elapsedMs = 0;
                            break;
                        }
                        if (exit?.name === work.task && exit.exitCode !== 0) {
                            throw new Error(`${activity(work.task).label} exited with code ${exit.exitCode}.`);
                        }
                        endedAt ||= now;
                        if (now - endedAt > 7500) {
                            throw new Error(`${activity(work.task).label} exited before the finish condition was verified.`);
                        }
                    }
                }
                if (backend.status().task) await backend.stop();
                owned = false;
                signal.throwIfAborted();
                plan.work = undefined;
                save(plan);
            }
            plan.status = 'complete';
            plan.message = undefined;
            save(plan);
        } catch (error) {
            if (owned && backend?.status().task) {
                try { await backend.stop(); }
                catch {
                    plan.status = 'blocked';
                    plan.message = 'The controller could not stop the active step. Check the running activity before resuming.';
                    save(plan);
                    return;
                }
            }
            plan.status = signal.aborted ? 'paused' : 'blocked';
            plan.message = signal.aborted ? undefined : error instanceof Error ? error.message : 'The plan stopped unexpectedly.';
            save(plan);
        }
    }

    function launch(plan: Plan) {
        const key = plan.bot.toLowerCase();
        const cancel = new AbortController();
        const done = run(plan, cancel.signal).finally(() => jobs.delete(key));
        jobs.set(key, { plan, cancel, done });
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
        save(plan);
        return launch(plan);
    }

    function queueMining(bot: string, next: Step) {
        const plan = jobs.get(bot.toLowerCase())?.plan;
        const step = plan?.steps[plan.index];
        if (!plan || plan.status !== 'running' || plan.index !== plan.steps.length - 1 || step?.task !== 'craft-body-runes') {
            throw new Error('Mining can be queued after the current final runecrafting step.');
        }
        if (plan.steps.length >= 12 || activity(next.task).category !== 'Mining') throw new Error('Choose a mining activity to queue.');
        const finish = { type: 'essence-exhausted' } as const;
        step.finish = finish;
        if (plan.work?.task === step.task) plan.work.finish = finish;
        plan.steps.push(next);
        save(plan);
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
        const rows = db.query<{ data: string }, []>('SELECT data FROM activity_plan').all();
        for (const { data } of rows) {
            const plan = JSON.parse(data) as Plan;
            if (plan.status === 'running' && !jobs.has(plan.bot.toLowerCase())) launch(plan);
        }
    }

    return { get, active, start, resume, pause, queueMining, restore, close: () => db.close() };
}

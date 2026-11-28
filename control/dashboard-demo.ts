import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createDashboardActivity, type ControllerStatus } from './dashboard-activity';
import { inventoryControls } from './dashboard-inventory';
import { dashboardClientFeed } from './dashboard-live-state';
import type { dashboardFleetStats } from './dashboard-fleet-stats';
import { botCredentials, hostedBotState, isFreshBotState } from './hosted-bot';
import type { BotProfile } from './dashboard-roster';
import { auditPrefix } from '../sdk/audit-trace';
import type { DashboardAudit } from './dashboard-audit';
import type { MonitorProcess } from './dashboard-monitor';
import { taskActivityLabel } from './dashboard-task-activity';
import { activity, activityIds, isActivity, type ActivityId, type ActivityOptions } from './dashboard-task-catalog';
import { taskEnvironment, type DashboardWorkerUpdates, type WorkerRelease } from './dashboard-worker-policy';
import { taskUpdateChannel } from './dashboard-task-update';
import { isSafeTaskUpdateState } from './task-update-safety';
import type { BotWorldState } from '../sdk/types';
import type { MeleeGoal } from './melee-training';
import type { Step } from './dashboard-plan';
import type { RuntimeGroup } from './dashboard-runtime-groups';
import type { DashboardRuntimePools, RuntimeProcess, RuntimeTaskProcess } from './dashboard-runtime-pools';

const taskName = 'pickpocket-men';
export const isBundledTask = isActivity;
type DemoTaskName = ActivityId;
const activityLabels: Record<string, string> = {
    'training-hitpoints': 'Training Hitpoints to 60',
    'hitpoints-goal-reached': 'Preparing to pickpocket',
    'travelling-to-ardougne': 'Travelling to East Ardougne',
};
const targetLabels: Record<string, string> = {
    Guard: 'Pickpocketing Guards',
    'Knight of Ardougne': 'Pickpocketing Ardougne Knights',
    Paladin: 'Pickpocketing Paladins',
    Hero: 'Pickpocketing Heroes',
};
const digest = (value: string) => createHash('sha256').update(value).digest();
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

type Process = { bot: string; process: RuntimeProcess; startedAt: string; stopping?: boolean };
type ManagedClient = Process & {
    inventory: ReturnType<typeof inventoryControls>;
    feed: ReturnType<typeof dashboardClientFeed>;
    settled?: Promise<void>;
};
type Event = { id: number; at: string; stage: string; [key: string]: unknown };
type Exit = { at: string; exitCode: number };
type Task = Process & {
    auditId?: string;
    name: DemoTaskName;
    activity: string;
    recovery?: { since: string; resumeAt: number };
    finishedScript?: boolean;
    completion?: NonNullable<ControllerStatus['lastTask']>['completion'];
    bankTarget?: number;
    settled?: Promise<void>;
    runId: string;
    revision?: string;
    script: string;
    update: ReturnType<typeof taskUpdateChannel>;
    standalone?: Step;
    skill?: string;
    release?: WorkerRelease;
};

async function stopProcess(handle: Process | undefined, signal: 'SIGINT' | 'SIGTERM') {
    if (!handle || handle.process.exitCode !== null) return;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (!handle.stopping || handle.process.groupId) {
        handle.stopping = true;
        handle.process.kill(signal);
        escalation = setTimeout(() => handle.process.kill('SIGKILL'), 4000);
    }
    try {
        if (handle.process.groupId) {
            await Promise.race([handle.process.exited, new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error('The runtime group did not confirm this bot stopped.')), 8000);
            })]);
        } else {
            await handle.process.exited;
        }
    } finally {
        clearTimeout(escalation);
        clearTimeout(timeout);
    }
}

export type DashboardPathfinding = {
    socket: string;
    ensureReady(): Promise<void>;
    monitoredProcess?(): MonitorProcess | null;
};

export type DashboardRuntimePlacement = {
    pools: DashboardRuntimePools;
    assignment(bot: string): RuntimeGroup | null;
};

export function dashboardDemo(runtimeDir: string, botsDir: string, configDir: string, token: string,
    recordBank: ReturnType<typeof dashboardFleetStats>['recordBank'], roster?: BotProfile, audit?: DashboardAudit, revision?: string,
    pathfinding?: DashboardPathfinding, updates?: DashboardWorkerUpdates, runtime?: DashboardRuntimePlacement) {
    const writableDir = roster ? join(runtimeDir, 'managed-bots', roster.name) : join(runtimeDir, 'pickpocket-demo');
    const workingDir = roster?.directory ?? writableDir;
    const envFile = join(workingDir, 'bot.env');
    const webclient = join(import.meta.dir, '../server/webclient');
    const dependencies = join(dirname(botsDir), 'server/webclient/node_modules');
    const ownerKey = digest(`Bearer ${token}`);
    const delegatedKey = Bun.file(join(configDir, 'caller.sha256'));
    const events: Event[] = [];
    const monitorEvents: Array<{ at: number; bot: string; label: string }> = [];
    let nextEventId = 1;
    let client: ManagedClient | undefined;
    let task: Task | undefined;
    let clientExit: Exit | null = null;
    let taskExit: (Exit & { name: DemoTaskName; completion?: Task['completion']; updateId?: string }) | null = null;
    let busy = false;
    let taskStopped = false;
    let startingPlanTask = false;
    let standaloneUpdate: { runId: string; switching: boolean; cancelled: boolean; runtimeMove: boolean } | undefined;
    let clientEpoch = 0;
    let offlining: Promise<void> | undefined;

    function event(stage: string, data: Record<string, unknown> = {}) {
        events.push({ ...data, stage, id: nextEventId++, at: new Date().toISOString() });
        if (events.length > 200) events.shift();
    }

    async function consumeTaskEvents(stream: ReadableStream<Uint8Array>, running: Task) {
        const prefix = '[pickpocket-demo] ';
        let buffer = '';
        const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const lines = (buffer + value).split('\n');
            buffer = (lines.pop() ?? '').slice(0, 32_768);
            for (const line of lines) {
                if (line.startsWith(auditPrefix)) {
                    if (running.auditId) {
                        try {
                            const entry = JSON.parse(line.slice(auditPrefix.length));
                            if (entry.kind === 'milestone' && entry.name === 'script-finish' && entry.outcome === 'complete') {
                                running.finishedScript = true;
                            }
                            if (running.name === 'craft-body-runes' && entry.kind === 'milestone' &&
                                entry.name === 'runecraft-essence-exhausted' && entry.essence === 0 && entry.bankEssence === 0) {
                                running.completion = 'essence-exhausted';
                            }
                            if (running.bankTarget !== undefined && entry.kind === 'milestone' &&
                                entry.name === 'mining-bank-target-confirmed' && entry.target === running.bankTarget &&
                                Number.isSafeInteger(entry.banked) && entry.banked >= running.bankTarget) {
                                running.completion = 'bank-stock';
                            }
                            const label = taskActivityLabel(entry);
                            if (label && monitorEvents.at(-1)?.label !== label) {
                                monitorEvents.push({ at: Date.now(), bot: running.bot, label });
                                if (monitorEvents.length > 1200) monitorEvents.shift();
                            }
                            audit?.append(running.auditId, entry);
                        }
                        catch { /* Malformed task output cannot interrupt its stream. */ }
                    }
                    continue;
                }
                if (!line.startsWith(prefix)) continue;
                try {
                    const { stage, ...fields } = JSON.parse(line.slice(prefix.length));
                    if (typeof stage !== 'string' || !/^[a-z-]+$/.test(stage)) continue;
                    const label = stage === 'pickpocket-target' && typeof fields.npc === 'string'
                        ? targetLabels[fields.npc] : activityLabels[stage];
                    if (label) running.activity = label;
                    if (stage === 'recovering') {
                        const resumeAt = typeof fields.minimum === 'number' ? fields.minimum : 6;
                        running.recovery = { since: new Date().toISOString(), resumeAt };
                    } else if (stage === 'recovered') {
                        running.recovery = undefined;
                    }
                    event(stage, fields);
                    if (running.auditId) {
                        const kind = stage === 'quest-failed' ? 'failure'
                            : stage === 'quest-complete' || stage === 'quest-ingredient' ? 'milestone' : 'task-event';
                        // Keep the audit whitelist narrow. SDK action and snapshot
                        // events already contain the matching structured state.
                        const { error, reason, item, npc, success, hp, quest, count } = fields;
                        audit?.append(running.auditId, { kind, name: stage, error, reason, item, npc, success, hp, quest, count });
                    }
                } catch { /* Only the bundled task's structured messages are returned. */ }
            }
        }
    }

    async function consumeTaskErrors(stream: ReadableStream<Uint8Array>) {
        let buffer = '';
        let message: string | undefined;
        const stack: string[] = [];
        const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            process.stderr.write(value);
            const lines = (buffer + value).split('\n');
            buffer = (lines.pop() ?? '').slice(0, 2048);
            for (const line of lines) {
                if (!message && /^(?:error:|(?:Syntax|Type|Reference|Range)Error:)/i.test(line.trim())) message = line.trim();
                if (stack.length < 6 && /^\s+at\s/.test(line)) stack.push(line);
            }
        }
        return { message, stack };
    }

    async function allowed(request: Request) {
        const offered = request.headers.get('Authorization') ?? '';
        if (!/^Bearer [a-f0-9]{64}$/.test(offered)) return false;
        const key = digest(offered);
        if (timingSafeEqual(key, ownerKey)) return true;
        const delegated = await delegatedKey.text().catch(() => '');
        return /^[a-f0-9]{64}$/.test(delegated.trim()) && timingSafeEqual(key, Buffer.from(delegated.trim(), 'hex'));
    }

    async function storedBot() {
        if (!await Bun.file(envFile).exists()) return null;
        if (roster) return roster.name;
        const name = /^BOT_USERNAME=(Lumb[a-f0-9]{7})$/m.exec(await Bun.file(envFile).text())?.[1];
        if (!name) throw new Error('Invalid demo bot configuration');
        return name;
    }

    async function provisionBot() {
        const existing = await storedBot();
        if (existing) return existing;
        if (roster) throw new Error('The bot profile is missing');
        const name = 'Lumb' + randomBytes(4).toString('hex').slice(0, 7);
        const password = randomBytes(6).toString('hex');
        await mkdir(workingDir, { recursive: true, mode: 0o700 });
        await writeFile(envFile, `BOT_USERNAME=${name}\nPASSWORD=${password}\nSERVER=rs-sdk.maxbittker.com\nSHOW_CHAT=false\n`, {
            mode: 0o600, flag: 'wx',
        });
        event('provisioned', { bot: name });
        return name;
    }

    async function stopTask() {
        const stopping = task;
        if (!stopping) return;
        await stopProcess(stopping, 'SIGTERM');
        await stopping.settled;
    }

    function startClient(bot: string, group = runtime?.assignment(bot) ?? null) {
        const inventory = inventoryControls();
        const feed = dashboardClientFeed((items, at) => recordBank(bot, items, at));
        const receive = (message: unknown) => {
            inventory.receive(message);
            feed.receive(message);
        };
        const cacheDir = join(writableDir, 'cache');
        const child = group && runtime ? runtime.pools.startLite(group, { bot, envFile, cacheDir, receive })
            : Bun.spawn([process.execPath, '--no-env-file', join(webclient, 'src/lite/runner.ts'), bot], {
            cwd: webclient,
            stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
            ipc: receive,
            env: {
                ...process.env, GATEWAY_DIRECT: 'false', NODE_PATH: dependencies, RS_LITE_BOT_ENV: envFile,
                RS_LITE_CACHE_DIR: cacheDir,
            },
        });
        const running: ManagedClient = { bot, process: child, startedAt: new Date().toISOString(), inventory, feed };
        client = running;
        clientExit = null;
        event('client-started', { bot, pid: child.pid });
        running.settled = child.exited.then(async exitCode => {
            inventory.disconnect();
            clientExit = { exitCode, at: new Date().toISOString() };
            event('client-exited', { exitCode });
            try { if (client === running) await stopTask(); }
            finally { if (client === running) client = undefined; }
        }).catch(() => { event('client-observer-failed'); });
        return running;
    }

    function takeOffline() {
        if (offlining) return offlining;
        clientEpoch++;
        if (standaloneUpdate) {
            standaloneUpdate.cancelled = true;
            task?.update.cancel();
        }
        if (task) taskStopped = true;
        // Publish the barrier before waiting for the asynchronous start job.
        // Its launch checks can then abort without waiting for this operation.
        offlining = Promise.resolve().then(async () => {
            await actions.cancelStart();
            const stopping = client;
            try { await stopTask(); }
            finally {
                await stopProcess(stopping, 'SIGINT');
                await stopping?.settled;
            }
        }).finally(() => { offlining = undefined; });
        return offlining;
    }

    function requireCurrentClient(active: ManagedClient | undefined, epoch: number): asserts active is ManagedClient {
        if (!active || client !== active || active.stopping || active.process.exitCode !== null || offlining || epoch !== clientEpoch) {
            throw new Error('The managed client stopped before the activity could start.');
        }
    }

    async function clientForTask(bot: string, active: ManagedClient, group: RuntimeGroup | null, epoch: number,
        checkLaunch?: () => void, followAssignment = false) {
        requireCurrentClient(active, epoch);
        while ((active.process.groupId ?? null) !== (group?.id ?? null)) {
            if (task) throw new Error('The current activity has not stopped yet.');
            await stopProcess(active, 'SIGINT');
            await active.settled;
            checkLaunch?.();
            if (offlining || epoch !== clientEpoch || client || task) {
                throw new Error('The managed client changed while moving to its runtime group.');
            }
            if (followAssignment) group = runtime?.assignment(bot) ?? null;
            active = startClient(bot, group);
            const deadline = Date.now() + 75_000;
            let tick: number | undefined;
            for (;;) {
                checkLaunch?.();
                requireCurrentClient(active, epoch);
                if (followAssignment) {
                    group = runtime?.assignment(bot) ?? null;
                    if ((active.process.groupId ?? null) !== (group?.id ?? null)) break;
                }
                const frame = active.feed.state();
                if (frame?.state.inGame && frame.state.player && isFreshBotState(Date.now() - frame.at)) {
                    if (tick !== undefined && frame.state.tick !== tick) return active;
                    tick = frame.state.tick;
                }
                if (Date.now() >= deadline) {
                    await stopProcess(active, 'SIGINT');
                    await active.settled;
                    throw new Error('The new runtime group did not publish a live game session.');
                }
                await Bun.sleep(250);
            }
        }
        return active;
    }

    async function startTask(bot: string, name: DemoTaskName, {
        planned = false, skill, bankTarget, meleeGoal, options, release, checkLaunch, followAssignment = false,
    }: {
        planned?: boolean; skill?: string; bankTarget?: number; meleeGoal?: MeleeGoal; options?: ActivityOptions;
        release?: WorkerRelease; checkLaunch?: () => void; followAssignment?: boolean;
    }) {
        const activeClient = client;
        const epoch = clientEpoch;
        await pathfinding?.ensureReady();
        const credentials = await botCredentials(bot, workingDir);
        const selected = release ?? await updates?.load();
        const definition = (selected?.value.activity ?? activity)(name);
        const pinned = await updates?.pinTask(selected?.revision, definition.script);
        const script = pinned?.path ?? join(import.meta.dir, 'tasks', definition.script);
        let auditId: string | undefined;
        let child: RuntimeTaskProcess;
        const launchRevision = pinned?.revision ?? selected?.revision ?? revision;
        const update = taskUpdateChannel(command => child.send(command));
        try {
            const scriptSha = pinned?.sha ?? (audit ? await Bun.file(script).arrayBuffer()
                .then(bytes => createHash('sha256').update(new Uint8Array(bytes)).digest('hex')).catch(() => null) : null);
            checkLaunch?.();
            let group = runtime?.assignment(bot) ?? null;
            requireCurrentClient(activeClient, epoch);
            let placedClient = activeClient;
            do {
                placedClient = await clientForTask(bot, placedClient, group, epoch, checkLaunch, followAssignment);
                checkLaunch?.();
                requireCurrentClient(placedClient, epoch);
                if (followAssignment) group = runtime?.assignment(bot) ?? null;
            } while ((placedClient.process.groupId ?? null) !== (group?.id ?? null));
            auditId = audit?.begin(bot, name, launchRevision ?? null, scriptSha, [credentials.password, token]);
            const activityEnv = (selected?.value.taskEnvironment ?? taskEnvironment)(skill, bankTarget, options, meleeGoal);
            const env = {
                ...process.env, ...activityEnv, BOT_USERNAME: credentials.username, PASSWORD: credentials.password,
                SERVER: 'rs-sdk.maxbittker.com', SHOW_CHAT: 'false', GATEWAY_DIRECT: 'false',
                ...(pathfinding && { RS_PATHFINDING_SOCKET: pathfinding.socket }),
                RS_ACTIVITY: name, RS_ACTIVITY_AUDIT: auditId ? '1' : '0', RS_PLANNED: planned ? '1' : '0',
            };
            child = group?.mode === 'client-and-task' && runtime
                ? runtime.pools.startSdk(group, { bot, script, cwd: writableDir, env, receive: update.receive })
                : Bun.spawn([process.execPath, '--no-env-file', script], {
                cwd: writableDir,
                stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
                ipc: update.receive,
                env,
            });
        } catch (error) {
            await pinned?.release().catch(() => { event('task-release-cleanup-failed'); });
            if (auditId) {
                audit?.append(auditId, { kind: 'failure', name: 'spawn', message: error instanceof Error ? error.message : String(error) });
                audit?.finish(auditId, 1, false);
            }
            throw error;
        }
        const running: Task = {
            bot, auditId, process: child, startedAt: new Date().toISOString(), name, activity: definition.label, bankTarget, skill, release: selected,
            runId: auditId ?? randomUUID(), revision: launchRevision, script: definition.script, update,
            standalone: planned ? undefined : {
                task: name, finish: { type: definition.usage === 'once' ? 'complete' : 'forever' },
                requirements: [], options, configurationVersion: definition.settingsVersion ?? 1,
            },
        };
        task = running;
        taskExit = null;
        taskStopped = false;
        const launchDetails = { pid: child.pid, ...(pathfinding && { pathfinding: 'shared' }) };
        event('task-started', { task: name, ...launchDetails });
        if (auditId) audit?.append(auditId, { kind: 'worker', name: 'task-started', ...launchDetails, planned, skill, options });
        const readEvents = consumeTaskEvents(child.stdout, running).catch(() => { event('task-event-reader-failed'); });
        const readErrors = child.stderr && consumeTaskErrors(child.stderr).catch(() => { event('task-error-reader-failed'); });
        running.settled = child.exited.then(async exitCode => {
            const errorOutput = await readErrors;
            await readEvents;
            const checkpoint = running.update.state().checkpoint;
            const updateId = exitCode === 0 && checkpoint?.phase === 'accepted' ? checkpoint.id : undefined;
            taskExit = { name, exitCode, at: new Date().toISOString(), completion: running.completion, updateId };
            if (task === running) task = undefined;
            event('task-exited', { exitCode });
            if (auditId) {
                if (exitCode !== 0 && errorOutput?.message) audit?.append(auditId, { kind: 'failure', name: 'runtime-stderr', ...errorOutput });
                audit?.append(auditId, { kind: 'worker', name: 'task-exited', exitCode, stopped: running.stopping, updateId });
                audit?.finish(auditId, exitCode, !!running.stopping || !!updateId);
            }
        }).catch(() => { event('task-observer-failed'); }).finally(async () => {
            await pinned?.release().catch(() => { event('task-release-cleanup-failed'); });
        });
    }

    async function state(bot: string | null, allowUnregistered = false) {
        const sample = bot && await hostedBotState(bot, workingDir, allowUnregistered);
        if (!sample || !sample.state?.inGame || !sample.state.player || sample.botStatus === 'dead') {
            return { bot, availability: 'offline' as const };
        }
        const { player, skills, nearbyNpcs, inventory, gameMessages, opFeedback, tick, revision } = sample.state;
        return {
            bot, availability: sample.botStatus !== 'stale' && isFreshBotState(sample.stateAge) ? 'live' as const : 'stale' as const,
            stateAgeMs: sample.stateAge, tick, revision,
            player: { x: player.worldX, z: player.worldZ, plane: player.level, hp: player.hp, maxHp: player.maxHp, dead: player.isDead },
            thieving: skills.find(skill => skill.name === 'Thieving') ?? null,
            hitpoints: skills.find(skill => skill.name === 'Hitpoints') ?? null,
            melee: skills.filter(skill => /^(Attack|Strength|Defence)$/.test(skill.name)),
            targets: nearbyNpcs.filter(npc => /^(Chicken|Cow(?: Calf)?|Guard|Knight of Ardougne|Paladin|Hero)$/i.test(npc.name))
                .slice(0, 12).map(({ name, index, x, z, distance, reachable, inCombat }) =>
                    ({ name, index, x, z, distance, reachable, inCombat })),
            coins: inventory.filter(item => item.id === 995).reduce((count, item) => count + item.count, 0),
            men: nearbyNpcs.filter(npc => /^man$/i.test(npc.name)).slice(0, 12).map(npc => ({
                index: npc.index, x: npc.x, z: npc.z, distance: npc.distance,
                reachable: npc.reachable, options: npc.optionsWithIndex,
            })),
            feedback: gameMessages.filter(message => message.type === 0 &&
                /pick.*pocket|man's pocket|caught|stunned|reach that/i.test(message.text))
                .slice(-12).map(({ tick, text }) => ({ tick, text })),
            opFeedback,
        };
    }

    function status(bot: string | null): ControllerStatus {
        return {
            bot, tasks: updates?.current().activityIds ?? activityIds,
            client: client ? { startedAt: client.startedAt, stopping: Boolean(client.stopping) } : null,
            task: task ? { name: task.name, startedAt: task.startedAt, stopping: Boolean(task.stopping), activity: task.activity, recovery: task.recovery } : null,
            lastTask: taskExit && !taskStopped ? { name: taskExit.name, exitCode: taskExit.exitCode,
                finishedAt: taskExit.at, completion: taskExit.completion, updateId: taskExit.updateId } : null,
        };
    }

    async function handle(request: Request, route: string, forDashboard = false) {
        const reading = route === 'status' || route === 'state' || route === 'events';
        if (!reading && !['client/start', 'client/stop', 'task/start', 'task/stop'].includes(route)) {
            return json({ error: 'Unknown demo route' }, 404);
        }
        if (!await allowed(request)) return json({ error: 'Unauthorized' }, 401);
        const method = reading ? 'GET' : 'POST';
        if (request.method !== method) return new Response(null, { status: 405, headers: { Allow: method } });
        if (reading) {
            try {
                const bot = await storedBot();
                if (route === 'events') return json({ bot, events });
                if (route === 'state') return json(await state(bot));
                const current = status(bot);
                if (forDashboard) return json(current);
                return json({
                    ...current, taskName,
                    client: client ? { ...current.client, pid: client.process.pid } : null,
                    task: task ? { ...current.task, pid: task.process.pid } : null,
                    clientExit, taskExit,
                });
            } catch {
                return json({ error: 'Demo credentials or game gateway state are unavailable' }, 503);
            }
        }
        const stoppingRuntimeMove = standaloneUpdate?.runtimeMove && (route === 'client/stop' || route === 'task/stop');
        if (busy || startingPlanTask || (standaloneUpdate?.switching && !stoppingRuntimeMove)) return json({ error: 'Another demo command is in progress' }, 409);
        busy = true;
        try {
            if (route === 'client/start') {
                if (client || task || offlining) return json({ error: 'The demo client or task is already running' }, 409);
                const epoch = clientEpoch;
                const bot = await provisionBot();
                await botCredentials(bot, workingDir);
                if (roster && (await state(bot, roster.created)).availability === 'live') {
                    return json({ error: 'This bot already has a live game client outside Fleet desk.' }, 409);
                }
                await mkdir(writableDir, { recursive: true, mode: 0o700 });
                if (offlining || epoch !== clientEpoch) return json({ error: 'The bot is being taken offline.' }, 409);
                startClient(bot);
                return json({ bot, phase: 'starting' }, 202);
            }
            if (route === 'task/start') {
                const body = await request.json().catch(() => null);
                const name = body?.task;
                const release = await updates?.load();
                if (!(release?.value.isActivity ?? isBundledTask)(name)) {
                    return json({ error: 'Unknown demo task' }, 400);
                }
                const bot = await storedBot();
                const activeClient = client;
                if (!bot || !activeClient || task || (await state(bot)).availability !== 'live' ||
                    client !== activeClient || activeClient.stopping || activeClient.process.exitCode !== null) {
                    return json({ error: 'Start the demo client and wait for live state before starting a task' }, 409);
                }
                await startTask(bot, name, { release });
                return json({ bot, task: name, phase: 'starting' }, 202);
            }
            if (route === 'client/stop') {
                await takeOffline();
                return json({ ok: true });
            }
            if (standaloneUpdate) {
                standaloneUpdate.cancelled = true;
                task?.update.cancel();
            }
            if (task) taskStopped = true;
            await stopTask();
            return json({ ok: true });
        } catch {
            event('command-failed', { route });
            return json({ error: 'Demo command failed on the host' }, 503);
        } finally {
            busy = false;
        }
    }

    async function planCommand(bot: string, route: 'client/start' | 'task/stop', allowOffline = false) {
        if (allowOffline && !client) return;
        const request = new Request('http://127.0.0.1/' + route, {
            headers: { Authorization: `Bearer ${token}` }, method: 'POST',
        });
        const response = await handle(request, route, true);
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error ?? `Control command for ${bot} failed.`);
        }
    }

    const taskUpdateInfo = (running: Task) => ({
        runId: running.runId, revision: running.revision, script: running.script, ...running.update.state(),
    });

    function standaloneActivity() {
        if (!task?.standalone || task.stopping) return;
        return {
            bot: task.bot, step: task.standalone, running: taskUpdateInfo(task),
            waiting: standaloneUpdate?.runId === task.runId,
        };
    }

    function cancelStandaloneUpdate(runId: string) {
        const pending = standaloneUpdate;
        if (!pending || pending.runId !== runId || pending.switching) throw new Error('This update can no longer be cancelled.');
        pending.cancelled = true;
        task?.update.cancel();
    }

    async function requestStandaloneUpdate(runId: string, release: WorkerRelease, mode: 'safe' | 'now') {
        const running = task;
        const activeClient = client;
        if (!running?.standalone || running.runId !== runId || !activeClient || busy || standaloneUpdate) {
            throw new Error('The running activity changed. Reload updates before retrying.');
        }
        const compatibility = release.value.checkStepCompatibility(running.standalone);
        if (compatibility.status === 'review') throw new Error(compatibility.reason);
        if (mode === 'safe' && !running.update.state().supported) throw new Error('This run does not provide safe checkpoints.');
        if (mode === 'now' && !await safeForStandaloneUpdate(running)) {
            throw new Error('Wait for fresh game state outside combat with enough health and all game windows closed.');
        }
        if (task !== running || client !== activeClient || busy || standaloneUpdate) throw new Error('The running activity changed.');
        scheduleStandaloneSwitch(running, activeClient, mode, compatibility.step.options, release);
    }

    async function safeForStandaloneUpdate(running: Task) {
        const sample = await hostedBotState(running.bot, workingDir);
        return sample?.botStatus !== 'dead' && sample?.botStatus !== 'stale' &&
            isSafeTaskUpdateState(sample?.state, sample?.stateAge ?? Infinity);
    }

    function requestStandaloneRelaunch(runId: string, mode: 'safe' | 'immediate', stillAssigned: () => boolean): 'queued' | 'relaunching' | 'next-launch' {
        const running = task;
        if (!running?.standalone || running.runId !== runId || !client || running.process.exitCode !== null ||
            running.stopping || running.finishedScript || running.completion || busy || offlining || startingPlanTask || !stillAssigned()) return 'next-launch';
        if (standaloneUpdate) {
            if (standaloneUpdate.runId !== runId || !standaloneUpdate.runtimeMove || standaloneUpdate.switching) return 'next-launch';
            standaloneUpdate.cancelled = true;
            running.update.cancel();
            standaloneUpdate = undefined;
        }
        if (mode === 'safe' && !running.update.state().supported) return 'next-launch';
        scheduleStandaloneSwitch(running, client, mode === 'safe' ? 'safe' : 'now', running.standalone.options, running.release, stillAssigned);
        return mode === 'safe' ? 'queued' : 'relaunching';
    }

    function scheduleStandaloneSwitch(running: Task, activeClient: ManagedClient, mode: 'safe' | 'now',
        options: ActivityOptions | undefined, release: WorkerRelease | undefined, stillAssigned?: () => boolean) {
        const pending = standaloneUpdate = { runId: running.runId, switching: mode === 'now', cancelled: false, runtimeMove: !!stillAssigned };
        const stillWanted = () => !pending.cancelled && !offlining;
        const checkLaunch = () => {
            if (!stillWanted() || busy || startingPlanTask || task) throw new Error('The requested task relaunch was superseded.');
        };
        void (async () => {
            let attempt: string | undefined;
            if (mode === 'now') {
                await stopTask();
                // A task may flush its completion evidence while stopping. A
                // SIGTERM handler is also allowed to exit cleanly, so exit code
                // zero alone cannot distinguish the two.
                if (stillAssigned && (running.finishedScript || running.completion)) return;
            } else {
                while (stillWanted() && client === activeClient) {
                    if (task !== running) {
                        if (!attempt || taskExit?.updateId !== attempt) return;
                        break;
                    }
                    const checkpoint = running.update.state().checkpoint;
                    // A live assignment may be replaced until the script commits
                    // to exit. After that boundary this operation owns the replay.
                    if (stillAssigned && !stillAssigned() && checkpoint?.phase !== 'committed' &&
                        checkpoint?.phase !== 'accepted') return;
                    if (!checkpoint) {
                        const id = randomUUID();
                        if (running.update.request(id)) attempt = id;
                        pending.switching = false;
                    } else if (checkpoint.phase === 'ready' &&
                        await safeForStandaloneUpdate(running).catch(() => false) &&
                        stillWanted() && (!stillAssigned || stillAssigned()) && task === running && running.process.exitCode === null) {
                        pending.switching = true;
                        running.update.commit(checkpoint.id);
                    }
                    await Bun.sleep(500);
                }
            }
            if (!stillWanted() || client !== activeClient || task || busy || startingPlanTask) return;
            pending.switching = true;
            await startTask(running.bot, running.name, { skill: running.skill, bankTarget: running.bankTarget,
                options, release, checkLaunch, followAssignment: !!stillAssigned });
        })().catch(error => {
            if (stillWanted()) event(stillAssigned ? 'runtime-relaunch-failed' : 'task-update-failed', {
                message: error instanceof Error ? error.message : String(error),
            });
        }).finally(() => {
            if (standaloneUpdate === pending) {
                running.update.cancel();
                standaloneUpdate = undefined;
            }
        });
    }

    function planBackend(bot: string) {
        let observation: { state: BotWorldState; at: number } | undefined;
        return {
            status: () => status(bot),
            async prepare(signal: AbortSignal) {
                for (let attempt = 0; !client; attempt++) {
                    signal.throwIfAborted();
                    try { await planCommand(bot, 'client/start'); }
                    catch (error) {
                        // A service reload can leave one last fresh gateway sample.
                        if (attempt >= 3 || !(error instanceof Error) || !error.message.includes('outside Fleet desk')) throw error;
                        await Bun.sleep(4000);
                    }
                }
            },
            async observe() {
                const sample = await hostedBotState(bot, workingDir);
                if (!client || client.stopping || client.process.exitCode !== null || !sample?.state?.inGame ||
                    sample.botStatus === 'dead' || sample.botStatus === 'stale' || !isFreshBotState(sample.stateAge)) {
                    observation = undefined;
                    return null;
                }
                observation = { state: sample.state, at: Date.now() - sample.stateAge };
                return sample.state;
            },
            async start(name: ActivityId, skill?: string, bankTarget?: number, options?: ActivityOptions, release?: WorkerRelease, meleeGoal?: MeleeGoal) {
                if (!client || task || busy || startingPlanTask) throw new Error('The managed client is busy.');
                if (standaloneUpdate?.runtimeMove) standaloneUpdate.cancelled = true;
                startingPlanTask = true;
                try { await startTask(bot, name, { planned: true, skill, bankTarget, meleeGoal, options, release, followAssignment: true }); }
                finally { startingPlanTask = false; }
            },
            stop: () => planCommand(bot, 'task/stop', true),
            async stopForRuntimeMove(runId: string) {
                const running = task;
                if (!running || running.runId !== runId || running.standalone || taskStopped || offlining || running.stopping) {
                    return false;
                }
                // An internal placement change must preserve the real exit and
                // any final bank/essence proof flushed by this exact run. The
                // ordinary operator Stop path intentionally masks lastTask.
                if (!running.completion && !running.finishedScript) await stopProcess(running, 'SIGTERM');
                await running.settled;
                return true;
            },
            activeUpdate: () => task && !task.stopping ? taskUpdateInfo(task) : undefined,
            safeForUpdate: () => observation ? isSafeTaskUpdateState(observation.state, Date.now() - observation.at) : false,
            requestCheckpoint: (runId: string, id: string) => task?.runId === runId && task.update.request(id),
            commitCheckpoint: (runId: string, id: string) => { if (task?.runId === runId) task.update.commit(id); },
            cancelCheckpoint: (runId: string) => { if (task?.runId === runId) task.update.cancel(); },
        };
    }

    async function profile() {
        const name = await storedBot();
        return name ? {
            name,
            directory: workingDir,
            activity: task?.process.exitCode === null ? task.activity : undefined,
        } : null;
    }

    function recentEvents() {
        return events.slice(-20).reverse().map(entry => {
            const { at, stage } = entry;
            let message = stage.replaceAll('-', ' ');
            const hp = typeof entry.hp === 'number' ? ` at ${entry.hp} HP` : '';
            if (stage === 'recovering') {
                const target = typeof entry.minimum === 'number' ? entry.minimum : 6;
                message = `Waiting for HP recovery${hp}. Resume at ${target} HP.`;
            } else if (stage === 'recovered') {
                message = `HP recovered${hp}`;
            } else if (stage === 'pickpocket' && typeof entry.npc === 'string') {
                const outcome = entry.success === true ? 'success'
                    : typeof entry.reason === 'string' ? entry.reason : 'failed';
                message = `Pickpocket ${entry.npc} · ${outcome}${hp}`;
            } else if (stage === 'food-restock' && typeof entry.item === 'string' && typeof entry.bought === 'number') {
                message = `Bought ${entry.bought} × ${entry.item}`;
            } else if (stage === 'quest-failed' && typeof entry.error === 'string') {
                message = 'Quest stopped · ' + entry.error.slice(0, 320);
            } else if (stage === 'quest-ingredient' && typeof entry.item === 'string') {
                message = 'Collected ' + entry.item;
            } else if (stage.endsWith('-exited') && typeof entry.exitCode === 'number') {
                message += ` · code ${entry.exitCode}`;
            }
            return { at, message };
        });
    }

    const actions = createDashboardActivity((path, authorization, payload, signal) =>
        handle(new Request('http://127.0.0.1' + path, {
            headers: { Authorization: authorization },
            method: payload ? 'POST' : 'GET',
            body: payload && JSON.stringify(payload),
            signal,
        }), path.slice('/v1/'.length), true));

    function inventoryClient() {
        return client && !client.stopping && client.inventory.available() ? client : undefined;
    }

    function fleetState() {
        return client && !client.stopping && client.process.exitCode === null ? client.feed.state() : undefined;
    }

    function monitoredProcesses(): MonitorProcess[] {
        const handles = [['client', client], ['task', task]] as const;
        return handles.flatMap(([kind, handle]) => handle?.process.exitCode === null
            && !handle.process.groupId
            ? [{ kind, bot: handle.bot, pid: handle.process.pid, startedAt: handle.startedAt }]
            : []);
    }

    function monitorTimeline(since: number) {
        return monitorEvents.filter(event => event.at >= since);
    }

    return {
        handle, profile, status, allowed, recentEvents, planBackend, inventoryClient, fleetState,
        runtimeTaskGroupId: () => task?.process.exitCode === null ? task.process.groupId ?? null : undefined,
        activeGroupId: () => client?.process.exitCode === null ? client.process.groupId ?? null : null,
        takeOffline,
        monitoredProcesses, monitorTimeline, standaloneActivity, requestStandaloneRelaunch, requestStandaloneUpdate, cancelStandaloneUpdate, ...actions,
    };
}

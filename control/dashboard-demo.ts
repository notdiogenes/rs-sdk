import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createDashboardActivity, type ControllerStatus } from './dashboard-activity';
import { botCredentials, hostedBotState, isFreshBotState } from './hosted-bot';

const taskName = 'pickpocket-men';
const taskLabels = {
    'train-cows': 'Training melee on cows',
    'pickpocket-men': 'Pickpocketing Men',
    'train-hp-pickpocket': 'Training Hitpoints to 60',
} as const;
type DemoTaskName = keyof typeof taskLabels;
const activityLabels: Record<string, string> = {
    'training-hitpoints': 'Training Hitpoints to 60',
    'hitpoints-goal-reached': 'Preparing to pickpocket',
    'travelling-to-ardougne': 'Travelling to East Ardougne',
};
const targetLabels: Record<string, string> = {
    Guard: 'Pickpocketing Guards',
    'Knight of Ardougne': 'Pickpocketing Ardougne Knights',
    Hero: 'Pickpocketing Heroes',
};
const digest = (value: string) => createHash('sha256').update(value).digest();
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

type Process = { process: Bun.Subprocess; startedAt: string; stopping?: boolean };
type Event = { id: number; at: string; stage: string; [key: string]: unknown };
type Exit = { at: string; exitCode: number };
type RosterProfile = { name: string; directory: string };
type Task = Process & { name: DemoTaskName; activity: string; recovery?: { since: string; resumeAt: number } };

async function stopProcess(handle: Process | undefined, signal: 'SIGINT' | 'SIGTERM') {
    if (!handle || handle.process.exitCode !== null) return;
    handle.stopping = true;
    handle.process.kill(signal);
    const deadline = setTimeout(() => handle.process.kill('SIGKILL'), 4000);
    try { await handle.process.exited; } finally { clearTimeout(deadline); }
}

export function dashboardDemo(runtimeDir: string, botsDir: string, configDir: string, token: string, roster?: RosterProfile) {
    const writableDir = roster ? join(runtimeDir, 'managed-bots', roster.name) : join(runtimeDir, 'pickpocket-demo');
    const workingDir = roster?.directory ?? writableDir;
    const envFile = join(workingDir, 'bot.env');
    const webclient = join(import.meta.dir, '../server/webclient');
    const dependencies = join(dirname(botsDir), 'server/webclient/node_modules');
    const ownerKey = digest(`Bearer ${token}`);
    const delegatedKey = Bun.file(join(configDir, 'caller.sha256'));
    const events: Event[] = [];
    let nextEventId = 1;
    let client: Process | undefined;
    let task: Task | undefined;
    let clientExit: Exit | null = null;
    let taskExit: (Exit & { name: DemoTaskName }) | null = null;
    let busy = false;
    let taskStopped = false;

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
                } catch { /* Only the bundled task's structured messages are returned. */ }
            }
        }
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

    function startClient(bot: string) {
        const child = Bun.spawn([process.execPath, '--no-env-file', join(webclient, 'src/lite/runner.ts'), bot], {
            cwd: webclient,
            stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
            env: {
                ...process.env, GATEWAY_DIRECT: 'false', NODE_PATH: dependencies, RS_LITE_BOT_ENV: envFile,
                RS_LITE_CACHE_DIR: join(writableDir, 'cache'),
            },
        });
        const running = { process: child, startedAt: new Date().toISOString() };
        client = running;
        clientExit = null;
        event('client-started', { bot, pid: child.pid });
        void child.exited.then(async exitCode => {
            clientExit = { exitCode, at: new Date().toISOString() };
            event('client-exited', { exitCode });
            try { await stopProcess(task, 'SIGTERM'); }
            finally { if (client === running) client = undefined; }
        }).catch(() => { event('client-observer-failed'); });
    }

    async function startTask(bot: string, name: DemoTaskName) {
        const credentials = await botCredentials(bot, workingDir);
        const child = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, 'tasks', name + '.ts')], {
            cwd: writableDir,
            stdin: 'ignore', stdout: 'pipe', stderr: 'inherit',
            env: {
                ...process.env, BOT_USERNAME: credentials.username, PASSWORD: credentials.password,
                SERVER: 'rs-sdk.maxbittker.com', SHOW_CHAT: 'false', GATEWAY_DIRECT: 'false',
            },
        });
        const running: Task = { process: child, startedAt: new Date().toISOString(), name, activity: taskLabels[name] };
        task = running;
        taskExit = null;
        taskStopped = false;
        event('task-started', { task: name, pid: child.pid });
        const readEvents = consumeTaskEvents(child.stdout, running).catch(() => { event('task-event-reader-failed'); });
        void child.exited.then(async exitCode => {
            await readEvents;
            taskExit = { name, exitCode, at: new Date().toISOString() };
            if (task === running) task = undefined;
            event('task-exited', { exitCode });
        }).catch(() => { event('task-observer-failed'); });
    }

    async function state(bot: string | null) {
        const sample = bot && await hostedBotState(bot, workingDir);
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
            targets: nearbyNpcs.filter(npc => /^(Chicken|Cow(?: Calf)?|Guard|Knight of Ardougne|Hero)$/i.test(npc.name))
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
            bot, tasks: Object.keys(taskLabels),
            client: client ? { startedAt: client.startedAt, stopping: Boolean(client.stopping) } : null,
            task: task ? { name: task.name, startedAt: task.startedAt, stopping: Boolean(task.stopping), activity: task.activity, recovery: task.recovery } : null,
            lastTask: taskExit && !taskStopped ? { name: taskExit.name, exitCode: taskExit.exitCode, finishedAt: taskExit.at } : null,
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
        if (busy) return json({ error: 'Another demo command is in progress' }, 409);
        busy = true;
        try {
            if (route === 'client/start') {
                if (client || task) return json({ error: 'The demo client or task is already running' }, 409);
                const bot = await provisionBot();
                await botCredentials(bot, workingDir);
                if (roster && (await state(bot)).availability === 'live') {
                    return json({ error: 'This bot already has a live game client outside Fleet desk.' }, 409);
                }
                await mkdir(writableDir, { recursive: true, mode: 0o700 });
                startClient(bot);
                return json({ bot, phase: 'starting' }, 202);
            }
            if (route === 'task/start') {
                const body = await request.json().catch(() => null);
                const name = body?.task;
                if (typeof name !== 'string' || !Object.hasOwn(taskLabels, name)) {
                    return json({ error: 'Unknown demo task' }, 400);
                }
                const bot = await storedBot();
                const activeClient = client;
                if (!bot || !activeClient || task || (await state(bot)).availability !== 'live' ||
                    client !== activeClient || activeClient.stopping || activeClient.process.exitCode !== null) {
                    return json({ error: 'Start the demo client and wait for live state before starting a task' }, 409);
                }
                await startTask(bot, name as DemoTaskName);
                return json({ bot, task: name, phase: 'starting' }, 202);
            }
            if (task) taskStopped = true;
            await stopProcess(task, 'SIGTERM');
            if (route === 'client/stop') await stopProcess(client, 'SIGINT');
            return json({ ok: true });
        } catch {
            event('command-failed', { route });
            return json({ error: 'Demo command failed on the host' }, 503);
        } finally {
            busy = false;
        }
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

    return { handle, profile, status, allowed, recentEvents, ...actions };
}

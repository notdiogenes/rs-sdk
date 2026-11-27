import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { botCredentials, hostedBotName, hostedBotState, isFreshBotState } from './hosted-bot';
import { inventoryActionResponse, inventoryControls } from './dashboard-inventory';
import { dashboardClientFeed } from './dashboard-live-state';
import { dashboardFleetStats } from './dashboard-fleet-stats';
import { parseInventoryCommand } from '../sdk/inventory-command';

const root = join(import.meta.dir, '..');
const configDir = process.env.RS_CONTROL_CONFIG_DIR;
if (!configDir) throw new Error('RS_CONTROL_CONFIG_DIR is required');
const fleetRuntime = join(dirname(configDir), 'rs-sdk-public-status');
const fleetStats = dashboardFleetStats(fleetRuntime);
const token = (await Bun.file(join(configDir, 'token')).text()).trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid control token');
const digest = (value: string) => createHash('sha256').update(value).digest();
const expected = [digest(`Bearer ${token}`)];
const callerKey = Bun.file(join(configDir, 'caller.sha256'));
if (await callerKey.exists()) {
    const hash = (await callerKey.text()).trim();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid caller key hash');
    expected.push(Buffer.from(hash, 'hex'));
}
const headers = { 'Cache-Control': 'no-store' };
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers });
const error = (message: string, status: number) => reply({ error: message }, status);

type Profile = { bot: string; directory: string; tasks: Map<string, string> };
type ProcessInfo = { process: Bun.Subprocess; startedAt: string; stop?: Promise<void> };
let client: (ProcessInfo & {
    profile: Profile;
    inventory: ReturnType<typeof inventoryControls>;
    feed: ReturnType<typeof dashboardClientFeed>;
}) | undefined;
let task: (ProcessInfo & { name: string }) | undefined;
let lastTask: { name: string; exitCode: number; finishedAt: string } | undefined;
let mutating = false;

async function readProfile(): Promise<Profile | null> {
    const config = Bun.file(join(configDir!, 'control.json'));
    if (!await config.exists()) return null;
    const value = await config.json();
    if (typeof value?.bot !== 'string' || !hostedBotName.test(value.bot) ||
        !value.tasks || typeof value.tasks !== 'object' || Array.isArray(value.tasks)) {
        throw new Error('Invalid control.json');
    }
    const directory = join(root, 'bots', value.bot);
    return {
        bot: value.bot,
        directory,
        tasks: new Map(Object.entries(value.tasks).map(([name, file]) => {
            if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || typeof file !== 'string' ||
                !/^[a-zA-Z0-9_-]+\.ts$/.test(file)) throw new Error('Invalid task allowlist entry');
            return [name, file];
        })),
    };
}

async function gameState(profile: Profile) {
    const result = await hostedBotState(profile.bot, profile.directory);
    if (!result?.state?.player || !result.state.inGame) return { availability: 'offline' as const };
    const { stateAge, state } = result;
    const { player } = result.state;
    return {
        availability: isFreshBotState(stateAge) ? 'live' as const : 'stale' as const,
        stateAgeMs: Number.isFinite(stateAge) ? stateAge : null,
        tick: state.tick,
        player: {
            name: player.name, x: player.worldX, z: player.worldZ,
            hp: player.hp, maxHp: player.maxHp, inCombat: player.combat.inCombat,
        },
        skills: state.skills.map(({ name, baseLevel, experience }) => ({ name, baseLevel, experience })),
        inventory: state.inventory.map(({ name, count }) => ({ name, count })),
        equipment: state.equipment.map(({ name, count }) => ({ name, count })),
    };
}

function spawn(args: string[], cwd: string, ipc?: (message: unknown) => void): ProcessInfo {
    return {
        process: Bun.spawn([process.execPath, ...args], { cwd, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', ipc }),
        startedAt: new Date().toISOString(),
    };
}

function stop(handle?: ProcessInfo, signal: 'SIGINT' | 'SIGTERM' = 'SIGTERM') {
    if (!handle) return Promise.resolve();
    return handle.stop ??= (async () => {
        if (handle.process.exitCode !== null) return;
        handle.process.kill(signal);
        const timeout = setTimeout(() => handle.process.kill('SIGKILL'), 5000);
        try { await handle.process.exited; } finally { clearTimeout(timeout); }
    })();
}

function status(profile: Profile | null) {
    return {
        configured: profile !== null,
        bot: profile?.bot ?? null,
        tasks: [...(profile?.tasks.keys() ?? [])],
        client: client ? {
            startedAt: client.startedAt, stopping: Boolean(client.stop), inventoryActions: client.inventory.available(),
        } : null,
        task: task ? { name: task.name, startedAt: task.startedAt, stopping: Boolean(task.stop) } : null,
        lastTask: lastTask ?? null,
    };
}

const server = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(process.env.RS_CONTROL_PORT ?? 3719),
    maxRequestBodySize: 4096,
    async fetch(request) {
        const { pathname, searchParams } = new URL(request.url);
        const route = `${request.method} ${pathname}`;
        if (route === 'GET /health') return reply({ ok: true });
        const offered = digest(request.headers.get('Authorization') ?? '');
        if (!expected.some(key => timingSafeEqual(key, offered))) {
            return Response.json({ error: 'Unauthorized' }, {
                status: 401, headers: { ...headers, 'WWW-Authenticate': 'Bearer' },
            });
        }
        if (route === 'POST /v1/inventory/action') {
            if (!timingSafeEqual(expected[0]!, offered)) return error('Unauthorized', 401);
            const body = await request.json().catch(() => null);
            const command = parseInventoryCommand(body);
            if (!command) return error('Invalid inventory action.', 400);
            const running = client;
            if (!running || running.stop || running.profile.bot !== body.bot) {
                return error('Inventory controls are unavailable for this game client.', 409);
            }
            return inventoryActionResponse(await running.inventory.send(running.process, command));
        }
        if (request.method === 'GET') {
            try {
                const profile = client?.profile ?? await readProfile();
                if (route === 'GET /v1/status') {
                    const value = status(profile);
                    const includeFleet = searchParams.get('fleet') === '1' && timingSafeEqual(expected[0]!, offered);
                    return reply(includeFleet && client && !client.stop && client.process.exitCode === null
                        ? { ...value, fleetState: client.feed.state() }
                        : value);
                }
                if (route === 'GET /v1/state') {
                    return profile ? reply(await gameState(profile)) : error('Bot not configured', 409);
                }
                return error('Not found', 404);
            } catch {
                return error('Could not read the configuration or gateway state', 503);
            }
        }
        if (!['POST /v1/client/start', 'POST /v1/client/stop', 'POST /v1/task/start', 'POST /v1/task/stop'].includes(route)) {
            return error('Not found', 404);
        }
        if (mutating) return error('Another command is in progress', 409);
        mutating = true;
        try {
            if (route === 'POST /v1/task/stop' || route === 'POST /v1/client/stop') {
                await stop(task);
                if (route === 'POST /v1/client/stop') await stop(client, 'SIGINT');
                return reply({ ok: true });
            }
            if (route === 'POST /v1/client/start') {
                if (client || task) return error('A client or task is already active', 409);
                const profile = await readProfile();
                if (!profile) return error('Bot not configured', 409);
                await botCredentials(profile.bot, profile.directory);
                const inventory = inventoryControls();
                const feed = dashboardClientFeed((items, at) => {
                    if (existsSync(fleetRuntime)) fleetStats.recordBank(profile.bot, items, at);
                });
                const running = {
                    ...spawn(['src/lite/runner.ts', profile.bot], join(root, 'server/webclient'), message => {
                        inventory.receive(message);
                        feed.receive(message);
                    }),
                    profile, inventory, feed,
                };
                client = running;
                void running.process.exited.then(async () => {
                    inventory.disconnect();
                    // Keep client ownership until any controller has stopped.
                    try { await stop(task); } finally { if (client === running) client = undefined; }
                }).catch(() => console.error('Could not stop the task after client exit'));
                return reply({ phase: 'starting' }, 202);
            }

            const running = client;
            if (!running || running.stop || running.process.exitCode !== null || task) {
                return error('Start the managed lite client first and stop any active task', 409);
            }
            const body = await request.json().catch(() => null);
            const name = body?.task;
            const file = typeof name === 'string' ? running.profile.tasks.get(name) : undefined;
            if (!file) return error('Unknown task', 400);
            const path = join(running.profile.directory, file);
            if (await realpath(path) !== path) return error('Task path must not use symlinks', 409);
            const state = await gameState(running.profile);
            if (client !== running || running.process.exitCode !== null || state.availability !== 'live') {
                return error('Managed client is not ready', 409);
            }
            const controller = { ...spawn([path], root), name };
            task = controller;
            void controller.process.exited.then(exitCode => {
                lastTask = { name, exitCode, finishedAt: new Date().toISOString() };
                if (task === controller) task = undefined;
            }).catch(() => console.error('Could not read task exit status'));
            return reply({ task: name, phase: 'starting' }, 202);
        } catch {
            return error('Command failed. Check the local configuration and service logs.', 503);
        } finally {
            mutating = false;
        }
    },
});
console.log(`RS-SDK control API listening on 127.0.0.1:${server.port}`);

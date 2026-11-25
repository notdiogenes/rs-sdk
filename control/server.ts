import { createHash, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { BotWorldState } from '../sdk/types';

const root = join(import.meta.dir, '..');
const configDir = process.env.RS_CONTROL_CONFIG_DIR;
if (!configDir) throw new Error('RS_CONTROL_CONFIG_DIR is required');
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
let client: (ProcessInfo & { profile: Profile }) | undefined;
let task: (ProcessInfo & { name: string }) | undefined;
let lastTask: { name: string; exitCode: number; finishedAt: string } | undefined;
let mutating = false;

async function readProfile(): Promise<Profile | null> {
    const config = Bun.file(join(configDir!, 'control.json'));
    if (!await config.exists()) return null;
    const value = await config.json();
    if (typeof value?.bot !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ]{0,11}$/.test(value.bot) ||
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

async function botCredentials(profile: Profile) {
    const contents = await Bun.file(join(profile.directory, 'bot.env')).text();
    const values = new Map<string, string>();
    for (const raw of contents.split('\n')) {
        const line = raw.trim();
        const separator = line.indexOf('=');
        if (line.startsWith('#') || separator < 1) continue;
        values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    const username = values.get('BOT_USERNAME');
    const password = values.get('PASSWORD');
    const server = values.get('SERVER');
    if (username !== profile.bot || !password || server !== 'rs-sdk.maxbittker.com' ||
        values.has('GATEWAY_URL')) {
        throw new Error('Expected a matching bot.env for the hosted demo server, with no GATEWAY_URL override');
    }
    return { username, password };
}

async function gameState(profile: Profile) {
    const { username, password } = await botCredentials(profile);
    const url = new URL(`/state/${encodeURIComponent(username)}`, 'https://rs-sdk.maxbittker.com');
    // The hosted engine relays the query string to the gateway. Never log this URL.
    url.searchParams.set('password', password);
    const response = await fetch(url, { signal: AbortSignal.timeout(7000), redirect: 'error' });
    if (response.status === 404) return { availability: 'offline' as const };
    if (!response.ok) throw new Error('Game gateway request failed');
    const body = await response.json() as { state: BotWorldState; stateAge: number };
    const { state, stateAge } = body;
    if (!state?.player || !state.inGame) return { availability: 'offline' as const };
    return {
        availability: Number.isFinite(stateAge) && stateAge >= 0 && stateAge <= 10_000 ? 'live' as const : 'stale' as const,
        stateAgeMs: Number.isFinite(stateAge) ? stateAge : null,
        tick: state.tick,
        player: {
            name: state.player.name, x: state.player.worldX, z: state.player.worldZ,
            hp: state.player.hp, maxHp: state.player.maxHp, inCombat: state.player.combat.inCombat,
        },
        skills: state.skills.map(({ name, baseLevel, experience }) => ({ name, baseLevel, experience })),
        inventory: state.inventory.map(({ name, count }) => ({ name, count })),
        equipment: state.equipment.map(({ name, count }) => ({ name, count })),
    };
}

function spawn(args: string[], cwd: string): ProcessInfo {
    return {
        process: Bun.spawn([process.execPath, ...args], { cwd, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }),
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
        client: client ? { startedAt: client.startedAt, stopping: Boolean(client.stop) } : null,
        task: task ? { name: task.name, startedAt: task.startedAt, stopping: Boolean(task.stop) } : null,
        lastTask: lastTask ?? null,
    };
}

const server = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(process.env.RS_CONTROL_PORT ?? 3719),
    maxRequestBodySize: 4096,
    async fetch(request) {
        const { pathname } = new URL(request.url);
        const route = `${request.method} ${pathname}`;
        if (route === 'GET /health') return reply({ ok: true });
        const offered = digest(request.headers.get('Authorization') ?? '');
        if (!expected.some(key => timingSafeEqual(key, offered))) {
            return Response.json({ error: 'Unauthorized' }, {
                status: 401, headers: { ...headers, 'WWW-Authenticate': 'Bearer' },
            });
        }
        if (request.method === 'GET') {
            try {
                const profile = client?.profile ?? await readProfile();
                if (route === 'GET /v1/status') return reply(status(profile));
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
                await botCredentials(profile);
                const running = { ...spawn(['src/lite/runner.ts', profile.bot], join(root, 'server/webclient')), profile };
                client = running;
                void running.process.exited.then(async () => {
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

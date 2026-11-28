import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { MonitorProcess } from './dashboard-monitor';
import type { RuntimeGroup } from './dashboard-runtime-groups';

type RuntimeKind = 'lite' | 'sdk';
type ProcessSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

export type RuntimeProcess = {
    readonly pid: number;
    readonly exitCode: number | null;
    readonly exited: Promise<number>;
    readonly groupId?: string;
    send(message: unknown): void;
    kill(signal: ProcessSignal): void;
};

export type RuntimeTaskProcess = RuntimeProcess & {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
};

type LiteStart = { bot: string; envFile: string; cacheDir: string; receive(message: unknown): void };
type SdkStart = { bot: string; script: string; cwd: string; env: Record<string, string | undefined>; receive(message: unknown): void };
type PoolChild = Pick<Bun.Subprocess, 'pid' | 'exited' | 'exitCode' | 'send' | 'kill'>;
type PoolOptions = {
    webclient?: string;
    dependencies?: string;
    spawn?(kind: RuntimeKind, receive: (message: unknown) => void): PoolChild;
};

type Session = {
    bot: string;
    start: Record<string, unknown>;
    launched: boolean;
    exitCode: number | null;
    receive(message: unknown): void;
    resolveExit(code: number): void;
    stdout?: ReturnType<typeof outputStream>;
    stderr?: ReturnType<typeof outputStream>;
};

type Host = {
    kind: RuntimeKind;
    group: RuntimeGroup;
    child: PoolChild;
    startedAt: string;
    sessions: Map<string, Session>;
    ready: boolean;
    retiring: boolean;
    startup?: ReturnType<typeof setTimeout>;
    idle?: ReturnType<typeof setTimeout>;
};

const STARTUP_TIMEOUT = 30_000;
const IDLE_TIMEOUT = 30_000;

function outputStream() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
        start: target => { controller = target; },
        cancel: () => { closed = true; },
    });
    const encoder = new TextEncoder();
    return {
        stream,
        write: (chunk: string) => { if (!closed) controller.enqueue(encoder.encode(chunk)); },
        close: () => {
            if (closed) return;
            closed = true;
            controller.close();
        },
    };
}

export function createDashboardRuntimePools(options: PoolOptions = {}) {
    const webclient = options.webclient ?? join(import.meta.dir, '../server/webclient');
    const pools = new Map<string, Host>();
    const sessions = new Set<string>();
    const hostKey = (kind: RuntimeKind, id: string) => `${kind}\0${id}`;
    const botKey = (kind: RuntimeKind, bot: string) => `${kind}\0${bot.toLowerCase()}`;

    function spawn(kind: RuntimeKind, receive: (message: unknown) => void): PoolChild {
        if (options.spawn) return options.spawn(kind, receive);
        const lite = kind === 'lite';
        return Bun.spawn([process.execPath, '--no-env-file',
            lite ? join(webclient, 'src/lite/pool.ts') : join(import.meta.dir, 'runtime-task-host.ts')], {
            cwd: lite ? webclient : import.meta.dir,
            stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
            ipc: receive,
            env: {
                ...process.env,
                ...(lite && { GATEWAY_DIRECT: 'false' }),
                ...(lite && options.dependencies && { NODE_PATH: options.dependencies }),
            },
        });
    }

    function finish(host: Host, sessionId: string, code: number, error?: string) {
        const session = host.sessions.get(sessionId);
        if (!session) return;
        host.sessions.delete(sessionId);
        sessions.delete(botKey(host.kind, session.bot));
        session.exitCode = code;
        try {
            if (error) session.stderr?.write(error + '\n');
            session.stdout?.close();
            session.stderr?.close();
        } finally {
            session.resolveExit(code);
        }
        if (!host.sessions.size && !host.retiring) {
            host.idle = setTimeout(() => {
                host.retiring = true;
                if (host.child.exitCode === null) host.child.kill('SIGTERM');
            }, IDLE_TIMEOUT);
            host.idle.unref();
        }
    }

    function sendStart(host: Host, sessionId: string, session: Session) {
        try {
            host.child.send({ type: `${host.kind}-start`, sessionId, ...session.start });
            session.launched = true;
        } catch {
            finish(host, sessionId, 1, 'Could not start a session in the runtime group.');
        }
    }

    function receive(host: Host, payload: unknown) {
        if (!payload || typeof payload !== 'object') return;
        const { type, sessionId, exitCode, error, chunk, message } = payload as Record<string, unknown>;
        if (type === `${host.kind}-ready`) {
            if (host.retiring || host.ready) return;
            clearTimeout(host.startup);
            host.ready = true;
            for (const [id, session] of host.sessions) sendStart(host, id, session);
            return;
        }
        if (typeof sessionId !== 'string') return;
        const target = host.sessions.get(sessionId);
        if (!target || !target.launched) return;
        switch (type) {
            case `${host.kind}-message`:
                target.receive(message);
                break;
            case `${host.kind}-stdout`:
                if (typeof chunk === 'string') target.stdout?.write(chunk);
                break;
            case `${host.kind}-stderr`:
                if (typeof chunk === 'string') target.stderr?.write(chunk);
                break;
            case `${host.kind}-ended`:
                finish(host, sessionId, typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? exitCode : 1,
                    typeof error === 'string' ? error : undefined);
                break;
        }
    }

    function hostFor(kind: RuntimeKind, group: RuntimeGroup) {
        const key = hostKey(kind, group.id);
        const existing = pools.get(key);
        if (existing && !existing.retiring && existing.child.exitCode === null) {
            existing.group = group;
            clearTimeout(existing.idle);
            return existing;
        }
        const child = spawn(kind, message => receive(host, message));
        const host: Host = { kind, group, child, startedAt: new Date().toISOString(), sessions: new Map(), ready: false, retiring: false };
        pools.set(key, host);
        host.startup = setTimeout(() => {
            host.retiring = true;
            if (child.exitCode === null) child.kill('SIGKILL');
        }, STARTUP_TIMEOUT);
        host.startup.unref();
        void child.exited.then(exitCode => {
            clearTimeout(host.startup);
            clearTimeout(host.idle);
            host.retiring = true;
            if (pools.get(key) === host) pools.delete(key);
            for (const id of host.sessions.keys()) finish(host, id, exitCode || 1, 'The runtime group process exited.');
        }).catch(error => console.error('[fleet-runtime] Could not observe group process exit.', error));
        return host;
    }

    function launch(kind: RuntimeKind, group: RuntimeGroup, bot: string, start: Record<string, unknown>,
        onMessage: (message: unknown) => void, channels?: { stdout: Session['stdout']; stderr: Session['stderr'] }) {
        const key = botKey(kind, bot);
        if (sessions.has(key)) throw new Error(`${bot} already has an active ${kind === 'lite' ? 'Lite' : 'SDK'} runtime session.`);
        const host = hostFor(kind, group);
        const id = randomUUID();
        const exit = Promise.withResolvers<number>();
        const session: Session = { bot, start, receive: onMessage, resolveExit: exit.resolve, launched: false, exitCode: null, ...channels };
        sessions.add(key);
        host.sessions.set(id, session);
        if (host.ready) sendStart(host, id, session);
        return {
            pid: host.child.pid,
            groupId: group.id,
            get exitCode() { return session.exitCode; },
            exited: exit.promise,
            send(message: unknown) {
                if (session.exitCode !== null || !session.launched) throw new Error('The runtime session is unavailable.');
                host.child.send({ type: kind === 'lite' ? 'lite-send' : 'sdk-message', sessionId: id, message });
            },
            kill(signal: ProcessSignal) {
                if (session.exitCode !== null) return;
                if (!session.launched) {
                    finish(host, id, 0);
                    return;
                }
                if (host.child.exitCode !== null) return;
                try { host.child.send({ type: `${kind}-stop`, sessionId: id, force: signal === 'SIGKILL' }); }
                catch { /* Keep ownership until the child reports an exit. */ }
            },
        } satisfies RuntimeProcess;
    }

    function startLite(group: RuntimeGroup, { bot, envFile, cacheDir, receive }: LiteStart): RuntimeProcess {
        return launch('lite', group, bot, { bot, envFile, cacheDir, gatewayDirect: false }, receive);
    }

    function startSdk(group: RuntimeGroup, { bot, script, cwd, env, receive }: SdkStart): RuntimeTaskProcess {
        const stdout = outputStream();
        const stderr = outputStream();
        return Object.assign(launch('sdk', group, bot, { bot, script, cwd, env }, receive, { stdout, stderr }),
            { stdout: stdout.stream, stderr: stderr.stream });
    }

    function monitoredProcesses(): MonitorProcess[] {
        return [...pools.values()].flatMap(host => host.child.exitCode === null ? [{
            kind: host.kind === 'lite' ? 'client' : 'task',
            bot: null,
            groupName: host.group.name,
            bots: [...host.sessions.values()].map(session => session.bot),
            pid: host.child.pid,
            startedAt: host.startedAt,
        } satisfies MonitorProcess] : []);
    }

    return { startLite, startSdk, monitoredProcesses };
}

export type DashboardRuntimePools = ReturnType<typeof createDashboardRuntimePools>;

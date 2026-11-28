import './dom-shim.js';
import { OutdatedClientError } from './net/GameConnection.js';
import { readLiteRunnerOptions, startLiteRunner, type LiteGatewayRunner, type LiteRunnerMessage } from './runner.js';

type Start = { type: 'lite-start'; sessionId: string; bot: string; envFile: string; cacheDir?: string; gatewayDirect?: boolean };
type Stop = { type: 'lite-stop'; sessionId: string; force?: boolean };
type Send = { type: 'lite-send'; sessionId: string; message: unknown };
type HostMessage = { type: 'lite-ready' }
    | { type: 'lite-started'; sessionId: string }
    | { type: 'lite-ended'; sessionId: string; exitCode: number; error?: string }
    | { type: 'lite-message'; sessionId: string; message: LiteRunnerMessage };

type Runner = Pick<LiteGatewayRunner, 'acceptInventoryCommand' | 'stop' | 'stopped'>;
type Launch = (...args: Parameters<typeof startLiteRunner>) => Promise<Runner>;
type Session = { bot: string; cancel: AbortController; starting: boolean; runner?: Runner };

export function createLitePool(send: (message: HostMessage) => void, launch: Launch = startLiteRunner) {
    const sessions = new Map<string, Session>();
    let starts = Promise.resolve();
    let host: string | undefined;

    function finish(id: string, session: Session, exitCode: number, error?: string) {
        if (sessions.get(id) !== session) return;
        sessions.delete(id);
        if (error) console.error(`[lite-pool] ${session.bot}: ${error}`);
        send({ type: 'lite-ended', sessionId: id, exitCode, error });
    }

    async function start(command: Start, session: Session) {
        const id = command.sessionId;
        if (sessions.get(id) !== session) return;
        session.starting = true;
        const signal = session.cancel.signal;
        try {
            const options = await readLiteRunnerOptions(command.envFile, command.cacheDir, command.gatewayDirect);
            signal.throwIfAborted();
            if (options.username.toLowerCase() !== session.bot) throw new Error('The Lite configuration belongs to a different bot');
            if (host && options.host !== host) throw new Error('A Lite runtime group must use one game server');
            const gateway = new URL(options.gatewayUrl);
            if (!['ws:', 'wss:'].includes(gateway.protocol) || gateway.hash) throw new Error('Invalid Lite gateway URL');
            host ??= options.host;
            const preserveCache = [...sessions.values()].some(current => !!current.runner);
            const runner = await launch({ ...options, shareLocIndex: true, preserveCache, signal }, message => {
                if (sessions.get(id) === session && !signal.aborted) send({ type: 'lite-message', sessionId: id, message });
            });
            session.runner = runner;
            if (signal.aborted) runner.stop();
            else {
                send({ type: 'lite-started', sessionId: id });
                send({ type: 'lite-message', sessionId: id, message: { type: 'inventory-ready' } });
            }
            void runner.stopped.then(end => {
                runner.stop();
                finish(id, session, end.reason === 'stopped' ? 0 : 1,
                    end.reason === 'stopped' ? undefined : `Lite game session ended (${end.reason})`);
            });
        } catch (error) {
            if (signal.aborted) finish(id, session, 0);
            else finish(id, session, error instanceof OutdatedClientError ? 3 : 1,
                error instanceof Error ? error.message : 'Could not start the Lite game client');
        }
    }

    function stop(id: string, session: Session, force = false) {
        session.cancel.abort();
        if (session.runner) session.runner.stop();
        else if (force || !session.starting) finish(id, session, 0);
    }

    function accept(value: unknown) {
        const command = value as Partial<Start | Stop | Send> | null;
        if (!command || typeof command.sessionId !== 'string' || !command.sessionId) return;
        const id = command.sessionId;
        const current = sessions.get(id);
        if (command.type === 'lite-start') {
            if (current || typeof command.bot !== 'string' || typeof command.envFile !== 'string') return;
            const bot = command.bot.toLowerCase();
            if ([...sessions.values()].some(session => session.bot === bot)) {
                send({ type: 'lite-ended', sessionId: id, exitCode: 1, error: 'The bot already has a Lite session in this group' });
                return;
            }
            const session: Session = { bot, cancel: new AbortController(), starting: false };
            sessions.set(id, session);
            // Configuration tables are process-global. Serialize cold starts and CRC refreshes.
            const request: Start = {
                type: command.type, sessionId: id, bot: command.bot, envFile: command.envFile,
                cacheDir: command.cacheDir, gatewayDirect: command.gatewayDirect,
            };
            starts = starts.then(() => start(request, session));
        } else if (current && command.type === 'lite-stop') stop(id, current, command.force);
        else if (current && command.type === 'lite-send' && !current.cancel.signal.aborted) {
            current.runner?.acceptInventoryCommand(command.message);
        }
    }

    return { accept, stopAll: () => { for (const [id, session] of sessions) stop(id, session, true); } };
}

if (import.meta.main) {
    if (!process.connected) throw new Error('The Lite pool needs a supervisor IPC connection');
    const send = (message: HostMessage) => {
        if (!process.connected) return;
        try { process.send?.(message); }
        catch { /* The supervisor closed IPC and will own the process exit. */ }
    };
    const pool = createLitePool(send);
    const shutdown = () => {
        pool.stopAll();
        process.exit(0);
    };
    process.on('message', pool.accept);
    process.once('disconnect', shutdown);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    send({ type: 'lite-ready' });
}

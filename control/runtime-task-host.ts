// A Fleet Desk task group is one OS process; each run has its own Bun worker,
// module registry, credentials and SDK connection. Only the supervisor has IPC.
import { isAbsolute, join } from 'node:path';

type Start = { type: 'sdk-start'; sessionId: string; bot: string; script: string; env: Record<string, string>; cwd: string };
type Command = Start | { type: 'sdk-stop'; sessionId: string; force?: boolean }
    | { type: 'sdk-message'; sessionId: string; message: unknown };

type Run = { bot: string; worker: Worker; forced: boolean };
const runs = new Map<string, Run>();
const send = (message: object) => process.send?.(message);

function start(command: Start) {
    const { sessionId, bot, script, env, cwd } = command;
    if (runs.has(sessionId)) return; // A repeated start must not replace a live run.
    try {
        if (!isAbsolute(script) || !isAbsolute(cwd)) throw new Error('Expected an absolute task script and working directory.');
        if (Array.from(runs.values()).some(run => run.bot === bot)) throw new Error('This bot already has a running SDK task.');
        const worker = new Worker(join(import.meta.dir, 'runtime-task-worker.ts'), {
            name: bot, smol: true,
            env: { ...env, RS_FLEET_TASK_ENTRY: script, RS_FLEET_TASK_DIR: cwd },
        });
        const run = { bot, worker, forced: false };
        runs.set(sessionId, run);
        worker.onmessage = ({ data }) => {
            if (runs.get(sessionId) !== run) return;
            if (data.type === 'ready') send({ type: 'sdk-started', sessionId });
            if (data.type === 'stdout' || data.type === 'stderr') send({ type: 'sdk-' + data.type, sessionId, chunk: data.chunk });
            if (data.type === 'message') send({ type: 'sdk-message', sessionId, message: data.message });
        };
        worker.onerror = event => {
            send({ type: 'sdk-stderr', sessionId, chunk: String(event.message) + '\n' });
        };
        worker.addEventListener('close', event => {
            runs.delete(sessionId);
            send({ type: 'sdk-ended', sessionId, exitCode: run.forced ? 137 : (event as CloseEvent).code });
        });
    } catch (error) {
        send({ type: 'sdk-ended', sessionId, exitCode: 1, error: error instanceof Error ? error.message : String(error) });
    }
}

process.on('message', (command: Command) => {
    if (!command || typeof command.sessionId !== 'string') return;
    if (command.type === 'sdk-start') return start(command);
    const run = runs.get(command.sessionId);
    if (!run) return;
    if (command.type === 'sdk-stop' && command.force) {
        run.forced = true;
        run.worker.terminate();
    } else if (command.type === 'sdk-stop') {
        run.worker.postMessage({ type: 'stop' });
    } else if (command.type === 'sdk-message') {
        run.worker.postMessage({ type: 'message', message: command.message });
    }
});

process.on('disconnect', () => process.exit(0));
send({ type: 'sdk-ready' });

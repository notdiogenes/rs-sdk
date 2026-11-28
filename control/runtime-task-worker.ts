// Worker globals belong to one task. Adapt the CLI's output, control IPC and
// termination signal here so pinned task modules keep their normal contracts.
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const port = parentPort!;
const script = process.env.RS_FLEET_TASK_ENTRY!;
process.argv = [process.execPath, script];
// Eligible task files are absolute; SDK cwd-based path construction must
// likewise resolve relative to the managed bot directory.
process.cwd = () => process.env.RS_FLEET_TASK_DIR!;

function output(type: 'stdout' | 'stderr') {
    return new Writable({
        decodeStrings: false,
        write(chunk, _encoding, done) {
            port.postMessage({ type, chunk: typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString() });
            done();
        },
    });
}

const stdout = output('stdout');
const stderr = output('stderr');
globalThis.console = new Console(stdout, stderr);
process.stdout.write = stdout.write.bind(stdout);
process.stderr.write = stderr.write.bind(stderr);
Object.defineProperties(process, {
    connected: { configurable: true, value: true },
    send: { configurable: true, value: (message: unknown) => {
        port.postMessage({ type: 'message', message });
        return true;
    } },
});
port.on('message', command => {
    if (command.type === 'message') process.emit('message', command.message, undefined);
    if (command.type === 'stop') {
        if (!process.listenerCount('SIGTERM')) process.exit(143);
        process.emit('SIGTERM', 'SIGTERM');
    }
});

async function run() {
    port.postMessage({ type: 'ready' });
    try {
        // Bun's import.meta.main is false even for a worker entry. Apply CLI
        // semantics to just this pinned script, including older task revisions.
        const entry = new RegExp('^' + script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
        Bun.plugin({
            name: 'fleet-sdk-task-entry',
            setup(build) {
                build.onLoad({ filter: entry }, async ({ path }) => {
                    const transpiler = new Bun.Transpiler({ loader: 'ts', define: { 'import.meta.main': 'true' } });
                    return { contents: transpiler.transformSync(await Bun.file(path).text()), loader: 'js' };
                });
            },
        });
        await import(pathToFileURL(script).href);
    } catch (error) {
        console.error(error instanceof Error ? error.stack : error);
        process.exitCode = 1;
    } finally {
        process.exit(Number(process.exitCode ?? 0));
    }
}

void run();

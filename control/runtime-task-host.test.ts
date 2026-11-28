import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a pooled SDK worker owns its environment, script entry, output, IPC and exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-sdk-[test]-'));
    const script = join(dir, 'activity.ts');
    const messages: Array<{ type: string; sessionId?: string; exitCode?: number; chunk?: string;
        message?: { type?: string; bot?: string; pid?: number; cwd?: string; helperIsMain?: boolean } }> = [];
    const pool = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, 'runtime-task-host.ts')], {
        ipc: message => messages.push(message),
        stdout: 'ignore', stderr: 'inherit',
    });

    async function received(type: string, sessionId?: string, detail?: string) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const match = messages.find(event => event.type === type && event.sessionId === sessionId &&
                (!detail || event.message?.type === detail || event.chunk?.includes(detail)));
            if (match) return match;
            await Bun.sleep(5);
        }
        throw new Error(`Timed out waiting for ${type} from ${sessionId ?? 'host'}`);
    }

    function start(sessionId: string, task = script) {
        pool.send({ type: 'sdk-start', sessionId, bot: sessionId, script: task, cwd: dir,
            env: { BOT_USERNAME: sessionId, PASSWORD: '', RS_ACTIVITY_AUDIT: '1' } });
    }

    try {
        await Bun.write(join(dir, 'helper.ts'), 'export const isMain = import.meta.main;');
        await Bun.write(script, `
            import { isMain } from './helper';
            if (import.meta.main) {
                const bot = process.env.BOT_USERNAME;
                process.stderr.write('worker ' + bot + '\\n');
                await new Promise(resolve => {
                    if (bot !== 'unhandled') process.on('SIGTERM', () => {
                        if (bot === 'graceful') { process.exitCode = 23; resolve(); }
                    });
                    process.on('message', command => {
                        if (command.type === 'ping') process.send({ type: 'pong', bot });
                        if (command.type === 'exit') process.exit(7);
                    });
                    process.send({ type: 'running', pid: process.pid, cwd: process.cwd(), bot, helperIsMain: isMain });
                });
                console.log('finished ' + bot);
            }
        `);
        await received('sdk-ready');
        start('graceful');
        start('forced');
        for (const bot of ['graceful', 'forced']) {
            const ready = await received('sdk-message', bot, 'running');
            expect(ready.message).toEqual({ type: 'running', pid: pool.pid, bot, cwd: dir, helperIsMain: false });
            expect((await received('sdk-stderr', bot)).chunk).toBe('worker ' + bot + '\n');
        }

        pool.send({ type: 'sdk-stop', sessionId: 'graceful' });
        expect((await received('sdk-ended', 'graceful')).exitCode).toBe(23);
        expect((await received('sdk-stdout', 'graceful')).chunk).toBe('finished graceful\n');
        pool.send({ type: 'sdk-message', sessionId: 'forced', message: { type: 'ping' } });
        expect((await received('sdk-message', 'forced', 'pong')).message?.bot).toBe('forced');
        pool.send({ type: 'sdk-stop', sessionId: 'forced', force: true });
        expect((await received('sdk-ended', 'forced')).exitCode).toBe(137);

        start('unhandled');
        await received('sdk-message', 'unhandled', 'running');
        pool.send({ type: 'sdk-stop', sessionId: 'unhandled' });
        expect((await received('sdk-ended', 'unhandled')).exitCode).toBe(143);

        start('exits');
        await received('sdk-message', 'exits', 'running');
        pool.send({ type: 'sdk-message', sessionId: 'exits', message: { type: 'exit' } });
        expect((await received('sdk-ended', 'exits')).exitCode).toBe(7);

        // Run a real, main-guarded catalog task through the same release entry
        // path. Its missing password must fail before any network connection.
        start('mining', join(import.meta.dir, 'tasks/mine-resources.ts'));
        expect((await received('sdk-ended', 'mining')).exitCode).toBe(1);
        await received('sdk-stderr', 'mining', 'Failed to connect');
    } finally {
        pool.kill();
        await pool.exited;
        await rm(dir, { recursive: true, force: true });
    }
}, 15000);

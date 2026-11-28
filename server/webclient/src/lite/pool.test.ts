import './dom-shim.js';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WordFilter from '#/wordfilter/WordFilter.js';
import { LiteClient } from './LiteClient.js';
import { createLitePool } from './pool.js';
import type { LiteRunnerMessage } from './runner.js';
import type { SessionEnd } from './session.js';

type Output = Parameters<Parameters<typeof createLitePool>[0]>[0];

async function until(ready: () => boolean) {
    for (let check = 0; check < 100 && !ready(); check++) await Bun.sleep(5);
    expect(ready()).toBe(true);
}

test('each Lite client activates its own profanity setting', () => {
    const previousFilter = WordFilter.enabled;
    // The filter assertion needs the wrapped method and activation, not a game cache.
    const client = (profanityFilter: boolean): LiteClient => Object.assign(Object.create(LiteClient.prototype), {
        profanityFilter, interfaces: { activate() {} },
    });
    try {
        const a = client(false);
        const b = client(true);
        a.isDialogOpen();
        expect(WordFilter.enabled).toBe(false);
        b.isDialogOpen();
        expect(WordFilter.enabled).toBe(true);
        a.isDialogOpen();
        expect(WordFilter.enabled).toBe(false);
    } finally {
        WordFilter.enabled = previousFilter;
    }
});

test('a Lite host isolates per-session inventory, end events, and game clients', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lite-pool-'));
    const outputs: Output[] = [];
    const running = new Map<string, { publish?: (message: LiteRunnerMessage) => void; received: unknown[]; end: (event: SessionEnd) => void }>();
    const pool = createLitePool(output => outputs.push(output), async (options, publish) => {
        expect(options.shareLocIndex).toBe(true);
        expect(options.preserveCache).toBe(running.size > 0);
        const received: unknown[] = [];
        const { promise, resolve: end } = Promise.withResolvers<SessionEnd>();
        running.set(options.username, { publish, received, end });
        return {
            stopped: promise,
            acceptInventoryCommand: message => received.push(message),
            stop: () => { running.delete(options.username); end({ reason: 'stopped' }); },
        };
    });
    try {
        for (const [sessionId, bot] of [['a', 'BotOne'], ['b', 'BotTwo']] as const) {
            const envFile = join(dir, `${bot}.env`);
            await Bun.write(envFile, `BOT_USERNAME=${bot}\nPASSWORD=test\nSERVER=localhost\n`);
            pool.accept({ type: 'lite-start', sessionId, bot, envFile });
        }
        await until(() => outputs.filter(output => output.type === 'lite-started').length === 2);
        expect(outputs.filter(output => output.type === 'lite-started').map(output => output.sessionId)).toEqual(['a', 'b']);

        const inventory = { type: 'inventory-command', requestId: 'inventory-a' };
        pool.accept({ type: 'lite-send', sessionId: 'a', message: inventory });
        expect(running.get('BotOne')?.received).toEqual([inventory]);
        expect(running.get('BotTwo')?.received).toEqual([]);
        const reply = { type: 'inventory-result', requestId: 'inventory-a', result: { status: 409, message: 'Test response' } } as const;
        running.get('BotOne')?.publish?.(reply);
        expect(outputs.at(-1)).toEqual({ type: 'lite-message', sessionId: 'a', message: reply });

        pool.accept({ type: 'lite-stop', sessionId: 'a' });
        await until(() => outputs.some(output => output.type === 'lite-ended' && output.sessionId === 'a'));
        expect(running.has('BotOne')).toBe(false);
        expect(running.has('BotTwo')).toBe(true);
        expect(outputs.at(-1)).toMatchObject({ type: 'lite-ended', sessionId: 'a', exitCode: 0 });

        running.get('BotTwo')?.end({ reason: 'disconnected' });
        await until(() => outputs.some(output => output.type === 'lite-ended' && output.sessionId === 'b'));
        expect(outputs.at(-1)).toMatchObject({ type: 'lite-ended', sessionId: 'b', exitCode: 1 });
    } finally {
        pool.stopAll();
        await rm(dir, { recursive: true, force: true });
    }
});

test('stopping a pending Lite login does not register or publish that session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lite-pool-cancel-'));
    const envFile = join(dir, 'BotOne.env');
    const outputs: Output[] = [];
    const started = Promise.withResolvers<void>();
    const pool = createLitePool(output => outputs.push(output), async options => {
        started.resolve();
        await new Promise<never>((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
        throw new Error('A cancelled login cannot reach a runner');
    });
    try {
        await Bun.write(envFile, 'BOT_USERNAME=BotOne\nPASSWORD=test\nSERVER=localhost\n');
        pool.accept({ type: 'lite-start', sessionId: 'pending', bot: 'BotOne', envFile });
        await started.promise;
        pool.accept({ type: 'lite-stop', sessionId: 'pending' });
        await until(() => outputs.length > 0);
        expect(outputs).toEqual([{ type: 'lite-ended', sessionId: 'pending', exitCode: 0, error: undefined }]);
    } finally {
        pool.stopAll();
        await rm(dir, { recursive: true, force: true });
    }
});

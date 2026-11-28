import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dashboardDemo } from './dashboard-demo';
import type { RuntimeGroup } from './dashboard-runtime-groups';
import { createDashboardRuntimePools } from './dashboard-runtime-pools';

type Packet = { type: string; sessionId?: string; bot?: string; message?: unknown; force?: boolean };
const alpha = { id: 'alpha', name: 'Alpha', mode: 'client-and-task' } satisfies RuntimeGroup;
const beta = { id: 'beta', name: 'Beta', mode: 'client-and-task' } satisfies RuntimeGroup;

function fakePools(autoReady = true) {
    const traffic: Packet[] = [];
    const hosts: Array<{
        pid: number;
        kind: 'lite' | 'sdk';
        packets: Packet[];
        signals: unknown[];
        hang: boolean;
        receive(message: unknown): void;
        exit(code: number): void;
    }> = [];
    const pools = createDashboardRuntimePools({
        spawn(kind, receive) {
            const result = Promise.withResolvers<number>();
            let exitCode: number | null = null;
            const host = {
                pid: hosts.length + 1000, kind, packets: [] as Packet[], signals: [] as unknown[], receive, hang: false,
                exit(code: number) { exitCode = code; result.resolve(code); },
            };
            hosts.push(host);
            if (autoReady) queueMicrotask(() => receive({ type: `${kind}-ready` }));
            return {
                pid: host.pid,
                get exitCode() { return exitCode; },
                exited: result.promise,
                send(raw: unknown) {
                    const packet = raw as Packet;
                    traffic.push(packet);
                    host.packets.push(packet);
                    if (packet.type === `${kind}-stop` && !host.hang) queueMicrotask(() =>
                        receive({ type: `${kind}-ended`, sessionId: packet.sessionId, exitCode: 0 }));
                },
                kill(signal) { host.signals.push(signal); host.exit(1); },
            };
        },
    });
    return { pools, hosts, traffic };
}

async function until<T>(value: () => T | undefined) {
    for (let attempt = 0; attempt < 150; attempt++) {
        const result = value();
        if (result !== undefined) return result;
        await Bun.sleep(20);
    }
    throw new Error('Expected runtime group transition did not occur.');
}

test('queues Lite starts until readiness, drops cancelled starts, and closes only the selected session', async () => {
    const { pools, hosts } = fakePools(false);
    const messages: unknown[] = [];
    const config = { envFile: 'bot.env', cacheDir: 'cache', receive: (message: unknown) => { messages.push(message); } };
    const cancelled = pools.startLite(alpha, { ...config, bot: 'Cancelled' });
    cancelled.kill('SIGINT');
    expect(await cancelled.exited).toBe(0);
    const first = pools.startLite(alpha, { ...config, bot: 'First' });
    const second = pools.startLite(alpha, { ...config, bot: 'Second', receive: () => {} });
    const host = hosts[0]!;
    expect(host.packets).toEqual([]);
    expect(first.pid).toBe(second.pid);
    host.receive({ type: 'lite-ready' });
    expect(host.packets.map(packet => packet.bot)).toEqual(['First', 'Second']);
    const firstId = host.packets[0]!.sessionId!;
    const secondId = host.packets[1]!.sessionId!;
    expect(firstId).not.toBe(secondId);
    host.receive({ type: 'lite-message', sessionId: firstId, message: 'first-only' });
    host.receive({ type: 'lite-message', sessionId: secondId, message: 'second-only' });
    expect(messages).toEqual(['first-only']);
    first.send({ type: 'inventory-command' });
    expect(host.packets.at(-1)).toMatchObject({ type: 'lite-send', sessionId: firstId });
    expect(pools.monitoredProcesses()).toMatchObject([{ pid: first.pid, groupName: 'Alpha', bots: ['First', 'Second'] }]);
    first.kill('SIGINT');
    expect(await first.exited).toBe(0);
    expect(host.signals).toEqual([]);
    expect(second.exitCode).toBeNull();
    expect(pools.monitoredProcesses()[0]?.bots).toEqual(['Second']);
    host.exit(9);
    expect(await second.exited).toBe(9);
    expect(pools.monitoredProcesses()).toEqual([]);
});

test('preserves SDK virtual exit codes, pipelines, and bidirectional checkpoint IPC', async () => {
    const { pools, hosts } = fakePools(false);
    const messages: unknown[] = [];
    const run = pools.startSdk(alpha, { bot: 'First', script: '/task.ts', cwd: '/', env: { RS_ACTIVITY: 'fixture' },
        receive: message => messages.push(message) });
    const host = hosts[0]!;
    host.receive({ type: 'sdk-ready' });
    const id = host.packets[0]!.sessionId;
    run.send({ type: 'checkpoint' });
    expect(host.packets.at(-1)).toMatchObject({ type: 'sdk-message', sessionId: id });
    host.receive({ type: 'sdk-message', sessionId: id, message: { type: 'ready' } });
    host.receive({ type: 'sdk-stdout', sessionId: id, chunk: 'task evidence\n' });
    host.receive({ type: 'sdk-stderr', sessionId: id, chunk: 'task diagnostic\n' });
    host.receive({ type: 'sdk-ended', sessionId: id, exitCode: 13 });
    expect(messages).toEqual([{ type: 'ready' }]);
    expect(await run.exited).toBe(13);
    expect(run.exitCode).toBe(13);
    expect(await new Response(run.stdout).text()).toBe('task evidence\n');
    expect(await new Response(run.stderr).text()).toBe('task diagnostic\n');
    host.exit(0);
});

function sample(tick: number) {
    return {
        tick, inGame: true, player: { worldX: 3222, worldZ: 3218, level: 0, hp: 10, maxHp: 10, combatLevel: 5, combat: { inCombat: false } },
        skills: [], nearbyNpcs: [], inventory: [], gameMessages: [], opFeedback: {},
    };
}

function fixture() {
    const directory = mkdtempSync(join(process.cwd(), '.runtime-test-'));
    writeFileSync(join(directory, 'bot.env'), 'BOT_USERNAME=Scout\nPASSWORD=fixture\nSERVER=rs-sdk.maxbittker.com\n');
    const token = 'a'.repeat(64);
    let assignment: RuntimeGroup | null = alpha;
    let gameOnline = false;
    const runtime = fakePools();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let blocked = false;
    const readState = Object.assign(async () => {
        if (blocked) { entered.resolve(); await release.promise; }
        return gameOnline ? Response.json({ state: sample(1), stateAge: 0, botStatus: 'active' }) : new Response(null, { status: 404 });
    }, { preconnect: fetch.preconnect });
    const mock = spyOn(globalThis, 'fetch').mockImplementation(readState);
    const worker = dashboardDemo(directory, directory, directory, token, () => {}, { name: 'Scout', directory },
        undefined, undefined, undefined, undefined, { pools: runtime.pools, assignment: () => assignment });
    const request = (body: object = {}) => new Request('http://localhost/test', { method: 'POST',
        headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return {
        ...runtime, worker,
        assign: (group: RuntimeGroup | null) => { assignment = group; },
        online: () => { gameOnline = true; },
        unattendedStart: () => worker.handleActivity(request({ bot: 'Scout', action: 'start', task: 'pickpocket-men' }), token),
        blockState: () => { blocked = true; return { entered: entered.promise, release: release.resolve }; },
        clientStart: () => worker.handle(request(), 'client/start'),
        taskStart: () => worker.handle(request({ task: 'pickpocket-men' }), 'task/start'),
        request,
        async close() {
            release.resolve();
            for (const host of runtime.hosts) host.exit(0);
            await worker.takeOffline().catch(() => {});
            mock.mockRestore();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}

test('moves at the next task launch, pins placement while waiting, and drains task before Lite on offline', async () => {
    const test = fixture();
    try {
        expect((await test.clientStart()).status).toBe(202);
        expect(test.worker.activeGroupId()).toBe(alpha.id);
        test.online();
        test.assign(beta);
        const launch = test.taskStart();
        const moved = await until(() => test.hosts[1]?.packets.find(packet => packet.type === 'lite-start'));
        expect(test.hosts[0]!.packets.map(packet => packet.type)).toEqual(['lite-start', 'lite-stop']);
        const second = test.hosts[1]!;
        const frame = (tick: number) => second.receive({ type: 'lite-message', sessionId: moved.sessionId,
            message: { type: 'fleet-state', at: Date.now(), state: sample(tick) } });
        frame(1);
        await Bun.sleep(300);
        expect(test.hosts).toHaveLength(2);
        test.assign(alpha);
        frame(2);
        expect((await launch).status).toBe(202);
        expect(test.worker.activeGroupId()).toBe(beta.id);
        expect(test.pools.monitoredProcesses().find(process => process.kind === 'task')?.groupName).toBe('Beta');
        await test.worker.takeOffline();
        expect(test.traffic.slice(-2).map(packet => packet.type)).toEqual(['sdk-stop', 'lite-stop']);
        expect(test.worker.activeGroupId()).toBeNull();
        expect(test.hosts.every(host => host.signals.length === 0)).toBe(true);
    } finally { await test.close(); }
});

test('taking a bot offline cancels a pending group migration before its SDK launch', async () => {
    const test = fixture();
    try {
        expect((await test.clientStart()).status).toBe(202);
        test.online();
        test.assign(beta);
        const launch = test.taskStart();
        await until(() => test.hosts[1]?.packets.find(packet => packet.type === 'lite-start'));
        await test.worker.takeOffline();
        expect((await launch).status).toBe(503);
        expect(test.worker.activeGroupId()).toBeNull();
        expect(test.hosts.every(host => host.kind === 'lite' && host.signals.length === 0)).toBe(true);
    } finally { await test.close(); }
});

test('taking a bot offline cancels Fleet Desk startup before a client handle exists', async () => {
    const test = fixture();
    try {
        const pending = test.blockState();
        expect((await test.unattendedStart()).status).toBe(202);
        await pending.entered;
        const stopping = test.worker.takeOffline();
        pending.release();
        await stopping;
        expect(test.hosts).toHaveLength(0);
        expect(test.worker.activeGroupId()).toBeNull();
    } finally { await test.close(); }
});

test('a silent pool stop times out without killing the shared host or releasing session ownership', async () => {
    const test = fixture();
    try {
        expect((await test.clientStart()).status).toBe(202);
        const host = test.hosts[0]!;
        host.hang = true;
        await expect(test.worker.takeOffline()).rejects.toThrow('did not confirm this bot stopped');
        expect(host.packets.slice(-2)).toMatchObject([
            { type: 'lite-stop', force: false }, { type: 'lite-stop', force: true },
        ]);
        expect(host.signals).toEqual([]);
        expect(test.worker.activeGroupId()).toBe(alpha.id);
        expect(() => test.pools.startLite(alpha, { bot: 'Scout', envFile: '', cacheDir: '', receive() {} })).toThrow('already');
    } finally { await test.close(); }
}, 12_000);

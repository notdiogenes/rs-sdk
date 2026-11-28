import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditPrefix } from '../sdk/audit-trace';
import { dashboardAudit } from './dashboard-audit';
import { dashboardDemo } from './dashboard-demo';
import type { RuntimeGroup } from './dashboard-runtime-groups';
import * as workerPolicy from './dashboard-worker-policy';
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
                        receive({ type: `${kind}-ended`, sessionId: packet.sessionId, exitCode: kind === 'sdk' ? 143 : 0 }));
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
        tick, inGame: true, player: { worldX: 3222, worldZ: 3218, level: 0, hp: 10, maxHp: 10, isDead: false, combatLevel: 5, combat: { inCombat: false, lastDamageTick: -1 } },
        modalOpen: false, dialog: { isOpen: false }, interface: { isOpen: false }, bank: { isOpen: false }, shop: { isOpen: false },
        skills: [], nearbyNpcs: [], inventory: [], gameMessages: [], opFeedback: {},
    };
}

function fixture(dedicatedScript?: string) {
    const directory = mkdtempSync(join(process.cwd(), '.runtime-test-'));
    writeFileSync(join(directory, 'bot.env'), 'BOT_USERNAME=Scout\nPASSWORD=fixture\nSERVER=rs-sdk.maxbittker.com\n');
    const token = 'a'.repeat(64);
    let assignment: RuntimeGroup | null = alpha;
    let gameOnline = false;
    let stateAge = 0;
    const runtime = fakePools();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let blocked = false;
    const readState = Object.assign(async () => {
        if (blocked) { entered.resolve(); await release.promise; }
        return gameOnline ? Response.json({ state: sample(1), stateAge, botStatus: 'active' }) : new Response(null, { status: 404 });
    }, { preconnect: fetch.preconnect });
    const mock = spyOn(globalThis, 'fetch').mockImplementation(readState);
    const audit = dedicatedScript ? dashboardAudit(directory) : undefined;
    const pinned: Array<string | undefined> = [];
    const revisions = dedicatedScript && {
        load: async () => ({ revision: pinned.length ? 'next' : 'original', value: workerPolicy }),
        current: () => workerPolicy,
        async pinTask(revision: string | undefined) {
            pinned.push(revision);
            return { path: join(directory, 'task.ts'), revision, sha: 'fixture', async release() {} };
        },
    };
    if (dedicatedScript) writeFileSync(join(directory, 'task.ts'), dedicatedScript);
    const worker = dashboardDemo(directory, directory, directory, token, () => {}, { name: 'Scout', directory },
        audit, undefined, undefined, revisions || undefined, { pools: runtime.pools, assignment: () => assignment });
    const request = (body: object = {}) => new Request('http://localhost/test', { method: 'POST',
        headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return {
        ...runtime, worker, pinned,
        assign: (group: RuntimeGroup | null) => { assignment = group; },
        online: () => { gameOnline = true; },
        setStateAge: (ms: number) => { stateAge = ms; },
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
            audit?.close();
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

async function runStandalone(f: ReturnType<typeof fixture>) {
    expect((await f.clientStart()).status).toBe(202);
    f.online();
    expect((await f.taskStart()).status).toBe(202);
    const host = f.hosts.find(host => host.kind === 'sdk')!;
    const sessionId = (await until(() => host.packets.find(packet => packet.type === 'sdk-start'))).sessionId;
    return { host, sessionId, runId: f.worker.standaloneActivity()!.running.runId };
}

async function publishReplacementClient(f: ReturnType<typeof fixture>) {
    const host = await until(() => f.hosts.filter(host => host.kind === 'lite')[1]);
    const start = await until(() => host.packets.find(packet => packet.type === 'lite-start'));
    const frame = (tick: number) => host.receive({ type: 'lite-message', sessionId: start.sessionId,
        message: { type: 'fleet-state', at: Date.now(), state: sample(tick) } });
    frame(1);
    await Bun.sleep(300);
    frame(2);
}

test('standalone safe moves wait for both a fresh safe state and an accepted checkpoint', async () => {
    const f = fixture();
    try {
        const { host, sessionId, runId } = await runStandalone(f);
        f.assign(beta);
        expect(f.worker.requestStandaloneRelaunch(runId, 'safe', () => true)).toBe('next-launch');
        const send = (message: object) => host.receive({ type: 'sdk-message', sessionId, message });
        send({ type: 'fleet-update-supported' });
        f.setStateAge(5000);
        expect(f.worker.requestStandaloneRelaunch(runId, 'safe', () => true)).toBe('queued');
        const request = host.packets.at(-1)!.message as { type: string; id: string };
        expect(request.type).toBe('fleet-update-request');
        send({ type: 'fleet-update-ready', id: request.id });
        await Bun.sleep(600);
        expect(host.packets.at(-1)!.message).toEqual(request);
        f.setStateAge(0);
        await until(() => host.packets.find(packet =>
            (packet.message as { type?: string })?.type === 'fleet-update-commit'));
        send({ type: 'fleet-update-accepted', id: request.id });
        host.receive({ type: 'sdk-ended', sessionId, exitCode: 0 });
        await publishReplacementClient(f);
        await until(() => f.worker.runtimeTaskGroupId() === beta.id ? true : undefined);
        expect(f.worker.standaloneActivity()?.step.task).toBe('pickpocket-men');
        expect(f.traffic.filter(packet => packet.type === 'sdk-start')).toHaveLength(2);
    } finally { await f.close(); }
});

test('immediate standalone move starts a new run even when the old script does not offer checkpoints', async () => {
    const f = fixture();
    try {
        const { runId } = await runStandalone(f);
        f.assign(beta);
        f.setStateAge(5000);
        expect(f.worker.requestStandaloneRelaunch(runId, 'immediate', () => true)).toBe('relaunching');
        await publishReplacementClient(f);
        await until(() => f.worker.runtimeTaskGroupId() === beta.id ? true : undefined);
        expect(f.worker.standaloneActivity()?.running.runId).not.toBe(runId);
    } finally { await f.close(); }
});

test('a stop during standalone placement wins and a naturally completed run is never replayed', async () => {
    const f = fixture();
    try {
        const { host, sessionId, runId } = await runStandalone(f);
        host.receive({ type: 'sdk-message', sessionId, message: { type: 'fleet-update-supported' } });
        f.assign(beta);
        expect(f.worker.requestStandaloneRelaunch(runId, 'safe', () => true)).toBe('queued');
        host.receive({ type: 'sdk-ended', sessionId, exitCode: 0 });
        await Bun.sleep(600);
        expect(f.worker.standaloneActivity()).toBeUndefined();
        expect(f.traffic.filter(packet => packet.type === 'sdk-start')).toHaveLength(1);

        f.assign(alpha);
        expect((await f.taskStart()).status).toBe(202);
        const next = f.worker.standaloneActivity()!.running.runId;
        f.assign(beta);
        expect(f.worker.requestStandaloneRelaunch(next, 'immediate', () => true)).toBe('relaunching');
        await until(() => f.hosts.filter(host => host.kind === 'lite')[1]?.packets.find(packet => packet.type === 'lite-start'));
        expect((await f.worker.handle(f.request(), 'task/stop')).status).toBe(200);
        await Bun.sleep(300);
        expect(f.worker.standaloneActivity()).toBeUndefined();
        expect(f.traffic.filter(packet => packet.type === 'sdk-start')).toHaveLength(2);
    } finally { await f.close(); }
});

test('changing a pending safe move lets the newer standalone request take priority', async () => {
    const f = fixture();
    try {
        const { host, sessionId, runId } = await runStandalone(f);
        host.receive({ type: 'sdk-message', sessionId, message: { type: 'fleet-update-supported' } });
        f.assign(beta);
        let first = true;
        expect(f.worker.requestStandaloneRelaunch(runId, 'safe', () => first)).toBe('queued');
        first = false;
        expect(f.worker.requestStandaloneRelaunch(runId, 'immediate', () => !first)).toBe('relaunching');
        await publishReplacementClient(f);
        await until(() => f.worker.runtimeTaskGroupId() === beta.id ? true : undefined);
        expect(f.traffic.filter(packet => packet.type === 'sdk-start')).toHaveLength(2);
    } finally { await f.close(); }
});

test('changing only SDK sharing in either direction preserves the Lite PID and the running release', async () => {
    // A real dedicated worker exits cleanly when Fleet Desk signals it.
    const f = fixture(`
        process.on('SIGTERM', () => process.exit(0));
        process.send({ type: 'fleet-update-supported' });
        setInterval(() => {}, 1000);
    `);
    const clientOnly = { ...alpha, mode: 'client' } as const;
    try {
        f.assign(clientOnly);
        expect((await f.clientStart()).status).toBe(202);
        const lite = f.pools.monitoredProcesses().find(process => process.kind === 'client')!;
        f.online();
        expect((await f.taskStart()).status).toBe(202);
        const original = await until(() => {
            const run = f.worker.standaloneActivity()?.running;
            return run?.supported ? run.runId : undefined;
        });
        expect(f.worker.runtimeTaskGroupId()).toBeNull();
        f.assign(alpha);
        expect(f.worker.requestStandaloneRelaunch(original, 'immediate', () => true)).toBe('relaunching');
        const pooled = await until(() => f.worker.runtimeTaskGroupId() === alpha.id ? f.worker.standaloneActivity()?.running : undefined);
        expect(pooled.revision).toBe('original');

        f.assign(clientOnly);
        expect(f.worker.requestStandaloneRelaunch(pooled.runId, 'immediate', () => true)).toBe('relaunching');
        await until(() => f.worker.runtimeTaskGroupId() === null && f.worker.standaloneActivity()?.running.supported ? true : undefined);
        expect(f.pinned).toEqual(['original', 'original', 'original']);
        expect(f.pools.monitoredProcesses().find(row => row.kind === 'client')?.pid).toBe(lite.pid);
        expect(f.traffic.filter(packet => packet.type.startsWith('lite-')).map(packet => packet.type)).toEqual(['lite-start']);
    } finally { await f.close(); }
});

test('a final success flushed during an immediate stop prevents replay of a completed standalone activity', async () => {
    const f = fixture('void 0;');
    try {
        const { host, sessionId, runId } = await runStandalone(f);
        host.hang = true;
        f.assign(beta);
        expect(f.worker.requestStandaloneRelaunch(runId, 'immediate', () => true)).toBe('relaunching');
        host.receive({ type: 'sdk-stdout', sessionId, chunk:
            auditPrefix + JSON.stringify({ kind: 'milestone', name: 'script-finish', outcome: 'complete' }) + '\n' });
        host.receive({ type: 'sdk-ended', sessionId, exitCode: 0 });
        await until(() => f.worker.status('Scout').lastTask?.finishedAt);
        await Bun.sleep(30);
        expect(f.traffic.map(packet => packet.type)).toEqual(['lite-start', 'sdk-start', 'sdk-stop']);
    } finally { await f.close(); }
});

for (const mode of ['safe', 'immediate'] as const) {
    test(`an interrupted standalone run resumes in the latest assignment after a handoff in ${mode} mode`, async () => {
        const f = fixture();
        try {
            const { host, sessionId, runId } = await runStandalone(f);
            host.hang = true;
            const send = (message: object) => host.receive({ type: 'sdk-message', sessionId, message });
            send({ type: 'fleet-update-supported' });
            f.assign(beta);
            let targetCurrent = true;
            f.worker.requestStandaloneRelaunch(runId, mode, () => targetCurrent);
            let checkpointId = '';
            if (mode === 'safe') {
                checkpointId = (host.packets.at(-1)!.message as { id: string }).id;
                send({ type: 'fleet-update-ready', id: checkpointId });
                await until(() => host.packets.find(packet => (packet.message as { type?: string })?.type === 'fleet-update-commit'));
            } else {
                expect(host.packets.at(-1)?.type).toBe('sdk-stop');
            }
            // A later edit cannot leave the old task running anymore.
            // Placement replays must pick up this newer target even if the old
            // stop/checkpoint is still awaiting its exit acknowledgement.
            const gamma = { ...beta, id: 'gamma', name: 'Gamma' };
            targetCurrent = false;
            f.assign(gamma);
            f.worker.requestStandaloneRelaunch(runId, mode, () => true);
            if (mode === 'safe') send({ type: 'fleet-update-accepted', id: checkpointId });
            host.receive({ type: 'sdk-ended', sessionId, exitCode: mode === 'safe' ? 0 : 143 });
            await publishReplacementClient(f);
            await until(() => f.worker.runtimeTaskGroupId() === gamma.id ? true : undefined);
            expect(f.worker.activeGroupId()).toBe(gamma.id);
            expect(f.traffic.filter(packet => packet.type === 'sdk-start')).toHaveLength(2);
        } finally { await f.close(); }
    });
}

test('the real plan backend preserves last-minute bank proof and rejects a stale move run ID', async () => {
    const f = fixture('void 0;');
    try {
        expect((await f.clientStart()).status).toBe(202);
        f.online();
        const backend = f.worker.planBackend('Scout');
        await backend.start('mine-iron-bank', undefined, 5000);
        const runId = backend.activeUpdate()!.runId;
        const host = await until(() => f.hosts.find(host => host.kind === 'sdk'));
        const sessionId = (await until(() => host.packets.find(p => p.type === 'sdk-start'))).sessionId;
        host.hang = true;
        expect(await backend.stopForRuntimeMove('previous-run')).toBe(false);
        expect(host.packets.map(p => p.type)).toEqual(['sdk-start']);
        const done = backend.stopForRuntimeMove(runId);
        expect(host.packets.at(-1)?.type).toBe('sdk-stop');
        host.receive({ type: 'sdk-stdout', sessionId, chunk: auditPrefix + JSON.stringify({
            kind: 'milestone', name: 'mining-bank-target-confirmed', target: 5000, banked: 5000,
        }) + '\n' });
        host.receive({ type: 'sdk-ended', sessionId, exitCode: 0 });
        expect(await done).toBe(true);
        expect(backend.status().lastTask).toMatchObject({ name: 'mine-iron-bank', exitCode: 0, completion: 'bank-stock' });
        expect(await backend.stopForRuntimeMove(runId)).toBe(false);
    } finally { await f.close(); }
});

test('a planned launch follows the newest placement during the Lite login wait', async () => {
    const f = fixture();
    try {
        expect((await f.clientStart()).status).toBe(202);
        f.online();
        f.assign(beta);
        const backend = f.worker.planBackend('Scout');
        const launch = backend.start('pickpocket-men');
        await until(() => f.hosts.filter(host => host.kind === 'lite')[1]?.packets.find(p => p.type === 'lite-start'));
        const gamma = { ...beta, id: 'gamma', name: 'Gamma' };
        f.assign(gamma);
        const target = await until(() => f.hosts.filter(host => host.kind === 'lite')[2]);
        const sessionId = (await until(() => target.packets.find(p => p.type === 'lite-start'))).sessionId;
        for (const tick of [1, 2]) {
            target.receive({ type: 'lite-message', sessionId, message: { type: 'fleet-state', at: Date.now(), state: sample(tick) } });
            if (tick === 1) await Bun.sleep(300);
        }
        await launch;
        expect(f.worker.activeGroupId()).toBe(gamma.id);
        expect(f.worker.runtimeTaskGroupId()).toBe(gamma.id);
        expect(f.traffic.filter(packet => packet.type === 'sdk-start')).toHaveLength(1);
    } finally { await f.close(); }
});

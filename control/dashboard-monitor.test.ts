import { expect, test } from 'bun:test';
import { createDashboardMonitor, downsampleMonitorHistory, parseProcStat, type MonitorProcess, type MonitorSnapshot } from './dashboard-monitor';

test('parses CPU ticks, RSS, and process birth despite spaces and parentheses in comm', () => {
    const fields = Array.from({ length: 24 }, () => '0');
    fields[2] = 'R';
    fields[13] = '123';
    fields[14] = '77';
    fields[21] = '6543';
    fields[23] = '42';
    const stat = () => `321 (controller (bot)) ${fields.slice(2).join(' ')}`;
    expect(parseProcStat(stat())).toEqual({ cpuTicks: 200, startTicks: 6543, rssPages: 42 });
    fields[2] = 'Z';
    expect(parseProcStat(stat())).toBeNull();
    expect(parseProcStat('malformed')).toBeNull();
});

test('keeps endpoints and individual process peaks in a bounded history', () => {
    const common = { kind: 'task' as const, startedAt: '2026-11-27T00:00:00.000Z' };
    const points = Array.from({ length: 7200 }, (_, index) => ({
        at: index * 500,
        processes: [
            { ...common, bot: 'Atlas', pid: 10, rssBytes: index === 1511 ? 500 : 10, cpuPercent: index === 2541 ? 85 : 3 },
            { ...common, bot: 'Scout', pid: 11, rssBytes: index === 4962 ? 200 : 20, cpuPercent: index === 6891 ? 45 : 2 },
        ],
    }));
    const sampled = downsampleMonitorHistory(points);
    const indexes = sampled.map(point => point.at / 500);
    expect(sampled.length).toBeLessThanOrEqual(240);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(indexes[0]).toBe(0);
    expect(indexes.at(-1)).toBe(7199);
    for (const index of [1511, 2541, 4962, 6891]) expect(indexes).toContain(index);
});

test.skipIf(process.platform !== 'linux')('samples a live subprocess and ignores missing or reused descriptors', async () => {
    const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 60_000)'], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    });
    const live = { kind: 'task', bot: 'Atlas', pid: child.pid, startedAt: new Date().toISOString() } satisfies MonitorProcess;
    const reused = { ...live, bot: 'Scout', startedAt: new Date(Date.now() - 60_000).toISOString() };
    const missing = { ...live, kind: 'client' as const, pid: 2 ** 31 - 1 };
    const monitor = createDashboardMonitor(() => [live, reused, missing]);

    async function waitFor(condition: (snapshot: MonitorSnapshot) => boolean) {
        for (let attempt = 0; attempt < 300; attempt++) {
            const snapshot = monitor.read();
            if (condition(snapshot)) return snapshot;
            await Bun.sleep(10);
        }
        throw new Error('Timed out waiting for a resource sample.');
    }

    try {
        expect(monitor.read()).toMatchObject({ sampledAt: null, processes: [], history: [] });
        monitor.start();
        const first = await waitFor(value => value.sampledAt !== null);
        expect(first.processes[0]?.cpuPercent).toBeNull();
        expect(first.processes[0]!.rssBytes).toBeGreaterThan(0);
        expect(first.processes[1]).toMatchObject({ rssBytes: null, cpuPercent: null });
        expect(first.processes[2]).toMatchObject({ rssBytes: null, cpuPercent: null });
        const second = await waitFor(value => value.processes[0]?.cpuPercent != null);
        expect(second.processes[0]!.cpuPercent).toBeGreaterThanOrEqual(0);
        expect(second.history.length).toBeGreaterThanOrEqual(2);
        expect(monitor.read(0).history).toEqual([]);
        child.kill();
        await child.exited;
        const third = await waitFor(value => value.processes[0]?.rssBytes === null);
        expect(third.processes[0]).toMatchObject({ rssBytes: null, cpuPercent: null });
    } finally {
        monitor.stop();
        if (child.exitCode === null) child.kill();
        await child.exited;
    }
});

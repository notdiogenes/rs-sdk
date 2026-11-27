import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dashboardAudit } from './dashboard-audit';

test('groups matching breakpoints and preserves bounded evidence beyond trace eviction', () => {
    const directory = mkdtempSync(join(process.cwd(), '.audit-test-'));
    let now = 1_800_000_000_000;
    const audit = dashboardAudit(directory, () => now);
    try {
        for (const bot of ['A Pirate', 'Scout']) {
            const run = audit.begin(bot, 'witchs-house', 'revision-a', 'script-a', ['unique-secret']);
            audit.append(run, { kind: 'phase', name: 'quest-execution' });
            audit.append(run, { kind: 'check', name: 'floor-change', outcome: 'unconfirmed', destination: { plane: 1 } });
            audit.append(run, { kind: 'check', name: 'state-observation', outcome: 'timeout' });
            audit.append(run, { kind: 'failure', name: 'script-finish', message: 'Climb failed token=unique-secret',
                stack: ['    at changeFloor (/srv/rs-sdk/control/tasks/quests/shared.ts:62:11)'] });
            audit.append(run, { kind: 'failure', name: 'quest-failed', error: 'Duplicate summary' });
            audit.finish(run, 1, false);
            now += 500;
        }
        const summary = audit.read(new URLSearchParams('mode=summary&days=35'));
        expect(summary?.breakpoints).toEqual([expect.objectContaining({
            task: 'witchs-house', phase: 'quest-execution', step: 'floor-change', runs: 2, bots: 2,
            site: 'control/tasks/quests/shared.ts:62:11', example_message: 'Climb failed token=[redacted]',
        })]);
        const latest = audit.read(new URLSearchParams('mode=runs&limit=1'));
        const older = audit.read(new URLSearchParams(`mode=runs&limit=1&before=${latest?.nextBefore}`));
        expect(latest?.runs).toEqual([expect.objectContaining({ bot: 'Scout' })]);
        expect(older?.runs).toEqual([expect.objectContaining({ bot: 'A Pirate' })]);
        const id = latest?.runs?.[0]?.id;
        if (!id) throw new Error('Expected a stored run');
        const page = audit.read(new URLSearchParams(`run=${id}&limit=2`));
        expect(page?.events?.map(event => event.name)).toEqual(['script-finish', 'quest-failed']);
        expect(page?.nextBefore).toBeNumber();
        const storage = new Database(join(directory, 'activity-audit.sqlite'));
        storage.exec('DELETE FROM audit_events');
        storage.close();
        const evidence = audit.read(new URLSearchParams(`run=${id}`));
        expect(evidence?.events).toEqual([]);
        expect(evidence?.failureEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'floor-change' })]));
        expect(JSON.stringify(evidence)).not.toContain('unique-secret');
        expect(audit.read(new URLSearchParams(`run=${id}&bot=Other`))).toBeNull();
        expect(() => audit.read(new URLSearchParams('days=36'))).toThrow('Invalid days');
        now += 36 * 86_400_000;
        audit.prune();
        expect(audit.read(new URLSearchParams(`run=${id}`))).toBeNull();
    } finally {
        audit.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('reports garden catches and crossings even when the terminal failure is in the shed', () => {
    const directory = mkdtempSync(join(process.cwd(), '.audit-test-'));
    let now = 1_800_000_000_000;
    const audit = dashboardAudit(directory, () => now);
    try {
        for (const code of [0, 1]) {
            const run = audit.begin(code ? 'Scout' : 'A Pirate', 'witchs-house', 'revision-a', 'script-a', []);
            audit.append(run, { kind: 'phase', name: 'garden-crossing', strategy: 'direct-waypoints' });
            audit.append(run, { kind: 'milestone', name: 'garden-attempt' });
            audit.append(run, { kind: 'setback', name: 'witch-caught' });
            audit.append(run, { kind: 'milestone', name: 'garden-attempt' });
            now += 12_000;
            audit.append(run, { kind: 'milestone', name: 'garden-crossed' });
            audit.append(run, { kind: 'phase', name: 'shed-fight' });
            if (code) audit.append(run, { kind: 'failure', name: 'script-finish', message: 'Fight did not yield the ball' });
            audit.finish(run, code, false);
        }
        const report = audit.read(new URLSearchParams('mode=summary&phase=garden-crossing'));
        expect(report?.totals).toEqual(expect.arrayContaining([
            expect.objectContaining({ run_outcome: 'before-failure', duration_ms: 12_000, setbacks: 1, strategy: 'direct-waypoints' }),
            expect.objectContaining({ run_outcome: 'succeeded', duration_ms: 12_000, setbacks: 1 }),
        ]));
        expect(report?.signals).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'witch-caught', kind: 'setback', count: 2, in_successful_runs: 1, before_later_failure: 1 }),
            expect.objectContaining({ name: 'garden-crossed', kind: 'milestone', count: 2, before_later_failure: 1 }),
        ]));
        expect(audit.read(new URLSearchParams('mode=summary'))?.breakpoints).toEqual([
            expect.objectContaining({ phase: 'shed-fight', runs: 1 }),
        ]);
        audit.close();
        const reopened = dashboardAudit(directory, () => now);
        try {
            expect(reopened.read(new URLSearchParams('mode=summary&phase=garden-crossing'))).toEqual(report);
        } finally {
            reopened.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

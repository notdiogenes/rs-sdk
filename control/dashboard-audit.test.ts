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

test('keeps thieving success, stun costs, and live phase time for an ongoing grind', () => {
    const directory = mkdtempSync(join(process.cwd(), '.audit-test-'));
    let now = 1_800_000_000_000;
    const audit = dashboardAudit(directory, () => now);
    try {
        const run = audit.begin('Scout', 'pickpocket-knights', 'revision-a', 'script-a', []);
        audit.append(run, { kind: 'phase', name: 'thieving-pickpocket', strategy: 'nearest-reachable' });
        audit.append(run, { kind: 'milestone', name: 'pickpocket-attempt-succeeded', elapsedMs: 1200, xpGained: 80, coinsGained: 50 });
        now += 6000;
        audit.append(run, { kind: 'milestone', name: 'pickpocket-attempt-succeeded', elapsedMs: 1800, xpGained: 80, coinsGained: 50 });
        let summary = audit.read(new URLSearchParams('mode=summary&task=pickpocket-knights'));
        expect(summary?.totals).toContainEqual(expect.objectContaining({ phase: 'thieving-pickpocket', run_outcome: 'running', duration_ms: 6000 }));

        audit.append(run, { kind: 'setback', name: 'pickpocket-attempt-stunned', elapsedMs: 2000, hpLost: 3,
            target: { index: 32 }, feedback: [{ tick: 12, text: 'You fail to pick the pocket.' }] });
        audit.append(run, { kind: 'phase', name: 'thieving-banking' });
        audit.append(run, { kind: 'failure', name: 'script-finish', message: 'Banking failed' });
        audit.finish(run, 1, false);
        summary = audit.read(new URLSearchParams('mode=summary&task=pickpocket-knights'));
        expect(summary?.signals).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'pickpocket-attempt-succeeded', count: 2, elapsed_ms: 3000, xp_gained: 160, coins_gained: 100, before_later_failure: 2 }),
            expect.objectContaining({ name: 'pickpocket-attempt-stunned', count: 1, elapsed_ms: 2000, hp_lost: 3, before_later_failure: 1 }),
        ]));
        expect(summary?.breakpoints).toContainEqual(expect.objectContaining({ phase: 'thieving-banking' }));
        const detail = audit.read(new URLSearchParams(`run=${run}`));
        expect(detail?.signals).toContainEqual(expect.objectContaining({ name: 'pickpocket-attempt-stunned',
            evidence: expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ target: { index: 32 } }) })]) }));
    } finally {
        audit.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('keeps a pickpocket intent, dispatch, and outcome linked in the live trace and preserved failure evidence', () => {
    const directory = mkdtempSync(join(process.cwd(), '.audit-test-'));
    const audit = dashboardAudit(directory);
    try {
        const run = audit.begin('Scout', 'pickpocket-knights', 'revision-a', 'script-a', []);
        audit.append(run, { kind: 'phase', name: 'thieving-pickpocket' });
        const intent = 'Gain Thieving XP from the selected reachable knight';
        audit.append(run, { kind: 'intent', name: 'pickpocket-npc', operationId: 7, intent, outcome: 'pending' });
        audit.append(run, { kind: 'action', name: 'interactNpc', operationId: 7, intent, outcome: 'dispatched' });
        audit.append(run, { kind: 'intent', name: 'wait-ticks', operationId: 8, parentOperationId: 7,
            intent: 'Give delayed game feedback time to arrive', outcome: 'pending' });
        audit.append(run, { kind: 'result', name: 'wait-ticks', operationId: 8, outcome: 'elapsed' });
        audit.append(run, { kind: 'setback', name: 'pickpocket-attempt-not-started', operationId: 7, intent, outcome: 'not-started' });
        audit.append(run, { kind: 'result', name: 'pickpocket-npc', operationId: 7, intent, outcome: 'not-started' });
        const params = new URLSearchParams(`run=${run}`);
        const live = audit.read(params);
        expect(live?.events?.filter(event => event.data.operationId === 7).map(event => event.data.outcome))
            .toEqual(['pending', 'dispatched', 'not-started', 'not-started']);
        expect(live?.events?.find(event => event.kind === 'intent' && event.data.operationId === 8)?.data.parentOperationId).toBe(7);
        expect(live?.signals).toContainEqual(expect.objectContaining({
            evidence: expect.arrayContaining([expect.objectContaining({
                data: expect.objectContaining({ operationId: 7, intent, outcome: 'not-started' }),
            })]),
        }));
        audit.finish(run, 1, false);
        expect(audit.read(params)?.failureEvidence).toContainEqual(expect.objectContaining({
            kind: 'result',
            data: expect.objectContaining({ operationId: 7, intent, outcome: 'not-started' }),
        }));
    } finally {
        audit.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

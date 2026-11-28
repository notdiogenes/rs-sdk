import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardAudit as recordDashboardAudit } from './dashboard-audit';
import { auditDashboardLocation, readDashboardAudit } from './dashboard-audit-report';
import { dashboardPresentation } from './dashboard-presentation';
import { fleetPage } from './dashboard-fleet-page';
import { pickpocketActiveLabels } from './dashboard-pickpocket-activity';
import type { Bot } from './public-status';
import { dashboardWebHandler } from './dashboard-web';
import { dashboardSessions } from './dashboard-session';

function dashboardAudit(directory: string, clock = Date.now) {
    const writer = recordDashboardAudit(directory, clock);
    const db = new Database(join(directory, 'activity-audit.sqlite'), { readonly: true });
    return {
        ...writer,
        read: (params: URLSearchParams) => readDashboardAudit(db, clock(), params),
        close() {
            db.close();
            writer.close();
        },
    };
}

test('restarts the Fleet Desk web listener while the Unix supervisor keeps recording the same run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-web-'));
    const socket = join(directory, 'worker.sock');
    const recording = recordDashboardAudit(directory);
    const reports = new Database(join(directory, 'activity-audit.sqlite'), { readonly: true });
    const run = recording.begin('Scout', 'pickpocket-knights', null, null, []);
    const cookie = '__Secure-rs-sdk-dashboard=fixture';
    const supervisor = Bun.serve({
        unix: socket,
        fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === '/internal/fleet-snapshot') {
                return Response.json({ bots: [], checkedAt: new Date().toISOString() });
            }
            if (request.headers.get('Cookie') !== cookie) return new Response(null, { status: 401 });
            if (url.pathname === '/internal/audit-access') {
                return new Response(null, { status: 204, headers: { 'Set-Cookie': cookie } });
            }
            if (url.pathname === '/bots/activity' && url.searchParams.get('view') === 'inventory') {
                return Response.json({ availability: 'live', items: [{ id: 995, slot: 0, name: 'Coins', count: 50 }] },
                    { headers: { 'Set-Cookie': cookie } });
            }
            return new Response(null, { status: 404 });
        },
    });
    const startWeb = () => Bun.serve({
        port: 0, hostname: '127.0.0.1',
        fetch: dashboardWebHandler(request => fetch(request, { unix: socket, redirect: 'manual' }),
            async () => ({ revision: 'fixture', fleetStyle: '', controls: '', fleetPage, auditDashboardLocation, readDashboardAudit }),
            () => reports, []),
    });
    let web = startWeb();
    const request = (path: string, options?: RequestInit) => fetch(new URL(path, web.url), options);
    try {
        expect((await request('/bots')).status).toBe(200);
        expect((await request('/internal/fleet-snapshot')).status).toBe(404);
        expect((await request('/bots/activity?view=inventory')).status).toBe(401);
        const inventory = await request('/bots/activity?view=inventory', { headers: { Cookie: cookie } });
        expect(inventory.headers.get('Set-Cookie')).toBe(cookie);
        expect(await inventory.json()).toMatchObject({ items: [{ id: 995, spriteUrl: 'https://rs-sdk.maxbittker.com/sprite/item/995.png' }] });

        await web.stop(true);
        recording.append(run, { kind: 'milestone', name: 'pickpocket-attempt-succeeded', xpGained: 50 });
        web = startWeb();
        const audit = await request(`/bots/activity?view=audit&run=${run}`, { headers: { Cookie: cookie } });
        expect(audit.headers.get('Set-Cookie')).toBe(cookie);
        expect(await audit.json()).toMatchObject({
            run: { id: run, status: 'running' },
            signals: [expect.objectContaining({ name: 'pickpocket-attempt-succeeded', count: 1 })],
        });
    } finally {
        await web.stop(true);
        await supervisor.stop(true);
        reports.close();
        recording.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('renders named task activity with its own timestamp and ignores reports from another run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-activity-'));
    let now = Date.parse('2026-11-27T23:20:00Z');
    const recording = recordDashboardAudit(directory, () => now);
    const reports = new Database(join(directory, 'activity-audit.sqlite'), { readonly: true });
    const run = recording.begin('Scout', 'mine-coal-bank', null, null, ['test-secret']);
    const bot: Bot = {
        name: 'Scout', status: 'Online', activity: 'Mine and bank coal', location: 'X 2635, Z 3381 · Plane 0',
        lastActivity: { at: new Date(now).toISOString(), reason: 'Moved' },
        control: { bot: 'Scout', running: true, startedAt: new Date(now).toISOString() },
    };
    const handle = dashboardWebHandler(
        async () => Response.json({ bots: [bot], checkedAt: new Date(now).toISOString() }),
        async () => ({ revision: 'fixture', fleetStyle: '', controls: '', fleetPage, auditDashboardLocation, readDashboardAudit }),
        () => reports, [],
    );
    const render = async () => (await handle(new Request('https://fleet.test/bots'))).text();
    try {
        expect(await render()).toContain('Moved to X 2635, Z 3381');
        now += 120_000;
        bot.control!.waiting = 'Recovering HP · resumes at 40 HP';
        const recovering = await render();
        expect(recovering).toContain('data-name="Scout" data-status="idle"');
        expect(recovering).toContain('<span>Current activity</span><strong>Recovering HP · resumes at 40 HP</strong>');
        expect(recovering).not.toContain('class="reason"');
        expect(recovering).not.toContain('Moved to X 2635, Z 3381');
        expect(recovering).toContain('<dt>Last Action</dt><dd class="">2m</dd>');
        recording.append(run, { kind: 'task-event', name: 'fleet-activity', label: 'Restocking food' });
        expect(await render()).toContain('<span>Current activity</span><strong>Restocking food</strong>');
        delete bot.control!.waiting;
        recording.append(run, { kind: 'task-event', name: 'fleet-activity', label: 'Walking to Fishing Guild Bank' });
        const page = await render();
        expect(page).toContain('<span>Last activity</span><time datetime="2026-11-27T23:22:00.000Z">Nov 27, 2026, 6:22 PM EST</time><strong>Walking to Fishing Guild Bank</strong>');
        expect(page).toContain('<dt>Elapsed</dt><dd class="elapsed-value">2m</dd>');
        expect(page).toContain('<dt>Last Action</dt><dd class="">2m</dd>');
        recording.append(run, { kind: 'task-event', name: 'fleet-activity', label: 'Walking to test-secret' });
        expect(await render()).not.toContain('Walking to test-secret');
        expect(await render()).not.toContain('Walking to [redacted]');
        now += 1000;
        const fishingRun = recording.begin('Scout', 'fish-sharks-cook', null, null, []);
        recording.append(run, { kind: 'task-event', name: 'fleet-activity', label: 'Moving to a new coal rock' });
        expect(await render()).toContain('Moved to X 2635, Z 3381');
        expect(await render()).not.toContain('Moving to a new coal rock');

        bot.activity = 'Fish sharks and cook them';
        bot.control = { bot: bot.name, label: bot.activity, running: true, transitioning: true };
        const starting = await render();
        expect(starting).toContain('<span>Current activity</span><strong>Starting activity - Fish sharks and cook them</strong>');
        expect(starting).not.toContain('Moved to X 2635, Z 3381');
        bot.control = { ...bot.control, transitioning: false, startedAt: new Date(now).toISOString() };
        expect(await render()).toContain('<span>Current activity</span><strong>Waiting for fishing activity details</strong>');
        recording.append(fishingRun, { kind: 'task-event', name: 'fleet-activity', label: 'Cooking sharks at the Catherby range' });
        expect(await render()).toContain('<strong>Cooking sharks at the Catherby range</strong>');

        now += 1000;
        const runecraftRun = recording.begin('Scout', 'craft-body-runes', null, null, []);
        bot.activity = 'Craft Body runes';
        bot.control = { bot: bot.name, label: bot.activity, running: true, startedAt: new Date(now).toISOString() };
        const preparing = await render();
        expect(preparing).toContain('<span>Current activity</span><strong>Waiting for runecrafting activity details</strong>');
        expect(preparing).not.toContain('Moved to X 2635, Z 3381');
        recording.append(runecraftRun, { kind: 'task-event', name: 'fleet-activity', label: 'Crafting Body runes at the Body altar' });
        expect(await render()).toContain('<strong>Crafting Body runes at the Body altar</strong>');
    } finally {
        reports.close();
        recording.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('shows active pickpocket recovery work as Running and passive recovery as Idle', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-pickpocket-activity-'));
    let now = Date.parse('2026-11-27T23:20:00Z');
    const recording = recordDashboardAudit(directory, () => now);
    const reports = new Database(join(directory, 'activity-audit.sqlite'), { readonly: true });
    const run = recording.begin('Scout', 'pickpocket-heroes', null, null, []);
    const waiting = 'Recovering HP · resumes at 40 HP';
    const bot: Bot = {
        name: 'Scout', status: 'Online', activity: 'Pickpocket Heroes',
        lastActivity: { at: new Date(now).toISOString(), reason: 'Moved' },
        control: { bot: 'Scout', running: true, startedAt: new Date(now).toISOString(), waiting },
    };
    const handle = dashboardWebHandler(
        async () => Response.json({ bots: [bot], checkedAt: new Date(now).toISOString() }),
        async () => ({ revision: 'fixture', fleetStyle: '', controls: '', fleetPage, auditDashboardLocation, readDashboardAudit }),
        () => reports, [],
    );
    const render = async () => (await handle(new Request('https://fleet.test/bots'))).text();
    const report = (label: string) => recording.append(run, { kind: 'task-event', name: 'fleet-activity', label });
    try {
        now += 3 * 60_000;
        for (const label of Object.values(pickpocketActiveLabels)) {
            report(label);
            const page = await render();
            expect(page).toContain('data-name="Scout" data-status="active"');
            expect(page).toContain(`<span>Current activity</span><strong>${label}</strong>`);
        }

        now += 2 * 60_000;
        bot.lastActivity = { at: new Date(now).toISOString(), reason: 'Moved' };
        expect(await render()).toContain('data-name="Scout" data-status="idle"');

        report(pickpocketActiveLabels.bank);
        now += 2 * 60_000;
        const stale = await render();
        expect(stale).toContain('data-name="Scout" data-status="idle"');
        expect(stale).toContain(`<span>Current activity</span><strong>${waiting}</strong>`);

        // Movement supports a longer banking trip, but a new wait report supersedes it.
        bot.lastActivity = { at: new Date(now).toISOString(), reason: 'Moved' };
        expect(await render()).toContain('data-name="Scout" data-status="active"');
        delete bot.control!.waiting;
        report('Waiting to recover to 40 HP');
        const resting = await render();
        expect(resting).toContain('data-name="Scout" data-status="idle"');
        expect(resting).toContain('<span>Current activity</span><strong>Waiting to recover to 40 HP</strong>');
    } finally {
        reports.close();
        recording.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('requests a sample newer than the timestamp displayed by the Fleet page', async () => {
    const checkedAt = '2026-11-27T23:20:00.000Z';
    const requests: string[] = [];
    const handle = dashboardWebHandler(async request => {
        requests.push(new URL(request.url).search);
        return Response.json({ bots: [], checkedAt });
    }, async () => ({ revision: 'fixture', fleetStyle: '', controls: '', fleetPage, auditDashboardLocation, readDashboardAudit }),
    () => { throw new Error('No activity data to look up'); }, []);
    const url = 'https://fleet.test/bots';
    const after = Date.parse(checkedAt);
    const initial = await handle(new Request(url));
    expect(await initial.text()).toContain(`<time datetime="${checkedAt}">`);
    expect((await handle(new Request(`${url}?snapshotAfter=${after}`))).status).toBe(200);
    expect((await handle(new Request(url, { method: 'HEAD' }))).status).toBe(200);
    expect(requests).toEqual(['?fresh=1', `?after=${after}`, '']);
});

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
        const operation = audit.read(new URLSearchParams(`run=${run}&operation=7&event=unrelated&kind=failure`));
        expect(operation?.events?.map(event => event.name))
            .toEqual(['pickpocket-npc', 'interactNpc', 'wait-ticks', 'wait-ticks', 'pickpocket-attempt-not-started', 'pickpocket-npc']);
        expect(operation?.matchingEvents).toBe(6);
        const matched = audit.read(new URLSearchParams(`run=${run}&event=pickpocket-attempt-not-started&kind=setback&limit=1`));
        expect(matched?.events?.map(event => event.name)).toEqual(['pickpocket-attempt-not-started']);
        expect(matched?.nextBefore).toBeNull();
        expect(() => audit.read(new URLSearchParams(`run=${run}&operation=0`))).toThrow('Invalid operation');
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

test('reports whole-activity rates and splits durable trend time at Eastern midnight', () => {
    const directory = mkdtempSync(join(process.cwd(), '.audit-test-'));
    let now = Date.parse('2026-11-01T03:59:50Z');
    const audit = dashboardAudit(directory, () => now);
    try {
        const run = audit.begin('Scout', 'pickpocket-knights', '123abcde', 'script-a', []);
        audit.append(run, { kind: 'phase', name: 'thieving-search' });
        now += 5_000;
        audit.append(run, { kind: 'setback', name: 'thieving-target-unavailable' });
        now += 10_000;
        audit.append(run, { kind: 'phase', name: 'thieving-pickpocket' });
        now += 5_000;
        audit.append(run, { kind: 'milestone', name: 'pickpocket-attempt-succeeded', elapsedMs: 5000, xpGained: 100, coinsGained: 20 });
        audit.append(run, { kind: 'setback', name: 'pickpocket-attempt-stunned' });
        audit.finish(run, 0, false);

        const params = new URLSearchParams('mode=insights&task=pickpocket-knights&bot=Scout&revision=123abcd&limit=1');
        const report = audit.read(params);
        if (!report || !('sample' in report)) throw new Error('Expected Insights report');
        expect(report.sample).toMatchObject({ runs: 1, bots: 1 });
        expect(report.durationMs).toBe(20_000);
        expect(report.phases[0]).toMatchObject({ phase: 'thieving-search', duration_ms: 15_000, share: 0.75, run_id: run });
        expect(report.pickpocket).toEqual({ count: 2, successes: 1, successRate: 0.5 });
        expect(report.throughput).toMatchObject({ xpPerHour: 18000, coinsPerHour: 3600 });
        expect(report.trend.days).toEqual([
            expect.objectContaining({ date: '2026-10-31', duration_ms: 10_000, attempts: 0, setbacks: 1 }),
            expect.objectContaining({ date: '2026-11-01', duration_ms: 10_000, attempts: 2, successes: 1, xp: 100 }),
        ]);
        const database = new Database(join(directory, 'activity-audit.sqlite'));
        database.exec('DELETE FROM audit_events');
        database.close();
        expect(audit.read(params)).toEqual({
            ...report,
            attempts: report.attempts.map(row => ({ ...row, trace_run_id: null })),
            setbacks: report.setbacks.map(row => ({ ...(row as object), trace_run_id: null })),
        });
        expect(audit.read(new URLSearchParams('mode=insights&task=pickpocket-knights&phase=thieving-pickpocket')))
            .toMatchObject({ throughput: { xp: 100, xpPerHour: null } });
        expect(audit.read(new URLSearchParams('mode=insights&task=pickpocket-knights&revision=abcdef0')))
            .toMatchObject({ sample: { runs: 0 }, trend: { days: [] } });
    } finally {
        audit.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('compares two revisions in the same scope and retains links only to matching evidence', () => {
    const directory = mkdtempSync(join(process.cwd(), '.audit-test-'));
    let now = 1_800_000_000_000;
    const audit = dashboardAudit(directory, () => now);
    try {
        const old = audit.begin('Scout', 'pickpocket-knights', 'abcdef0', null, []);
        audit.append(old, { kind: 'setback', name: 'pickpocket-attempt-timeout', elapsedMs: 1000 });
        now += 5000;
        audit.finish(old, 0, false);
        const current = audit.begin('Scout', 'pickpocket-knights', '123abcd', null, []);
        audit.append(current, { kind: 'milestone', name: 'pickpocket-attempt-succeeded', elapsedMs: 100, xpGained: 50 });
        now += 5000;
        audit.finish(current, 0, false);
        const other = audit.begin('Other', 'pickpocket-knights', '123abcd', null, []);
        audit.append(other, { kind: 'setback', name: 'pickpocket-attempt-timeout', elapsedMs: 1000 });

        const params = new URLSearchParams('mode=insights&task=pickpocket-knights&bot=Scout&revision=123abcd&baseline=abcdef0');
        expect(audit.read(params)).toMatchObject({
            sample: { runs: 1 }, attempts: [{ name: 'pickpocket-attempt-succeeded', trace_run_id: current }],
            revisions: [{ revision: '123abcd', runs: 1 }, { revision: 'abcdef0', runs: 1 }],
            baseline: { sample: { runs: 1 }, attempts: [{ name: 'pickpocket-attempt-timeout', trace_run_id: old }] },
        });
        params.set('baseline', '123abcd0');
        expect(() => audit.read(params)).toThrow('Invalid baseline');
    } finally {
        audit.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('reloads a committed Fleet Desk presentation while the same audit writer keeps a run active', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.audit-test-'));
    const source = join(directory, 'control');
    mkdirSync(source);
    const git = (...args: string[]) => {
        const result = Bun.spawnSync(['git', '-c', 'user.name=Fleet Desk test', '-c', 'user.email=fleet@example.test',
            '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory });
        if (!result.success) throw new Error(result.stderr.toString());
    };
    const audit = dashboardAudit(directory);
    const reports = new Database(join(directory, 'activity-audit.sqlite'), { readonly: true });
    try {
        for (const file of [
            'dashboard-presentation-entry.ts', 'dashboard-fleet-page.ts', 'dashboard-fleet-icons.ts', 'dashboard-fleet.css',
            'public-status-controls.js', 'dashboard-fleet-stats.ts', 'dashboard-quests.ts', 'dashboard-task-catalog.ts', 'mining-routes.ts',
            'dashboard-audit-report.ts', 'dashboard-audit-insights-report.ts', 'dashboard-audit-schema.ts', 'bank-locations.ts',
            'dashboard-pickpocket-activity.ts',
        ]) copyFileSync(join(import.meta.dir, file), join(source, file));
        git('init', '-q');
        git('add', 'control');
        git('commit', '-qm', 'First presentation');

        const run = audit.begin('Scout', 'pickpocket-knights', null, null, []);
        audit.append(run, { kind: 'phase', name: 'thieving-pickpocket' });
        const fixture = dashboardPresentation(source, directory);
        const inputs = { nonce: 'fixture', questCatalog: [], refreshSeconds: 15, displayTimeZone: 'America/New_York' };
        const first = await fixture();
        expect(first.fleetPage({ ...inputs, ...first })).toContain('Activity audit');
        expect(first.readDashboardAudit(reports, Date.now(), new URLSearchParams(`run=${run}`))).toMatchObject({
            run: { status: 'running' },
        });

        writeFileSync(join(source, 'dashboard-fleet.css'), '/* second presentation */');
        writeFileSync(join(source, 'public-status-controls.js'), '/* second controls */');
        const template = join(source, 'dashboard-fleet-page.ts');
        writeFileSync(template, readFileSync(template, 'utf8').replace('Activity audit</h2>', 'Updated audit</h2>'));
        expect(await fixture()).toBe(first);
        git('add', 'control');
        git('commit', '-qm', 'Update presentation');
        writeFileSync(join(source, 'public-status-controls.js'), '/* uncommitted edit */');

        const second = await fixture();
        expect(second.revision).not.toBe(first.revision);
        expect(second.fleetPage({ ...inputs, ...second })).toContain('Updated audit');
        expect(second.fleetStyle).toBe('/* second presentation */');
        expect(second.controls).toBe('/* second controls */');
        audit.append(run, { kind: 'milestone', name: 'pickpocket-attempt-succeeded', xpGained: 50 });
        expect(second.readDashboardAudit(reports, Date.now(), new URLSearchParams(`run=${run}`))).toMatchObject({
            run: { status: 'running' }, signals: [expect.objectContaining({ name: 'pickpocket-attempt-succeeded', count: 1 })],
        });
    } finally {
        reports.close();
        audit.close();
        rmSync(directory, { recursive: true, force: true });
    }
}, 15_000);

test('password login for audits permits an API client and preserves browser origin checks', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.audit-test-'));
    const origin = 'https://127-0-0-1.sslip.io';
    const password = 'local-audit-fixture';
    try {
        const hash = await Bun.password.hash(password, { algorithm: 'argon2id' });
        await Bun.write(join(directory, 'password.json'), JSON.stringify({ hash, origin }));
        const sessions = dashboardSessions(directory, async () => origin, join(directory, 'enrollment.json'));
        const request = (originHeader?: string) => new Request(origin + '/bots/activity?view=audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(originHeader ? { Origin: originHeader } : {}) },
            body: JSON.stringify({ password }),
        });
        expect((await sessions.handle(request(), 'login')).status).toBe(403);
        expect((await sessions.handle(request('https://other.example'), 'login', { programmatic: true })).status).toBe(403);
        const success = await sessions.handle(request(), 'login', { programmatic: true });
        expect(success.status).toBe(200);
        const cookie = success.headers.get('Set-Cookie');
        expect(cookie).toMatch(/HttpOnly/);
        if (!cookie) throw new Error('Expected a dashboard session');
        const read = new Request(origin + '/bots/activity?view=audit', { headers: { Cookie: cookie.split(';')[0]! } });
        expect(await sessions.authenticate(read)).toBe(cookie);
        expect((await sessions.handle(request(origin), 'login')).status).toBe(429);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

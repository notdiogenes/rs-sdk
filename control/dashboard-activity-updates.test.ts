import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BotWorldState } from '../sdk/types';
import { handleActivityUpdates } from './dashboard-activity-updates';
import { parseSteps, type Step } from './dashboard-plan';
import { createPlanManager, type Plan, type PlanBackend } from './dashboard-plan-runner';
import { taskUpdateChannel, type ActiveTaskUpdate } from './dashboard-task-update';
import * as builtInPolicy from './dashboard-worker-policy';

const oldRelease = { revision: 'a'.repeat(40), value: builtInPolicy };
const newRelease = { revision: 'b'.repeat(40), value: builtInPolicy };

function activityPlan(bot: string, task: string, status: Plan['status'] = 'running'): Plan {
    return {
        bot, revision: `plan:${bot}`, index: 0, elapsedMs: 0, status,
        steps: parseSteps([{ task, finish: { type: 'forever' } }]),
    };
}

test('reports affected runs and settings conflicts, and schedules only compatible live checkpoints in bulk', async () => {
    const miner = activityPlan('Miner', 'mine-adamantite-bank');
    const fisher = activityPlan('Fisher', 'fish-sharks-cook');
    const manual = activityPlan('Manual', 'mine-tin-bank');
    const queued = activityPlan('Queued', 'pickpocket-heroes', 'paused');
    const red = activityPlan('Red miner', 'mine-iron-bank');
    const incompatible = { configurationVersion: 99 };
    Object.assign(queued.steps[0]!, incompatible, { options: { banking: true } });
    Object.assign(red.steps[0]!, incompatible);
    const plans = [miner, fisher, manual, queued, red];
    const waiting = new Set<string>();
    const calls: Array<{ bot: string; index: number; planRevision: string; runId: string; mode: string }> = [];
    const manager: Parameters<typeof handleActivityUpdates>[1] = {
        list: () => plans,
        activeUpdate: bot => ({
            running: bot === queued.bot ? undefined : { runId: `run:${bot}`, revision: oldRelease.revision, supported: bot !== manual.bot },
            waiting: waiting.has(bot),
            message: undefined,
        }),
        requestUpdate(bot, index, planRevision, runId, release, mode) {
            expect(release).toBe(newRelease);
            calls.push({ bot, index, planRevision, runId, mode });
            waiting.add(bot);
        },
        cancelUpdate(bot) { waiting.delete(bot); },
    };
    const source = {
        async load() { return newRelease; },
        async changedPaths() { return ['control/tasks/mine-resources.ts']; },
    };
    const request = (body?: object) => handleActivityUpdates(
        new Request('https://fleet.test/bots/activity?view=updates', body && { method: 'POST', body: JSON.stringify(body) }),
        manager, source,
    );

    const initial = await request();
    expect(initial.status).toBe(200);
    const { revision, rows } = await initial.json();
    expect(revision).toBe(newRelease.revision);
    expect(rows).toMatchObject([
        { bot: miner.bot, status: 'available', state: 'running', checkpoint: 'supported', fromRevision: oldRelease.revision },
        { bot: fisher.bot, status: 'current', state: 'running' },
        { bot: manual.bot, status: 'available', state: 'running', checkpoint: 'unsupported' },
        { bot: queued.bot, status: 'review', state: 'queued', settings: { ...incompatible, options: { banking: true } } },
        { bot: red.bot, status: 'review', state: 'running' },
    ]);

    const bulk = await request({ action: 'compatible', revision });
    expect(bulk.status).toBe(202);
    expect(await bulk.json()).toMatchObject({ scheduled: 1, rows: [{ checkpoint: 'waiting' }, {}, {}, {}, {}] });
    expect(calls).toEqual([{ bot: miner.bot, index: 0, planRevision: miner.revision, runId: `run:${miner.bot}`, mode: 'safe' }]);

    const perRun = { action: 'request', revision, bot: miner.bot, index: 0, planRevision: miner.revision, runId: `run:${miner.bot}` };
    for (const change of [{ revision: oldRelease.revision }, { planRevision: 'stale' }, { runId: 'stale' }, { index: 1 }]) {
        expect((await request({ ...perRun, ...change })).status).toBe(409);
    }
    expect((await request({
        ...perRun, bot: red.bot, planRevision: red.revision, runId: `run:${red.bot}`,
    })).status).toBe(409);
    expect(calls).toHaveLength(1);
    expect((await request({ ...perRun, action: 'cancel' })).status).toBe(202);
    expect((await request(perRun)).status).toBe(202);
    expect(calls).toHaveLength(2);
});

async function waitUntil(check: () => boolean) {
    const deadline = Date.now() + 7_000;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for plan progress.');
        await Bun.sleep(25);
    }
}

test('holds an incompatible queued step at launch and keeps its saved settings for review', async () => {
    const scratch = mkdtempSync(join(process.cwd(), '.plan-update-test-'));
    const bot = 'Scout';
    const step = { ...activityPlan(bot, 'pickpocket-men').steps[0]!, configurationVersion: 99, options: { banking: true } } as const;
    const game = { tick: 0, inGame: true, player: { worldX: 3222, worldZ: 3222, level: 0 }, skills: [] } as unknown as BotWorldState;
    const status: ReturnType<PlanBackend['status']> = { bot, tasks: [], client: null, task: null };
    let launches = 0;
    const manager = createPlanManager(scratch, async () => ({
        status: () => status,
        async prepare() { status.client = { startedAt: new Date().toISOString(), stopping: false }; },
        async observe() { game.tick++; return game; },
        async start() { launches++; },
        async stop() {},
    }), { async load() { return newRelease; }, current: () => builtInPolicy });
    try {
        manager.start(bot, [step]);
        await waitUntil(() => manager.get(bot)?.status === 'blocked');
        expect(launches).toBe(0);
        expect(manager.get(bot)).toMatchObject({ status: 'blocked', index: 0, steps: [step] });
        expect(manager.get(bot)!.message).toContain('Review this step');
    } finally {
        await manager.pause(bot);
        manager.close();
        rmSync(scratch, { recursive: true, force: true });
    }
}, 10_000);

test('a compatible relaunch waits for safety and child exit, then preserves the client, step, progress and settings', async () => {
    const scratch = mkdtempSync(join(process.cwd(), '.plan-update-test-'));
    const bot = 'Scout';
    const game = { tick: 0, inGame: true, player: { worldX: 3222, worldZ: 3222, level: 0 }, skills: [] } as unknown as BotWorldState;
    const status: ReturnType<PlanBackend['status']> = { bot, tasks: [], client: null, task: null };
    const started: Array<{ revision?: string; options?: Step['options']; elapsedMs: number }> = [];
    const sent: Array<{ type: string; id: string }> = [];
    const channel = taskUpdateChannel(command => { sent.push(command); });
    let taskRun: Pick<ActiveTaskUpdate, 'runId' | 'revision'> | undefined;
    let safe = false;
    let stops = 0;
    const backend: PlanBackend = {
        status: () => status,
        async prepare() { status.client = { startedAt: new Date().toISOString(), stopping: false }; },
        async observe() { game.tick++; return game; },
        async start(task, _skill, _target, options, release) {
            expect(status.task).toBeNull();
            started.push({ revision: release?.revision, options, elapsedMs: manager.get(bot)!.elapsedMs });
            status.task = { name: task, startedAt: new Date().toISOString(), stopping: false };
            status.lastTask = null;
            taskRun = { runId: `run:${started.length}`, revision: release?.revision };
        },
        async stop() { stops++; status.task = null; taskRun = undefined; },
        activeUpdate: () => taskRun && { ...taskRun, ...channel.state() },
        safeForUpdate: () => safe,
        requestCheckpoint: (_run, id) => channel.request(id),
        commitCheckpoint: (_run, id) => channel.commit(id),
        cancelCheckpoint: () => channel.cancel(),
    };
    const manager = createPlanManager(scratch, async () => backend, {
        async load() { return oldRelease; },
        current: () => builtInPolicy,
    });
    const steps = parseSteps([
        { task: 'pickpocket-men', finish: { type: 'minutes', minutes: 30 }, options: { banking: true } },
        { task: 'fish-sharks-cook', finish: { type: 'forever' } },
    ]);
    try {
        manager.start(bot, steps);
        await waitUntil(() => started.length === 1);
        channel.receive({ type: 'fleet-update-supported' });
        const client = status.client;
        const revision = manager.get(bot)!.revision;
        expect(() => manager.requestUpdate(bot, 0, revision, 'run:1', newRelease, 'now')).toThrow('outside combat');
        manager.requestUpdate(bot, 0, revision, 'run:1', newRelease, 'safe');
        await waitUntil(() => sent.length === 1);
        const id = sent[0]!.id;
        expect(sent[0]).toEqual({ type: 'fleet-update-request', id });
        channel.receive({ type: 'fleet-update-ready', id });

        const readyTick = game.tick;
        await waitUntil(() => game.tick > readyTick);
        expect(sent).toHaveLength(1);
        expect(started).toHaveLength(1);
        expect(stops).toBe(0);
        expect(manager.activeUpdate(bot).waiting).toBe(true);

        safe = true;
        await waitUntil(() => sent.length === 2);
        expect(sent[1]).toEqual({ type: 'fleet-update-commit', id });
        channel.receive({ type: 'fleet-update-accepted', id });
        const acceptedTick = game.tick;
        await waitUntil(() => game.tick > acceptedTick);
        expect(started).toHaveLength(1);
        expect(stops).toBe(0);
        const elapsed = manager.get(bot)!.elapsedMs;
        expect(elapsed).toBeGreaterThan(0);

        status.task = null;
        taskRun = undefined;
        status.lastTask = { name: steps[0]!.task, exitCode: 0, finishedAt: new Date().toISOString(), updateId: id };
        await waitUntil(() => started.length === 2);
        expect(started).toEqual([
            { revision: oldRelease.revision, options: { banking: true }, elapsedMs: 0 },
            { revision: newRelease.revision, options: { banking: true }, elapsedMs: elapsed },
        ]);
        expect(manager.get(bot)).toMatchObject({ status: 'running', index: 0, revision, steps, elapsedMs: elapsed });
        expect(manager.activeUpdate(bot).waiting).toBe(false);
        expect(status.client).toBe(client);
        expect(stops).toBe(0);
    } finally {
        await manager.pause(bot);
        manager.close();
        rmSync(scratch, { recursive: true, force: true });
    }
}, 24_000);

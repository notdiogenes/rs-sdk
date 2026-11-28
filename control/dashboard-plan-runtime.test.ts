import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BotWorldState } from '../sdk/types';
import { parseSteps } from './dashboard-plan';
import { createPlanManager, type PlanBackend } from './dashboard-plan-runner';
import { taskUpdateChannel } from './dashboard-task-update';
import * as builtInPolicy from './dashboard-worker-policy';

const bot = 'Scout';
const originalRelease = { revision: 'runtime-original', value: builtInPolicy };
const laterRelease = { revision: 'unrelated-code-update', value: builtInPolicy };

async function until(check: () => boolean, waitMs = 8000) {
    const deadline = Date.now() + waitMs;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the plan transition.');
        await Bun.sleep(20);
    }
}

function fixture() {
    const directory = mkdtempSync(join(process.cwd(), '.plan-runtime-test-'));
    const status: ReturnType<PlanBackend['status']> = { bot, tasks: [], client: null, task: null };
    const game = { tick: 0, inGame: true, player: { worldX: 3222, worldZ: 3222, level: 0 }, skills: [] } as unknown as BotWorldState;
    const settings = {
        safe: false, group: 'dedicated', fresh: true, release: originalRelease,
        stopGate: undefined as Promise<void> | undefined,
        completion: undefined as NonNullable<typeof status.lastTask>['completion'],
    };
    const started: Array<{ task: string; group: string; revision?: string; elapsedMs: number }> = [];
    const messages: Array<{ type: string; id: string }> = [];
    const channel = taskUpdateChannel(command => messages.push(command));
    let stopped = 0;
    let manualStops = 0;
    let stopping = false;
    let maskLastTask = false;

    function end(extra: Partial<NonNullable<typeof status.lastTask>> = {}) {
        if (!status.task) return;
        status.lastTask = { name: status.task.name, exitCode: 0, finishedAt: new Date().toISOString(), ...extra };
        status.task = null;
    }

    async function stop(runtime: boolean) {
        if (!runtime) {
            manualStops++;
            maskLastTask = true;
        }
        if (stopping) throw new Error('Another demo command is in progress');
        stopped++;
        stopping = true;
        if (status.task) status.task.stopping = true;
        try {
            await settings.stopGate;
            end(runtime && settings.completion ? { completion: settings.completion } : { exitCode: 143 });
        } finally { stopping = false; }
    }

    const backend: PlanBackend = {
        status: () => maskLastTask ? { ...status, lastTask: null } : status,
        async prepare() { status.client = { startedAt: new Date().toISOString(), stopping: false }; },
        async observe() { game.tick++; return settings.fresh ? game : null; },
        async start(task, _skill, _target, _options, release) {
            expect(status.task).toBeNull();
            started.push({ task, group: settings.group, revision: release?.revision, elapsedMs: manager.get(bot)!.elapsedMs });
            status.task = { name: task, startedAt: new Date().toISOString(), stopping: false };
            status.lastTask = null;
            maskLastTask = false;
        },
        stop: () => stop(false),
        async stopForRuntimeMove(runId) {
            if (!status.task || runId !== `run:${started.length}`) return false;
            await stop(true);
            return true;
        },
        activeUpdate: () => status.task && !status.task.stopping
            ? { runId: `run:${started.length}`, ...channel.state() } : undefined,
        safeForUpdate: () => settings.safe,
        requestCheckpoint: (_run, id) => channel.request(id),
        commitCheckpoint: (_run, id) => channel.commit(id),
        cancelCheckpoint: () => channel.cancel(),
    };
    const manager = createPlanManager(directory, async () => backend, {
        async load() { return settings.release; },
        current: () => builtInPolicy,
    });
    return {
        status, game, manager, started, settings, channel, messages, end,
        stopped: () => stopped, manualStops: () => manualStops,
        async close() {
            settings.stopGate = undefined;
            await manager.pause(bot);
            manager.close();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}

test('a safe group move re-arms on reassignment and keeps task release and credited time', async () => {
    const run = fixture();
    try {
        run.manager.start(bot, parseSteps([{ task: 'pickpocket-men', finish: { type: 'minutes', minutes: 40 } }]));
        await until(() => run.started.length === 1);
        expect(run.manager.requestRuntimeMove(bot, 'run:1', 'safe', () => true)).toBe('next-launch');
        run.channel.receive({ type: 'fleet-update-supported' });
        const { index, revision } = run.manager.get(bot)!;
        expect(run.manager.requestRuntimeMove(bot, 'old-run', 'safe', () => true)).toBe('next-launch');

        run.settings.group = 'first';
        expect(run.manager.requestRuntimeMove(bot, 'run:1', 'safe', () => run.settings.group === 'first')).toBe('queued');
        await until(() => run.messages.length === 1);
        const oldId = run.messages[0]!.id;
        run.settings.group = 'second';
        expect(run.manager.requestRuntimeMove(bot, 'run:1', 'safe', () => run.settings.group === 'second')).toBe('queued');
        expect(run.messages[1]).toEqual({ type: 'fleet-update-cancel', id: oldId });
        await until(() => run.messages.length === 3);
        const id = run.messages[2]!.id;
        expect(id).not.toBe(oldId);
        run.channel.receive({ type: 'fleet-update-ready', id });
        const previous = run.game.tick;
        await until(() => run.game.tick > previous);
        expect(run.messages).toHaveLength(3);
        expect(run.started).toHaveLength(1);
        expect(run.manager.activeUpdate(bot).waiting).toBe(false);

        run.settings.safe = true;
        await until(() => run.messages.length === 4);
        expect(run.messages[3]).toEqual({ type: 'fleet-update-commit', id });
        run.channel.receive({ type: 'fleet-update-accepted', id });
        const elapsedMs = run.manager.get(bot)!.elapsedMs;
        run.settings.release = laterRelease;
        run.end({ updateId: id });
        expect(() => run.manager.update(bot,
            parseSteps([{ task: 'pickpocket-men', finish: { type: 'minutes', minutes: 41 } }]), revision)).toThrow('switching');
        await until(() => run.started.length === 2);
        expect(run.started[1]).toEqual({ task: 'pickpocket-men', group: 'second', revision: originalRelease.revision, elapsedMs });
        expect(run.manager.get(bot)).toMatchObject({ status: 'running', index, revision, elapsedMs });
        expect(run.stopped()).toBe(0);
    } finally { await run.close(); }
}, 26_000);

test('an immediate group move stops without fresh or safe state and starts exactly one replacement', async () => {
    const run = fixture();
    const gate = Promise.withResolvers<void>();
    try {
        run.manager.start(bot, parseSteps([{ task: 'pickpocket-men', finish: { type: 'minutes', minutes: 40 } }]));
        await until(() => (run.manager.get(bot)?.elapsedMs ?? 0) > 0);
        const { index, revision, elapsedMs } = run.manager.get(bot)!;
        run.settings.fresh = false;
        run.settings.stopGate = gate.promise;
        run.settings.group = 'new';
        expect(run.manager.requestRuntimeMove(bot, 'run:1', 'immediate', () => true)).toBe('relaunching');
        await until(() => run.stopped() === 1, 1000);
        expect(run.started).toHaveLength(1);
        expect(run.messages).toEqual([]);
        gate.resolve();
        run.settings.stopGate = undefined;
        run.settings.release = laterRelease;
        await until(() => run.started.length === 2);
        expect(run.stopped()).toBe(1);
        expect(run.started[1]).toEqual({ task: 'pickpocket-men', group: 'new', revision: originalRelease.revision, elapsedMs });
        expect(run.manager.get(bot)).toMatchObject({ status: 'running', index, revision, elapsedMs });
    } finally { gate.resolve(); await run.close(); }
}, 17_000);

test('a natural completed step launches the next step in the selected group instead of relaunching old work', async () => {
    const run = fixture();
    try {
        run.manager.start(bot, parseSteps([
            { task: 'mine-iron-bank', finish: { type: 'bank-stock', quantity: 20 } },
            { task: 'pickpocket-men', finish: { type: 'forever' } },
        ]));
        await until(() => run.started.length === 1);
        run.channel.receive({ type: 'fleet-update-supported' });
        run.settings.group = 'new';
        expect(run.manager.requestRuntimeMove(bot, 'run:1', 'safe', () => true)).toBe('queued');
        run.end({ completion: 'bank-stock' });
        await until(() => run.started.length === 2);
        expect(run.started.map(({ task, group }) => [task, group])).toEqual([
            ['mine-iron-bank', 'dedicated'], ['pickpocket-men', 'new'],
        ]);
        expect(run.manager.get(bot)?.index).toBe(1);
        expect(run.stopped()).toBe(0);
    } finally { await run.close(); }
}, 14_000);

const bankPlan = () => parseSteps([
    { task: 'mine-iron-bank', finish: { type: 'bank-stock', quantity: 20 } },
    { task: 'pickpocket-men', finish: { type: 'forever' } },
]);

test('bank completion drained by an immediate runtime stop is visible and advances the plan', async () => {
    const run = fixture();
    try {
        run.manager.start(bot, bankPlan());
        await until(() => run.started.length === 1);
        run.settings.completion = 'bank-stock';
        run.settings.group = 'new';
        expect(run.manager.requestRuntimeMove(bot, 'run:1', 'immediate', () => true)).toBe('relaunching');
        await until(() => run.started.length === 2);
        expect(run.started[1]).toMatchObject({ task: 'pickpocket-men', group: 'new' });
        expect(run.manager.get(bot)).toMatchObject({ status: 'running', index: 1 });
        expect(run.manualStops()).toBe(0);
    } finally { await run.close(); }
}, 14_000);

test('pause drains the in-flight runtime stop without a second stop or replaying completed work', async () => {
    const run = fixture();
    const gate = Promise.withResolvers<void>();
    try {
        run.manager.start(bot, bankPlan());
        await until(() => run.started.length === 1);
        run.settings.completion = 'bank-stock';
        run.settings.group = 'new';
        run.settings.stopGate = gate.promise;
        expect(run.manager.requestRuntimeMove(bot, 'run:1', 'immediate', () => true)).toBe('relaunching');
        await until(() => run.stopped() > 0);
        const paused = run.manager.pause(bot);
        // Give the scheduler a chance to process the pause while stop is busy.
        await Bun.sleep(2600);
        expect(run.manualStops()).toBe(0);
        expect(run.started).toHaveLength(1);
        gate.resolve();
        expect(await paused).toMatchObject({ status: 'paused', index: 1 });
        expect(run.stopped()).toBe(1);
        expect(run.started).toHaveLength(1);
    } finally { gate.resolve(); await run.close(); }
}, 13_000);

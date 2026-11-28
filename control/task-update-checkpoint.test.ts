import { expect, test } from 'bun:test';
import type { BotWorldState } from '../sdk/types';
import { isSafeTaskUpdateState } from './task-update-safety';
import { createTaskUpdateCheckpoint, TaskUpdateAccepted } from './tasks/update-checkpoint';

function state() {
    return {
        inGame: true, tick: 10, modalOpen: false,
        player: { hp: 19, maxHp: 20, isDead: false, worldX: 3200, worldZ: 3201, level: 0, lifeId: 1,
            combat: { inCombat: false, lastDamageTick: -1 } },
        dialog: { isOpen: false }, interface: { isOpen: false }, bank: { isOpen: false }, shop: { isOpen: false },
    } as BotWorldState;
}

function fixture() {
    const current = state();
    const stateListeners = new Set<() => void>();
    let receive: (message: unknown) => void = () => {};
    const messages: Array<{ type: string; id?: string }> = [];
    const checkpoint = createTaskUpdateCheckpoint({
        getState: () => current,
        getStateAge: () => 30,
        onStateUpdate(listener) {
            const publish = () => listener(current);
            stateListeners.add(publish);
            return () => { stateListeners.delete(publish); };
        },
    }, {
        send(message) { messages.push(message); return true; },
        subscribe(listener) { receive = listener; return () => { receive = () => {}; }; },
    });
    return {
        current, checkpoint, messages, stateListeners,
        parent(type: string, id = 'revision-1') { receive({ type: 'fleet-update-' + type, id }); },
        update() { for (const listener of stateListeners) listener(); },
    };
}

test('checks fresh, recovered and closed game state before offering an update', () => {
    const baseline = state();
    expect(isSafeTaskUpdateState(baseline, 1_000)).toBe(true);
    expect(isSafeTaskUpdateState(baseline, 3_000)).toBe(false);
    const player = baseline.player!;
    for (const change of [{ hp: 8 }, { isDead: true },
        { combat: { ...player.combat, lastDamageTick: 8 } },
        { combat: { ...player.combat, inCombat: true } }]) {
        expect(isSafeTaskUpdateState({ ...baseline, player: { ...player, ...change } }, 1_000)).toBe(false);
    }
    for (const key of ['bank', 'shop', 'dialog', 'interface', 'trade', 'ge'] as const) {
        expect(isSafeTaskUpdateState({ ...baseline, [key]: { isOpen: true } }, 1_000)).toBe(false);
    }
});

test('holds a checkpoint until commit and a newer game tick', async () => {
    const run = fixture();
    run.parent('request');
    const stop = run.checkpoint.atBoundary();
    void stop.catch(() => {});
    expect(run.messages).toEqual([{ type: 'fleet-update-supported' }, { type: 'fleet-update-ready', id: 'revision-1' }]);
    run.parent('commit', 'wrong-revision');
    run.update();
    run.parent('commit');
    expect(run.messages).toHaveLength(2);
    run.current.tick++;
    run.update();
    await expect(stop).rejects.toBeInstanceOf(TaskUpdateAccepted);
    expect(run.messages.at(-1)).toEqual({ type: 'fleet-update-accepted', id: 'revision-1' });
    expect(run.stateListeners.size).toBe(0);
    run.checkpoint.close();
});

test('revokes a held point when combat or movement resumes and ignores the old commit', async () => {
    const run = fixture();
    run.parent('request');
    const refused = run.checkpoint.atBoundary();
    run.current.player!.combat.inCombat = true;
    run.update();
    await refused;
    expect(run.messages.at(-1)).toEqual({ type: 'fleet-update-revoked', id: 'revision-1' });
    run.parent('commit');
    run.current.player!.combat.inCombat = false;
    await run.checkpoint.atBoundary();
    expect(run.messages).toHaveLength(3);

    run.parent('request', 'revision-2');
    const moved = run.checkpoint.atBoundary();
    run.current.player!.worldX++;
    run.update();
    await moved;
    expect(run.messages.at(-1)).toEqual({ type: 'fleet-update-revoked', id: 'revision-2' });
    run.checkpoint.close();
});

test('a cancelled update lets the task continue', async () => {
    const run = fixture();
    run.parent('request');
    const cancelled = run.checkpoint.atBoundary();
    run.parent('cancel');
    await cancelled;
    expect(run.messages).toHaveLength(2);
    expect(run.stateListeners.size).toBe(0);
    run.checkpoint.close();
});

test('gives recent combat damage time to settle before announcing a checkpoint', async () => {
    const run = fixture();
    run.current.player!.combat.lastDamageTick = 9;
    run.parent('request');
    const stop = run.checkpoint.atBoundary();
    void stop.catch(() => {});
    run.parent('commit');
    expect(run.messages).toHaveLength(1);
    run.current.tick = 12;
    run.update();
    expect(run.messages.at(-1)).toEqual({ type: 'fleet-update-ready', id: 'revision-1' });
    run.current.tick = 13;
    run.update();
    expect(run.messages).toHaveLength(2);
    run.parent('commit');
    await expect(stop).rejects.toBeInstanceOf(TaskUpdateAccepted);
    run.checkpoint.close();
});

test('an accepted Bun IPC checkpoint lets the script wrapper exit successfully', async () => {
    const messages: string[] = [];
    const program = `
        import { withTaskUpdateCheckpoints } from ${JSON.stringify(new URL('./tasks/update-checkpoint.ts', import.meta.url).pathname)};
        const state = ${JSON.stringify(state())};
        const listeners = new Set();
        const clock = setInterval(() => {
            state.tick++;
            for (const publish of listeners) publish(state);
        }, 15);
        const sdk = {
            getState: () => state,
            getStateAge: () => 0,
            onStateUpdate(publish) {
                listeners.add(publish);
                return () => listeners.delete(publish);
            },
        };
        try {
            await withTaskUpdateCheckpoints(async (_, checkpoint) => {
                while (true) {
                    await checkpoint();
                    await Bun.sleep(15);
                }
            })({ sdk });
        } finally { clearInterval(clock); }
    `;
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', program], {
        stdout: 'ignore', stderr: 'inherit',
        ipc(value, subprocess) {
            const message = value as { type: string; id?: string };
            messages.push(message.type);
            if (message.type === 'fleet-update-supported') subprocess.send({ type: 'fleet-update-request', id: 'upgrade' });
            if (message.type === 'fleet-update-ready') subprocess.send({ type: 'fleet-update-commit', id: message.id });
        },
    });
    const timeout = setTimeout(() => child.kill(), 2_000);
    try {
        expect(await child.exited).toBe(0);
        expect(messages).toEqual(['fleet-update-supported', 'fleet-update-ready', 'fleet-update-accepted']);
    } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill();
    }
});

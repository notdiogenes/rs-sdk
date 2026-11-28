import { executionWait } from '../../sdk/execution-context';
import type { ScriptContext, ScriptFunction } from '../../sdk/runner';
import { classifyTaskUpdateSafety } from '../task-update-safety';

export type TaskCheckpoint = () => Promise<void>;
type StateSource = Pick<ScriptContext['sdk'], 'getState' | 'getStateAge' | 'onStateUpdate'>;
type Reply =
    | { type: 'fleet-update-supported' }
    | { type: 'fleet-update-ready' | 'fleet-update-revoked' | 'fleet-update-accepted'; id: string };
type Channel = {
    send(message: Reply): boolean;
    subscribe(listener: (message: unknown) => void): () => void;
};

export class TaskUpdateAccepted extends Error {
    constructor() {
        super('Fleet Desk accepted a safe update checkpoint.');
    }
}

export function createTaskUpdateCheckpoint(sdk: StateSource, channel: Channel, holdMs = 5_000) {
    let pending: string | undefined;
    let hold: { commit(): void; cancel(): void } | undefined;
    const unsubscribe = channel.subscribe(message => {
        if (!message || typeof message !== 'object' || !('type' in message) || !('id' in message) ||
            typeof message.id !== 'string' || !message.id || message.id.length > 128) return;
        if (message.type === 'fleet-update-request') {
            pending ??= message.id;
        } else if (message.id === pending) {
            if (message.type === 'fleet-update-commit') hold?.commit();
            if (message.type === 'fleet-update-cancel') {
                pending = undefined;
                hold?.cancel();
            }
        }
    });
    channel.send({ type: 'fleet-update-supported' });

    async function atBoundary() {
        const id = pending;
        const start = sdk.getState();
        const player = start?.player;
        if (!id || !start || !player || classifyTaskUpdateSafety(start, sdk.getStateAge()) === 'unsafe') return;
        const readyId = id;
        const startTick = start.tick;
        const { lifeId, level, worldX, worldZ, hp } = player;

        const accepted = await executionWait<boolean>(resolve => {
            let committed = false;
            let finished = false;
            let readyTick: number | undefined;
            function finish(outcome: 'accepted' | 'revoked' | 'cancelled' | 'retry') {
                if (finished) return;
                finished = true;
                if (outcome !== 'retry' && pending === id) pending = undefined;
                if (outcome === 'accepted') {
                    resolve(channel.send({ type: 'fleet-update-accepted', id: readyId }));
                } else {
                    if (outcome === 'revoked') channel.send({ type: 'fleet-update-revoked', id: readyId });
                    resolve(false);
                }
            }
            function verify() {
                const state = sdk.getState();
                const after = state?.player;
                const safety = classifyTaskUpdateSafety(state, sdk.getStateAge());
                if (!state || !after || state.tick < startTick || safety === 'unsafe' || after.lifeId !== lifeId ||
                    after.level !== level || after.worldX !== worldX || after.worldZ !== worldZ || after.hp < hp) {
                    finish(readyTick === undefined ? 'retry' : 'revoked');
                    return;
                }
                if (safety === 'recovering') {
                    if (readyTick !== undefined) finish('revoked');
                    return;
                }
                if (readyTick === undefined) {
                    readyTick = state.tick;
                    clearTimeout(timer);
                    timer = setTimeout(() => finish('revoked'), holdMs);
                    if (!channel.send({ type: 'fleet-update-ready', id: readyId })) finish('cancelled');
                } else if (committed && state.tick > readyTick) {
                    finish('accepted');
                }
            }
            const offState = sdk.onStateUpdate(verify);
            let timer = setTimeout(() => finish('retry'), holdMs);
            hold = {
                commit() {
                    if (readyTick === undefined) return;
                    committed = true;
                    verify();
                },
                cancel() { finish('cancelled'); },
            };
            verify();
            return () => {
                offState();
                clearTimeout(timer);
                hold = undefined;
            };
        });
        if (accepted) throw new TaskUpdateAccepted();
    }

    return { atBoundary, close: unsubscribe };
}

export function withTaskUpdateCheckpoints(script: (context: ScriptContext, checkpoint?: TaskCheckpoint) => Promise<unknown>): ScriptFunction {
    return async context => {
        if (typeof process.send !== 'function' || !process.connected) return script(context);
        const checkpoint = createTaskUpdateCheckpoint(context.sdk, {
            send(message) {
                if (!process.connected) return false;
                try {
                    process.send!(message);
                    return true;
                } catch {
                    return false;
                }
            },
            subscribe(listener) {
                process.on('message', listener);
                return () => process.off('message', listener);
            },
        });
        try {
            return await script(context, checkpoint.atBoundary);
        } catch (error) {
            if (!(error instanceof TaskUpdateAccepted)) throw error;
        } finally {
            checkpoint.close();
            process.channel?.unref();
        }
    };
}

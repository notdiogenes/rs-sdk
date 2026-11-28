type Command = { type: 'fleet-update-request' | 'fleet-update-cancel' | 'fleet-update-commit'; id: string };
type Checkpoint = { id: string; phase: 'waiting' | 'ready' | 'committed' | 'accepted' };

export type ActiveTaskUpdate = {
    runId: string;
    revision?: string;
    script?: string;
    supported: boolean;
    checkpoint?: Checkpoint;
};

export function taskUpdateChannel(send: (command: Command) => void) {
    let supported = false;
    let checkpoint: Checkpoint | undefined;

    function receive(message: unknown) {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type === 'fleet-update-supported') {
            supported = true;
            return;
        }
        if (!checkpoint || !('id' in message) || message.id !== checkpoint.id) return;
        if (message.type === 'fleet-update-ready' && checkpoint.phase === 'waiting') {
            checkpoint = { ...checkpoint, phase: 'ready' };
        } else if (message.type === 'fleet-update-revoked' && checkpoint.phase !== 'accepted') {
            checkpoint = undefined;
        } else if (message.type === 'fleet-update-accepted' && checkpoint.phase === 'committed') {
            checkpoint = { ...checkpoint, phase: 'accepted' };
        }
    }

    function cancel() {
        if (!checkpoint || checkpoint.phase === 'accepted') return;
        const { id } = checkpoint;
        checkpoint = undefined;
        try { send({ type: 'fleet-update-cancel', id }); }
        catch { /* A task that exited cannot still be waiting. */ }
    }

    return {
        receive,
        state: () => ({ supported, checkpoint }),
        request(id: string) {
            if (!supported || checkpoint) return false;
            checkpoint = { id, phase: 'waiting' };
            try { send({ type: 'fleet-update-request', id }); }
            catch { checkpoint = undefined; return false; }
            return true;
        },
        commit(id: string) {
            if (checkpoint?.id !== id || checkpoint.phase !== 'ready') return;
            checkpoint = { ...checkpoint, phase: 'committed' };
            try { send({ type: 'fleet-update-commit', id }); }
            catch { checkpoint = undefined; }
        },
        cancel,
    };
}

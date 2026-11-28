import { inventoryOption, inventoryReplyTimeoutMs, type InventoryCommand, type InventoryReply, type InventoryRequest, type InventoryResult } from '../sdk/inventory-command';
import type { InventoryItem } from '../sdk/types';

export function inventoryControls() {
    let ready = false;
    let pending: { requestId: string; finish: (result: InventoryResult) => void } | undefined;

    function receive(message: unknown) {
        if (!message || typeof message !== 'object') return;
        if ('type' in message && message.type === 'inventory-ready') ready = true;
        const { type, requestId, result } = message as Partial<InventoryReply>;
        if (type === 'inventory-result' && pending && requestId === pending.requestId && result) pending.finish(result);
    }

    function disconnect() {
        ready = false;
        pending?.finish({ status: 503, message: 'The game client disconnected. Check the inventory before retrying.' });
    }

    function send(client: Pick<Bun.Subprocess, 'exitCode' | 'send'>, command: InventoryCommand): Promise<InventoryResult> {
        if (!ready || client.exitCode !== null) {
            return Promise.resolve({ status: 409, message: 'Inventory controls are unavailable for this game client.' });
        }
        if (pending) return Promise.resolve({ status: 409, message: 'An inventory action is already in progress.' });
        return new Promise(resolve => {
            const requestId = crypto.randomUUID();
            const timer = setTimeout(() => pending?.finish({
                status: 503, message: 'The game client did not confirm the action. Check the inventory before retrying.',
            }), inventoryReplyTimeoutMs);
            pending = { requestId, finish: result => {
                clearTimeout(timer);
                pending = undefined;
                resolve(result);
            } };
            try {
                const message: InventoryRequest = { type: 'inventory-command', requestId, command };
                client.send(message);
            } catch {
                disconnect();
            }
        });
    }

    return { available: () => ready, receive, disconnect, send };
}

export function inventoryItems(items: InventoryItem[]) {
    return items.map(item => {
        const { id, slot, name, count } = item;
        return { id, slot, name, count, canEat: Boolean(inventoryOption(item, 'eat')), canDrop: Boolean(inventoryOption(item, 'drop')) };
    }).sort((a, b) => a.slot - b.slot);
}

export function inventoryActionResponse(result: InventoryResult) {
    const body = result.status === 200
        ? { message: result.message, inventory: { ...result.inventory, items: inventoryItems(result.inventory.items) } }
        : { error: result.message };
    return Response.json(body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}

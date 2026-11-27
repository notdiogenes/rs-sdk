import type { BotAction, InventoryItem } from './types';

export type InventoryCommand = { action: 'eat' | 'drop'; slot: number; id: number; count: number };
export type InventoryResult =
    | { status: 200; message: string; inventory: { capturedAt: number; items: InventoryItem[] } }
    | { status: 409 | 422 | 503; message: string };
export type InventoryRequest = { type: 'inventory-command'; requestId: string; command: InventoryCommand };
export type InventoryReply = { type: 'inventory-result'; requestId: string; result: InventoryResult };
export const inventoryReplyTimeoutMs = 6500;

export function parseInventoryCommand(value: unknown): InventoryCommand | null {
    if (!value || typeof value !== 'object') return null;
    const { action, slot, id, count } = value as Partial<InventoryCommand>;
    if ((action !== 'eat' && action !== 'drop') ||
        typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= 28 ||
        typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id > 65535 ||
        typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 0x7fffffff) return null;
    return { action, slot, id, count };
}

export function inventoryOption(item: InventoryItem, action: InventoryCommand['action']): number | undefined {
    const options = item.optionsWithIndex;
    const explicit = options?.find(({ text, opIndex }) =>
        text.toLowerCase() === action && Number.isInteger(opIndex) && opIndex >= 1 && opIndex <= 5);
    if (explicit) return explicit.opIndex;
    // The game menu adds Drop at option five when the item has no custom fifth option.
    if (action === 'drop' && options && !options.some(({ opIndex }) => opIndex === 5)) return 5;
}

type InventoryState = {
    inventory: InventoryItem[];
    inGame: boolean;
    player: object | null;
    modalOpen: boolean;
    dialog: { isOpen: boolean };
    shop: { isOpen: boolean };
    bank: { isOpen: boolean };
    trade?: { isOpen: boolean };
};

function itemCount(items: InventoryItem[], id: number) {
    return items.reduce((count, item) => item.id === id ? count + item.count : count, 0);
}

export function prepareInventoryCommand(state: InventoryState | null, command: InventoryCommand):
    { action: Extract<BotAction, { type: 'dropItem' | 'useInventoryItem' }>; name: string; observed: (state: InventoryState) => boolean } | InventoryResult {
    if (!state?.inGame || !state.player) return { status: 409, message: 'This bot is offline.' };
    if (state.modalOpen || state.dialog.isOpen || state.shop.isOpen || state.bank.isOpen || state.trade?.isOpen) {
        return { status: 409, message: 'Close the open in-game window before using the backpack.' };
    }
    const item = state.inventory.find(entry => entry.slot === command.slot);
    if (item?.id !== command.id || item.count !== command.count) {
        return { status: 409, message: 'That slot changed. Select the item again from the refreshed inventory.' };
    }
    const optionIndex = inventoryOption(item, command.action);
    if (optionIndex === undefined) return { status: 422,
        message: command.action === 'eat' ? 'This item has no Eat option.' : 'This item has no Drop option.',
    };
    const reason = 'Fleet Desk inventory';
    const action = command.action === 'drop' && optionIndex === 5
        ? { type: 'dropItem' as const, slot: item.slot, reason }
        : { type: 'useInventoryItem' as const, slot: item.slot, optionIndex, reason };
    const before = itemCount(state.inventory, item.id);
    const decrease = command.action === 'drop' ? item.count : 1;
    return {
        action, name: item.name,
        observed: next => {
            const current = next.inventory.find(entry => entry.slot === item.slot && entry.id === item.id);
            return next.inGame && (current?.count ?? 0) <= item.count - decrease
                && itemCount(next.inventory, item.id) <= before - decrease;
        },
    };
}

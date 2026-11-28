import { expect, test } from 'bun:test';
import type { ScriptContext } from '../sdk/runner';
import type { BankItem, BotWorldState, InventoryItem } from '../sdk/types';
import { fishSharks } from './tasks/fish-sharks';

const raw = 383, cooked = 385, burnt = 387, harpoon = 311;
const item = (id: number, count = 1): InventoryItem => ({ id, name: String(id), slot: 0, count, optionsWithIndex: [] });

function fixture(area: 'catherby' | 'guild', stock: BankItem[], inventory: InventoryItem[] = []) {
    const guild = area === 'guild';
    const state = {
        inGame: true, tick: 1, player: { level: 0, worldX: guild ? 2586 : 2809, worldZ: guild ? 3419 : 3441 },
        inventory, equipment: [], bank: { isOpen: false, items: stock }, shop: { isOpen: false },
        interface: { isOpen: false }, dialog: { isOpen: false },
        skills: ['Fishing', 'Cooking'].map(name => ({ name, level: 90, baseLevel: 90, experience: 1 })),
        nearbyNpcs: [{ id: guild ? 313 : 322, index: 1, x: 0, z: 0, distance: 1, optionsWithIndex: [{ text: 'Harpoon', opIndex: 1 }] }],
        nearbyLocs: [{ id: 2728, x: guild ? 2616 : 2817, z: guild ? 3396 : 3444 }],
    } as unknown as BotWorldState;
    const success = { success: true, message: 'Observed' };
    const log = { casts: 0, cooks: 0, bankOpens: 0, deposits: [] as number[] };
    let fishing = false;
    let pending: BankItem | undefined;
    const stored = (id: number) => stock.find(entry => entry.id === id)?.count ?? 0;
    function flushBankUpdate() {
        if (!pending) return;
        const stack = stock.find(entry => entry.id === pending!.id);
        if (stack) stack.count += pending.count;
        else stock.push(pending);
        pending = undefined;
    }
    const ctx = {
        sdk: {
            getState: () => state, getStateAge: () => 0, waitForReady: async () => {},
            sendInteractNpc: async () => { fishing = true; log.casts++; return success; },
            waitForCondition: async (predicate: (next: BotWorldState) => boolean) => {
                if (!predicate(state)) {
                    if (pending) flushBankUpdate();
                    else if (fishing) state.inventory.push(item(raw));
                }
                expect(predicate(state)).toBe(true);
                return state;
            },
        },
        bot: {
            walkTo: async (x: number, z: number) => {
                Object.assign(state.player!, { worldX: x, worldZ: z });
                fishing = false;
                return success;
            },
            dismissBlockingUI: async () => {},
            openBank: async () => { log.bankOpens++; state.bank.isOpen = true; return success; },
            closeBank: async () => { flushBankUpdate(); state.bank.isOpen = false; return success; },
            depositItem: async ({ id }: InventoryItem) => {
                flushBankUpdate();
                const count = state.inventory.filter(entry => entry.id === id).reduce((n, entry) => n + entry.count, 0);
                state.inventory = state.inventory.filter(entry => entry.id !== id);
                pending = item(id, count);
                log.deposits.push(id);
                return success;
            },
            withdrawItem: async ({ id }: BankItem) => {
                const stack = stock.find(entry => entry.id === id)!;
                stack.count--; state.inventory.push(item(id)); return success;
            },
            useItemOnLoc: async (fish: InventoryItem) => {
                const index = state.inventory.indexOf(fish);
                expect(index).toBeGreaterThanOrEqual(0);
                state.inventory[index] = item(++log.cooks === 1 ? burnt : cooked);
                return success;
            },
        },
    } as unknown as ScriptContext;
    return { ctx, log, stored, state };
}

for (const area of ['catherby', 'guild'] as const) {
    for (const cook of [false, true]) {
        const product = cook ? cooked : raw;
        test(`${area}, cooking=${cook}: existing shark stock finishes without touching the backpack`, async () => {
            const f = fixture(area, [item(product, 250)], [item(995, 20)]);
            await fishSharks(f.ctx, cook, undefined, area, 250);
            expect(f.log).toEqual({ bankOpens: 1, casts: 0, cooks: 0, deposits: [] });
            expect(f.state.bank.isOpen).toBe(false);
            expect(f.state.inventory).toHaveLength(1);
        });

        test(`${area}, cooking=${cook}: counts the right sharks and banks a partial final load`, async () => {
            const f = fixture(area, [item(product, 1), item(cook ? raw : cooked, 250), item(burnt, 250), item(harpoon)]);
            await fishSharks(f.ctx, cook, undefined, area, 2);
            expect(f.stored(product)).toBe(2);
            expect(f.stored(burnt)).toBe(cook ? 251 : 250);
            expect(f.log.casts).toBe(cook ? 2 : 1);
            expect(f.log.cooks).toBe(cook ? 2 : 0);
            expect(f.state.bank.isOpen).toBe(false);
        });
    }
}

test('resuming with the last raw sharks in the backpack confirms their deposit before fishing', async () => {
    const f = fixture('catherby', [item(raw, 8)], [item(raw, 2)]);
    await fishSharks(f.ctx, false, undefined, 'catherby', 10);
    expect(f.log.casts).toBe(0);
    expect(f.stored(raw)).toBe(10);
    expect(f.log.deposits).toEqual([raw]);
});

test('an invalid shark target fails before any game action', async () => {
    const f = fixture('guild', []);
    for (const target of [0, 1.2, 100_001, NaN]) {
        await expect(fishSharks(f.ctx, true, undefined, 'guild', target)).rejects.toThrow('bank target');
    }
    expect(f.log.bankOpens).toBe(0);
});

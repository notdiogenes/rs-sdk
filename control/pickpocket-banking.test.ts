import { expect, test } from 'bun:test';
import type { ScriptContext } from '../sdk/runner';
import type { BankItem, BotWorldState, InventoryItem } from '../sdk/types';
import { adventure } from './tasks/adventure';

const finished = 'Fixture has observed enough pickpockets';
const edible = [{ text: 'Eat', opIndex: 1 }];
const item = (id: number, name: string, count: number, slot = 0): InventoryItem =>
    ({ id, name, count, slot, optionsWithIndex: id === 385 ? edible : [] });

function account(town: 'Lumbridge' | 'Ardougne', inventory: InventoryItem[], stock: BankItem[] = [], hp = 60, attempts = 0) {
    const [x, z] = town === 'Lumbridge' ? [3222, 3222] : [2652, 3318];
    const npc = { id: 1, index: 1, name: town === 'Lumbridge' ? 'Man' : 'Hero', x, z, distance: 1,
        optionsWithIndex: [{ text: 'Pickpocket', opIndex: 1 }] };
    const state = {
        inGame: true, tick: 1,
        player: { worldX: x, worldZ: z, level: 0, hp, maxHp: 60, isDead: false },
        skills: [{ name: 'Thieving', baseLevel: 90, level: 90, experience: 1000000 }],
        inventory,
        bank: { isOpen: false, items: stock },
        nearbyNpcs: [npc],
        gameMessages: [],
    } as unknown as BotWorldState;
    const deposited: number[] = [];
    const withdrawn: Array<{ id: number; amount: number; asNote: boolean }> = [];
    const eaten: number[] = [];
    const walks: number[][] = [];
    let visits = 0;
    let remaining = attempts;
    const result = { success: true, message: 'Observed' };
    const ctx = {
        sdk: {
            getState: () => state,
            getSkill: (name: string) => state.skills.find(skill => skill.name === name),
            getInventory: () => state.inventory,
            findInventoryItem: (pattern: RegExp) => state.inventory.find(entry => pattern.test(entry.name)),
            countInventoryItems: (pattern: RegExp) => state.inventory.filter(entry => pattern.test(entry.name))
                .reduce((sum, entry) => sum + entry.count, 0),
            waitForTicks: async (ticks: number) => { state.tick += ticks; },
        },
        bot: {
            walkTo: async (worldX: number, worldZ: number) => {
                walks.push([worldX, worldZ]);
                Object.assign(state.player!, { worldX, worldZ });
                return result;
            },
            openBank: async () => { state.bank.isOpen = true; visits++; return result; },
            closeBank: async () => { state.bank.isOpen = false; return result; },
            depositItem: async (entry: InventoryItem, amount: number) => {
                expect(amount).toBe(-1);
                deposited.push(entry.id);
                state.inventory = state.inventory.filter(other => other.id !== entry.id);
                return { ...result, amountDeposited: entry.count };
            },
            withdrawItem: async (entry: BankItem, amount: number, { asNote }: { asNote: boolean }) => {
                withdrawn.push({ id: entry.id, amount, asNote });
                state.inventory.push(...Array.from({ length: amount }, (_, slot) => item(entry.id, entry.name, 1, slot + 10)));
                return { ...result, amountWithdrawn: amount };
            },
            eatFood: async (entry: InventoryItem) => {
                eaten.push(entry.id);
                state.player!.hp += 20;
                state.inventory = state.inventory.filter(other => other.slot !== entry.slot);
                return result;
            },
            pickpocketNpc: async () => {
                expect(state.bank.isOpen).toBe(false);
                if (remaining-- <= 0) throw new Error(finished);
                const coins = state.inventory.find(entry => entry.id === 995);
                if (coins) coins.count += 3;
                else state.inventory.push(item(995, 'Coins', 3, 9));
                state.skills[0]!.experience += 80;
                return result;
            },
        },
    } as unknown as ScriptContext;
    return { ctx, state, deposited, withdrawn, eaten, walks, visits: () => visits };
}

test('banks loot, withdraws unnoted food, and uses it to recover before pickpocketing', async () => {
    const a = account('Ardougne', [
        item(995, 'Coins', 1000), item(560, 'Death rune', 2, 1), item(565, 'Blood rune', 1, 2),
        item(590, 'Tinderbox', 1, 3), item(1935, 'Jug', 1, 4),
    ], [item(383, 'Raw shark', 40), item(386, 'Shark', 40, 1), item(385, 'Shark', 10, 2)], 20);
    await expect(adventure(a.ctx).pickpocket('heroes', true)).rejects.toThrow(finished);
    expect(a.deposited).toEqual([995, 560, 565, 1935]);
    expect(a.withdrawn).toEqual([{ id: 385, amount: 8, asNote: false }]);
    expect(a.eaten).toEqual([385]);
    expect(a.state.inventory.find(entry => entry.id === 590)?.count).toBe(1);
    expect(a.walks).toEqual([[2656, 3283]]);
});

test('banks a batch of stackable loot and returns to Lumbridge', async () => {
    const a = account('Lumbridge', Array.from({ length: 8 }, (_, slot) => item(385, 'Shark', 1, slot)), [], 60, 100);
    await expect(adventure(a.ctx).pickpocket('men', true)).rejects.toThrow(finished);
    expect(a.deposited).toEqual([995]);
    expect(a.walks).toEqual([[3092, 3243], [3222, 3222]]);
    expect(a.visits()).toBe(1);
});

test('waits before trying again when food is out of stock and preserves the default behavior', async () => {
    const empty = account('Ardougne', [], [], 60, 2);
    await expect(adventure(empty.ctx).pickpocket('heroes', true)).rejects.toThrow(finished);
    expect(empty.visits()).toBe(1);
    expect(empty.withdrawn).toEqual([]);

    const normal = account('Ardougne', [item(995, 'Coins', 10)]);
    await expect(adventure(normal.ctx).pickpocket('heroes')).rejects.toThrow(finished);
    expect(normal.visits()).toBe(0);
    expect(normal.deposited).toEqual([]);
});

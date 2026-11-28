import { expect, test } from 'bun:test';
import type { ScriptContext } from '../sdk/runner';
import type { BankItem, BotWorldState, InventoryItem } from '../sdk/types';
import { adventure } from './tasks/adventure';

const finished = 'Fixture has observed enough pickpockets';
const edible = [{ text: 'Eat', opIndex: 1 }];
const item = (id: number, name: string, count: number, slot = 0): InventoryItem =>
    ({ id, name, count, slot, optionsWithIndex: id === 385 || id === 2309 ? edible : [] });

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
    const slotsBeforeWithdrawal: number[] = [];
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
                deposited.push(entry.id);
                let remaining = amount === -1 ? Infinity : amount;
                let amountDeposited = 0;
                state.inventory = state.inventory.flatMap(other => {
                    if (other.id !== entry.id || remaining === 0) return [other];
                    const moved = Math.min(other.count, remaining);
                    remaining -= moved;
                    amountDeposited += moved;
                    return moved === other.count ? [] : [{ ...other, count: other.count - moved }];
                });
                const inBank = state.bank.items.find(other => other.id === entry.id);
                if (inBank) inBank.count += amountDeposited;
                else state.bank.items.push({ id: entry.id, name: entry.name, count: amountDeposited, slot: state.bank.items.length });
                return { ...result, amountDeposited };
            },
            withdrawItem: async (entry: BankItem, amount: number, { asNote }: { asNote: boolean }) => {
                slotsBeforeWithdrawal.push(state.inventory.length);
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
    return { ctx, state, deposited, withdrawn, slotsBeforeWithdrawal, eaten, walks, visits: () => visits };
}

test('banks carried items, withdraws unnoted food, and uses it to recover before pickpocketing', async () => {
    const a = account('Ardougne', [
        item(995, 'Coins', 1000), item(560, 'Death rune', 2, 1), item(565, 'Blood rune', 1, 2),
        item(590, 'Tinderbox', 1, 3), item(1935, 'Jug', 1, 4),
    ], [item(383, 'Raw shark', 40), item(386, 'Shark', 40, 1), item(385, 'Shark', 10, 2)], 20);
    await expect(adventure(a.ctx).pickpocket('heroes', true)).rejects.toThrow(finished);
    expect(a.deposited).toEqual([995, 560, 565, 590, 1935]);
    expect(a.withdrawn).toEqual([{ id: 385, amount: 8, asNote: false }]);
    expect(a.eaten).toEqual([385]);
    expect(a.state.inventory.find(entry => entry.id === 590)).toBeUndefined();
    expect(a.walks).toEqual([[2656, 3283]]);
});

for (const banking of [true, false]) {
    test(`banks fishing carryover before the first pickpocket with bank restocking ${banking ? 'enabled' : 'disabled'}`, async () => {
        const [foodId, foodName] = banking ? [385, 'Shark'] as const : [2309, 'Bread'] as const;
        const a = account('Ardougne', [
            item(311, 'Harpoon', 1), item(383, 'Raw shark', 1, 1), item(383, 'Raw shark', 1, 2),
            item(995, 'Coins', 10, 3), item(foodId + 1, foodName, 5, 4),
            ...Array.from({ length: 4 }, (_, slot) => item(foodId, foodName, 1, slot + 5)),
        ]);
        Object.assign(a.state.player!, { worldX: 2853, worldZ: 3424 });
        await expect(adventure(a.ctx).pickpocket('heroes', banking)).rejects.toThrow(finished);
        expect(a.deposited).toEqual(banking ? [311, 383, 995, 386, 385] : [311, 383, 2310]);
        expect(a.state.inventory.map(entry => entry.id)).toEqual(banking ? Array(4).fill(385) : [995, 2309, 2309, 2309, 2309]);
        expect(a.withdrawn).toEqual(banking ? [{ id: 385, amount: 4, asNote: false }] : []);
        expect(a.walks).toEqual([[2656, 3283]]);
    });
}

test('deposits the full backpack before withdrawing eight usable food items', async () => {
    const a = account('Ardougne', [
        ...Array.from({ length: 10 }, (_, slot) => item(385, 'Shark', 1, slot)), item(386, 'Shark', 20, 10),
    ]);
    await expect(adventure(a.ctx).pickpocket('heroes', true)).rejects.toThrow(finished);
    expect(a.deposited).toEqual([385, 386]);
    expect(a.slotsBeforeWithdrawal).toEqual([0]);
    expect(a.withdrawn).toEqual([{ id: 385, amount: 8, asNote: false }]);
    expect(a.state.inventory.map(entry => entry.id)).toEqual(Array(8).fill(385));
});

test('keeps and eats carried sharks after banking with restocking disabled', async () => {
    const a = account('Ardougne', [item(385, 'Shark', 1), item(386, 'Shark', 5, 1), item(311, 'Harpoon', 1, 2)], [], 20);
    Object.assign(a.state.player!, { worldX: 2656, worldZ: 3283 });
    a.state.bank.isOpen = true;
    a.ctx.sdk.waitForTicks = async () => { throw new Error('Unexpected wait with usable food in the backpack'); };

    await expect(adventure(a.ctx).pickpocket('heroes')).rejects.toThrow(finished);

    expect(a.deposited).toEqual([386, 311]);
    expect(a.withdrawn).toEqual([]);
    expect(a.eaten).toEqual([385]);
    expect(a.state.player!.hp).toBe(40);
    expect(a.state.bank.isOpen).toBe(false);
    expect(a.walks).toEqual([]);
});

test('waits for passive recovery when the backpack has no food', async () => {
    const a = account('Lumbridge', [], [], 3);
    const waits: number[] = [];
    a.ctx.sdk.waitForTicks = async ticks => {
        waits.push(ticks ?? 0);
        a.state.tick += ticks ?? 0;
        a.state.player!.hp = 6;
        return a.state;
    };

    await expect(adventure(a.ctx).pickpocket('men')).rejects.toThrow(finished);

    expect(waits).toEqual([12]);
    expect(a.eaten).toEqual([]);
    expect(a.visits()).toBe(0);
});

test('banks a batch of stackable loot and returns to Lumbridge', async () => {
    const a = account('Lumbridge', Array.from({ length: 8 }, (_, slot) => item(385, 'Shark', 1, slot)), [], 60, 100);
    await expect(adventure(a.ctx).pickpocket('men', true)).rejects.toThrow(finished);
    expect(a.deposited).toEqual([385, 995]);
    expect(a.withdrawn).toEqual([{ id: 385, amount: 8, asNote: false }]);
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

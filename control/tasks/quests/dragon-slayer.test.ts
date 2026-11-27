import { expect, test } from 'bun:test';
import { planQuestFight } from './quest-combat';
import { prepareQuestStep, type QuestContext } from './shared';

const pieces = [1535, 1536, 1537].map(id => ({ id, name: 'Map part', count: 1 }));

test('restores each exact map piece when the pieces share a bank display name', async () => {
    const inventory = [pieces[1]!];
    const bank = [pieces[0]!, pieces[2]!];
    let bankOpen = false;
    const ctx = {
        sdk: {
            getInventory: () => inventory,
            getBankItems: () => bank,
            getState: () => null,
            isBankOpen: () => bankOpen,
        },
        bot: {
            walkTo: async () => ({ success: true }),
            openBank: async () => { bankOpen = true; return { success: true }; },
            closeBank: async () => { bankOpen = false; },
            withdrawItem: async (entry: typeof bank[number], count: number) => {
                inventory.push({ ...entry, count });
                return { success: true };
            },
        },
    } as unknown as QuestContext;

    await prepareQuestStep(ctx, { withdraw: pieces });
    expect(inventory.map(entry => entry.id).sort()).toEqual([1535, 1536, 1537]);
    expect(bankOpen).toBe(false);
});

test('allows a low-defence caster to attack Wormbrain from outside the cell without food', () => {
    const runes = [{ name: 'Mind rune', count: 10 }, { name: 'Fire rune', count: 30 }, { name: 'Air rune', count: 20 }];
    const ctx = {
        sdk: {
            getState: () => ({ player: { hp: 10, maxHp: 10, isDead: false } }),
            getSkill: (name: string) => ({ baseLevel: name === 'Magic' ? 33 : 1 }),
            countInventoryItems: (pattern: RegExp) => runes.find(item => pattern.test(item.name))?.count ?? 0,
        },
    } as unknown as QuestContext;

    const plan = planQuestFight(ctx, { name: 'Wormbrain', hitpoints: 5, incomingHit: 0, meleeLevel: 1, minimumFood: 0 },
        { magicOnly: true });
    expect(plan.style).toBe('magic');
});

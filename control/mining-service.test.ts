import { expect, test } from 'bun:test';
import type { ScriptContext } from '../sdk/runner';
import type { BotWorldState, InventoryItem } from '../sdk/types';
import { activity, isActivity } from './dashboard-task-catalog';
import { miningBanks, miningResources, miningTravelTimeout, rankMiningSites } from './mining-routes';
import { mineResources } from './tasks/mine-resources';

test('every supported resource has both modes and resource-specific routes', () => {
    const from = miningBanks.west;
    for (const resource of Object.keys(miningResources) as (keyof typeof miningResources)[]) {
        for (const mode of ['power', 'bank'] as const) {
            const task = `mine-${resource}-${mode}`;
            expect(isActivity(task)).toBe(true);
            if (isActivity(task)) expect(activity(task).script).toBe('mine-resources.ts');
            expect(rankMiningSites(resource, mode, from, 99).length).toBeGreaterThan(0);
        }
    }
    expect(isActivity('mine-runite-bank')).toBe(false);
    expect(isActivity('mine-blurite-power')).toBe(false);
    expect(rankMiningSites('coal', 'bank', from, 59).some(site => site.guild)).toBe(false);
    expect(rankMiningSites('coal', 'bank', from, 61)[0]?.mine.name).toBe('Mining Guild');
    expect(rankMiningSites('iron', 'bank', from, 61)[0]?.mine.name)
        .not.toBe(rankMiningSites('iron', 'power', from, 61)[0]?.mine.name);
    expect(miningTravelTimeout(378)).toBeGreaterThan(150000);
    expect(miningTravelTimeout(8)).toBeLessThan(150000);
});

for (const scenario of ['bank', 'power', 'partial-bank'] as const) {
    test(`mining ${scenario} confirms pick withdrawal, switches sites, mines, and unloads`, async () => {
        const mode = scenario === 'partial-bank' ? 'bank' : scenario;
        const partial = scenario === 'partial-bank';
        const item = (id: number, name: string, slot: number, eat = false): InventoryItem => ({
            id, name, slot, count: 1, optionsWithIndex: eat ? [{ text: 'Eat', opIndex: 1 }] : [],
        });
        const state = {
            inGame: true,
            player: { worldX: miningBanks.west.x, worldZ: miningBanks.west.z, level: 0, hp: 99, maxHp: 99, isDead: false },
            skills: [{ name: 'Mining', baseLevel: 61, experience: 300000 }],
            inventory: Array.from({ length: partial ? 24 : 26 }, (_, slot) => item(379, 'Lobster', slot, true)),
            equipment: [],
            bank: { isOpen: true, items: [item(1275, 'Rune pickaxe', 0)] },
            nearbyLocs: [],
            nearbyPlayers: [],
            opFeedback: { opRejectedCount: 0 },
        } as unknown as BotWorldState;
        const success = { success: true, message: '' };
        const trips: string[] = [];
        let mine = 0;
        let haul = 0;
        const context = {
            sdk: {
                getState: () => state,
                getStateAge: () => 0,
                waitForTicks: async () => state,
                scanNearbyLocs: async () => state.nearbyLocs,
                waitForCondition: async (check: (value: BotWorldState) => boolean) => {
                    if (!check(state)) throw new Error('No observed effect');
                    return state;
                },
                sendInteractLoc: async () => {
                    if (mine === 1) return { success: false, message: 'Rock was depleted' };
                    if (haul) {
                        state.player!.isDead = true;
                        return { success: false, message: 'End fixture' };
                    }
                    if (partial && state.inventory.some(entry => entry.id === 440)) return { success: false, message: 'Rock was depleted' };
                    state.inventory.push(item(440, 'Iron ore', 27));
                    state.skills[0]!.experience += 35;
                    trips.push('verified ore');
                    return success;
                },
            },
            bot: {
                withdrawItem: async (entry: InventoryItem) => {
                    state.inventory.push({ ...entry, slot: 26 });
                    trips.push('withdraw rune pick');
                    return success;
                },
                closeBank: async () => { state.bank.isOpen = false; return success; },
                openBank: async () => { state.bank.isOpen = true; return success; },
                walkTo: async (x: number, z: number) => {
                    state.player!.worldX = x;
                    state.player!.worldZ = z;
                    if (!Object.values(miningBanks).some(bank => bank.x === x && bank.z === z)) {
                        if (!state.nearbyLocs.some(loc => loc.x === x + 1 && loc.z === z)) mine++;
                        state.nearbyLocs = [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]].map(([rockX, rockZ], offset) => ({ id: 2092, x: rockX, z: rockZ, name: 'Rocks',
                            distance: offset, optionsWithIndex: [{ text: 'Mine', opIndex: 1 }] })) as BotWorldState['nearbyLocs'];
                    }
                    return success;
                },
                depositItem: async (entry: InventoryItem) => {
                    expect(entry.id).toBe(440);
                    state.inventory = state.inventory.filter(i => i.id !== entry.id);
                    haul++;
                    trips.push('bank ore');
                    return success;
                },
                dropItem: async (entry: InventoryItem) => {
                    expect(entry.id).toBe(440);
                    state.inventory = state.inventory.filter(i => i.id !== entry.id);
                    haul++;
                    trips.push('drop ore');
                    return success;
                },
            },
        } as unknown as ScriptContext;
        await expect(mineResources(context, `mine-iron-${mode}`)).rejects.toThrow('living player');
        expect(mine).toBeGreaterThanOrEqual(2);
        expect(trips).toEqual(['withdraw rune pick', 'verified ore', mode === 'bank' ? 'bank ore' : 'drop ore']);
        expect(state.inventory.some(entry => entry.id === 1275)).toBe(true);
    });
}

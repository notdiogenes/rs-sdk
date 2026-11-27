import { expect, test } from 'bun:test';
import type { ScriptContext } from '../sdk/runner';
import type { BotWorldState, InventoryItem } from '../sdk/types';
import { activity, isActivity } from './dashboard-task-catalog';
import { miningBanks, miningResources, miningTravelDistance, miningTravelTimeout, miningTravelVia, rankMiningSites } from './mining-routes';
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

for (const firstBankFails of [false, true]) {
    test(`setup resumes west of the toll gate with a bank fallback = ${firstBankFails}`, async () => {
        const gate = { x: 3267, z: 3227 };
        expect(miningTravelVia(gate, miningBanks.kharid)).toMatchObject({ x: 3275, z: 3306 });
        expect(miningTravelVia(miningBanks.kharid, gate)).toMatchObject({ x: 3275, z: 3306 });
        expect(miningTravelDistance(gate, miningBanks.draynor)).toBeLessThan(miningTravelDistance(gate, miningBanks.kharid));
        const state = {
            inGame: true,
            player: { worldX: gate.x, worldZ: gate.z, level: 0, hp: 99, maxHp: 99, isDead: false },
            skills: [{ name: 'Mining', baseLevel: 61, experience: 300000 }],
            inventory: [], equipment: [],
            bank: { isOpen: false, items: [{ id: 453, name: 'Coal', count: 6000, slot: 0 }] },
            dialog: { isOpen: true, text: 'You must pay a toll of 10 gold coins to pass.', options: [] },
        } as unknown as BotWorldState;
        const success = { success: true, message: '' };
        const walks: number[][] = [];
        let dialoguesClosed = 0;
        const context = {
            sdk: {
                getState: () => state,
                getStateAge: () => 0,
                sendCloseModal: async () => {
                    dialoguesClosed++;
                    state.dialog.isOpen = false;
                    return success;
                },
                waitForCondition: async (check: (value: BotWorldState) => boolean) => {
                    expect(check(state)).toBe(true);
                    return state;
                },
            },
            bot: {
                walkTo: async (x: number, z: number) => {
                    expect(state.dialog.isOpen).toBe(false);
                    walks.push([x, z]);
                    if (firstBankFails && walks.length === 1) return { success: false, message: 'Path blocked' };
                    state.player!.worldX = x;
                    state.player!.worldZ = z;
                    return success;
                },
                openBank: async () => { state.bank.isOpen = true; return success; },
                closeBank: async () => { state.bank.isOpen = false; return success; },
            },
        } as unknown as ScriptContext;
        await mineResources(context, 'mine-coal-bank', 6000);
        expect(walks).toEqual(firstBankFails ? [[3092, 3243], [3253, 3420]] : [[3092, 3243]]);
        expect(dialoguesClosed).toBe(1);
        expect(state.bank.isOpen).toBe(false);
    });
}

for (const scenario of ['bank', 'power', 'partial-bank', 'stock-target'] as const) {
    test(`mining ${scenario} confirms pick withdrawal, switches sites, mines, and unloads`, async () => {
        const mode = scenario === 'power' ? 'power' : 'bank';
        const target = scenario === 'stock-target' ? 1000 : undefined;
        const partial = scenario === 'partial-bank' || target !== undefined;
        const item = (id: number, name: string, slot: number, eat = false): InventoryItem => ({
            id, name, slot, count: 1, optionsWithIndex: eat ? [{ text: 'Eat', opIndex: 1 }] : [],
        });
        const state = {
            inGame: true,
            tick: 1,
            player: { worldX: miningBanks.west.x, worldZ: miningBanks.west.z, level: 0, hp: 99, maxHp: 99, isDead: false },
            skills: [{ name: 'Mining', baseLevel: 61, experience: 300000 }],
            inventory: Array.from({ length: partial ? 24 : 26 }, (_, slot) => item(379, 'Lobster', slot, true)),
            equipment: [],
            bank: { isOpen: true, items: [item(1275, 'Rune pickaxe', 0)] },
            nearbyLocs: [],
            nearbyPlayers: [],
            opFeedback: { opRejectedCount: 0 },
            gameMessages: [],
        } as unknown as BotWorldState;
        if (target !== undefined) state.bank.items.push({ slot: 1, id: 440, name: 'Iron ore', count: 999 });
        const success = { success: true, message: '' };
        const trips: string[] = [];
        let mine = 0;
        let haul = 0;
        let pendingOre = false;
        const context = {
            sdk: {
                getState: () => state,
                getStateAge: () => 0,
                waitForTicks: async () => state,
                scanNearbyLocs: async () => state.nearbyLocs,
                waitForCondition: async (check: (value: BotWorldState) => boolean) => {
                    if (!check(state) && pendingOre) {
                        pendingOre = false;
                        state.inventory.push(item(440, 'Iron ore', 27));
                        state.skills[0]!.experience += 35;
                        trips.push('verified ore');
                    }
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
                    state.gameMessages = [{ tick: ++state.tick, text: 'You swing your pick at the rock.',
                        type: 0, sender: '', fromSelf: false }];
                    pendingOre = true;
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
                    const existing = state.bank.items.find(i => i.id === entry.id);
                    if (existing) existing.count += entry.count;
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
        const run = mineResources(context, `mine-iron-${mode}`, target);
        if (target === undefined) await expect(run).rejects.toThrow('living player');
        else {
            await run;
            expect(state.bank.items.find(item => item.id === 440)?.count).toBe(target);
            expect(state.bank.isOpen).toBe(false);
        }
        expect(mine).toBeGreaterThanOrEqual(2);
        expect(trips).toEqual(['withdraw rune pick', 'verified ore', mode === 'bank' ? 'bank ore' : 'drop ore']);
        expect(state.inventory.some(entry => entry.id === 1275)).toBe(true);
    });
}

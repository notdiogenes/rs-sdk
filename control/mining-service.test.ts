import { expect, test } from 'bun:test';
import { findDoorsAlongPath, findLongPath } from '../sdk/pathfinding';
import type { ScriptContext } from '../sdk/runner';
import type { BotWorldState, InventoryItem } from '../sdk/types';
import { activity, isActivity } from './dashboard-task-catalog';
import { alKharidTollGate, coalTrucks, fishingGuildBank, miningBanks, miningDistance, miningPathDistance, miningResources, miningTravelDistance,
    miningTravelTimeout, miningTravelWaypoints, rankMiningSites } from './mining-routes';
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

test('the Al Kharid mine and bank are reachable from the Lumbridge swamp without the toll gate', () => {
    const swamp = { x: 3232, z: 3163 };
    const mine = { x: 3300, z: 3301 };
    for (const [from, to] of [[swamp, mine], [mine, swamp], [swamp, miningBanks.kharid], [miningBanks.kharid, swamp]] as const) {
        const waypoints = miningTravelWaypoints(from, to);
        expect(waypoints).toHaveLength(2);
        let previous = from;
        for (const point of [...waypoints, to]) {
            const path = findLongPath(0, previous.x, previous.z, point.x, point.z);
            expect(path.at(-1)).toMatchObject({ x: point.x, z: point.z });
            expect(findDoorsAlongPath(path).some(door => miningDistance(door, alKharidTollGate) <= 1)).toBe(false);
            previous = point;
        }
    }
    const first = miningTravelWaypoints(swamp, mine)[0]!;
    const path = findLongPath(0, swamp.x, swamp.z, first.x, first.z);
    expect(miningPathDistance(swamp, path)).toBeGreaterThan(miningDistance(swamp, first));
    expect(miningTravelWaypoints(miningBanks.kharid, mine)).toEqual([]);
});

for (const firstBankFails of [false, true]) {
    test(`setup resumes west of the toll gate with a bank fallback = ${firstBankFails}`, async () => {
        const gate = { x: 3267, z: 3227 };
        const road = [{ x: 3250, z: 3311 }, { x: 3275, z: 3306 }];
        expect(miningTravelWaypoints(gate, miningBanks.kharid)).toMatchObject(road);
        expect(miningTravelWaypoints(miningBanks.kharid, gate)).toMatchObject([...road].reverse());
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

for (const { name, fishing, guildUnavailable, expected } of [
    { name: 'below the requirement', fishing: 67, guildUnavailable: false, expected: [miningBanks.seers, miningBanks.seers] },
    { name: 'at the requirement', fishing: 68, guildUnavailable: false, expected: [fishingGuildBank, fishingGuildBank] },
    { name: 'when the guild bank fails', fishing: 68, guildUnavailable: true, expected: [fishingGuildBank, fishingGuildBank, miningBanks.seers] },
]) {
    test(`Coal Trucks selects the bank at setup and unloading ${name}`, async () => {
        const start = { x: 2576, z: 3479 };
        const rock = { id: 2096, x: start.x + 2, z: start.z, distance: 2, optionsWithIndex: [{ text: 'Mine', opIndex: 1 }] };
        const approach = { x: rock.x, z: rock.z - 1 };
        const ore = { id: 453, name: 'Coal', count: 1, slot: 0, optionsWithIndex: [] };
        const state = {
            inGame: true, tick: 1,
            player: { worldX: start.x, worldZ: start.z, level: 0, hp: 99, maxHp: 99, isDead: false },
            skills: [{ name: 'Mining', baseLevel: 59, experience: 250000 },
                { name: 'Fishing', level: fishing, baseLevel: 67 }],
            inventory: [],
            equipment: [{ id: 1275, name: 'Rune pickaxe' }],
            bank: { isOpen: false, items: [{ ...ore, count: 5999 }] },
            nearbyPlayers: [], nearbyLocs: [],
        } as unknown as BotWorldState;
        const success = { success: true, message: '' };
        const bankAttempts: number[][] = [];
        const routeProbes: number[][] = [];
        const context = {
            sdk: {
                getState: () => state,
                getStateAge: () => 0,
                scanNearbyLocs: async () => state.nearbyLocs,
                canRouteToTile: async (level: number, srcX: number, srcZ: number, destX: number, destZ: number, maxWaypoints: number) => {
                    routeProbes.push([level, srcX, srcZ, destX, destZ, maxWaypoints]);
                    return destX === approach.x && destZ === approach.z;
                },
                sendInteractLoc: async () => {
                    state.inventory.push(ore);
                    state.skills[0]!.experience += 50;
                    return success;
                },
                waitForCondition: async (check: (value: BotWorldState) => boolean) => {
                    expect(check(state)).toBe(true);
                    return state;
                },
            },
            bot: {
                walkTo: async (x: number, z: number) => {
                    const atMine = x === coalTrucks.mine.x && z === coalTrucks.mine.z;
                    const atRock = x === approach.x && z === approach.z;
                    state.player!.worldX = atMine ? start.x : x;
                    state.player!.worldZ = atMine ? start.z : z;
                    state.nearbyLocs = atMine || atRock ? [rock as BotWorldState['nearbyLocs'][number]] : [];
                    return success;
                },
                openBank: async () => {
                    const { worldX, worldZ } = state.player!;
                    bankAttempts.push([worldX, worldZ]);
                    if (guildUnavailable && bankAttempts.length === 2 && worldX === fishingGuildBank.x) {
                        return { success: false, message: 'Bank unavailable' };
                    }
                    state.bank.isOpen = true;
                    return success;
                },
                closeBank: async () => { state.bank.isOpen = false; return success; },
                depositItem: async () => {
                    state.bank.items[0]!.count += state.inventory.length;
                    state.inventory = [];
                    return success;
                },
            },
        } as unknown as ScriptContext;
        await mineResources(context, 'mine-coal-bank', 6000);
        expect(routeProbes).toEqual([
            [0, start.x, start.z, start.x + 1, start.z, 50],
            [0, start.x, start.z, approach.x, approach.z, 50],
        ]);
        expect(bankAttempts).toEqual(expected.map(({ x, z }) => [x, z]));
        expect(state.bank.items[0]!.count).toBe(6000);
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

test('mining rechecks exhausted sites and reaches its bank target on a later pass', async () => {
    const sites = rankMiningSites('iron', 'bank', miningBanks.west, 61);
    const firstMine = sites[0]!.mine;
    const ore = { id: 440, name: 'Iron ore', slot: 0, count: 1, optionsWithIndex: [] };
    const rock = { id: 2092, x: firstMine.x + 1, z: firstMine.z, distance: 1,
        optionsWithIndex: [{ text: 'Mine', opIndex: 1 }] };
    const state = {
        inGame: true, tick: 1,
        player: { worldX: miningBanks.west.x, worldZ: miningBanks.west.z, level: 0, hp: 99, maxHp: 99, isDead: false },
        skills: [{ name: 'Mining', baseLevel: 61, experience: 300000 }],
        inventory: [], equipment: [{ id: 1275, name: 'Rune pickaxe' }],
        bank: { isOpen: true, items: [] }, nearbyLocs: [], nearbyPlayers: [],
    } as unknown as BotWorldState;
    const success = { success: true, message: '' };
    const blockedWalks: { x: number; z: number }[] = [];
    const waits: number[] = [];
    const context = {
        sdk: {
            getState: () => state,
            getStateAge: () => 0,
            waitForTicks: async (ticks: number) => {
                waits.push(ticks);
                state.tick += ticks;
                return state;
            },
            scanNearbyLocs: async () => state.nearbyLocs,
            sendInteractLoc: async () => {
                state.inventory.push(ore);
                state.skills[0]!.experience += 35;
                return success;
            },
            waitForCondition: async (check: (value: BotWorldState) => boolean) => {
                expect(check(state)).toBe(true);
                return state;
            },
        },
        bot: {
            walkTo: async (x: number, z: number) => {
                if (waits.length < 3) {
                    blockedWalks.push({ x, z });
                    return { success: false, message: 'Site temporarily unreachable' };
                }
                state.player!.worldX = x;
                state.player!.worldZ = z;
                if (x === firstMine.x && z === firstMine.z) {
                    state.nearbyLocs = [rock as BotWorldState['nearbyLocs'][number]];
                }
                return success;
            },
            openBank: async () => { state.bank.isOpen = true; return success; },
            closeBank: async () => { state.bank.isOpen = false; return success; },
            depositItem: async () => {
                state.bank.items.push(ore);
                state.inventory = [];
                return success;
            },
        },
    } as unknown as ScriptContext;

    await mineResources(context, 'mine-iron-bank', 1);

    const sweep = sites.map(({ mine: { x, z } }) => ({ x, z }));
    expect(blockedWalks).toEqual([...sweep, ...sweep, ...sweep]);
    expect(waits).toEqual([100, 100, 100]);
    expect(state.bank.items).toEqual([ore]);
    expect(state.bank.isOpen).toBe(false);
});

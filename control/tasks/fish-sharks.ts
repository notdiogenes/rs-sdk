import { auditEvent } from '../../sdk/audit-trace';
import { runScript, type ScriptContext } from '../../sdk/runner';
import type { BotWorldState } from '../../sdk/types';
import { reportTaskActivity } from '../dashboard-task-activity';
import { bankLocations, type Tile } from '../bank-locations';
import { withTaskUpdateCheckpoints, type TaskCheckpoint } from './update-checkpoint';

const catherbyBank = { name: 'Catherby Bank', x: 2809, z: 3441 };
const catherbyRange = { name: 'the Catherby range', x: 2817, z: 3444 };
const harrysShop = { name: 'Harry’s Fishing Shop', x: 2834, z: 3445 };
const beach = { name: 'the Catherby fishing spots', x: 2845, z: 3433 };
// Land tiles beside the four groups of NPC movement tiles on the beach.
const shoreline = [{ x: 2837, z: 3432 }, beach, { x: 2853, z: 3425 }, { x: 2859, z: 3427 }];
const guildEntrance = { name: 'the Fishing Guild entrance', x: 2611, z: 3393 };
const guildDocks = { name: 'the Fishing Guild docks', x: 2611, z: 3414 };
const guildToolSpawns: Partial<Record<number, Tile & { approachX?: number }>> = {
    305: { x: 2605, z: 3395 },
    311: { x: 2605, z: 3396, approachX: 2606 },
    301: { x: 2608, z: 3397 },
};
const shorelineSearchTimeout = 240_000;
const banks = [catherbyBank, { name: 'the bank', x: 2655, z: 3284 }, ...Object.values(bankLocations)];
const capacity = 28;
const coins = 995;

const rawFish = {
    shrimp: { id: 317, cooking: 1, name: 'shrimp' }, anchovies: { id: 321, cooking: 1, name: 'anchovies' },
    mackerel: { id: 353, cooking: 10, name: 'mackerel' }, cod: { id: 341, cooking: 18, name: 'cod' },
    bass: { id: 363, cooking: 43, name: 'bass' }, tuna: { id: 359, cooking: 30, name: 'tuna' },
    swordfish: { id: 371, cooking: 45, name: 'swordfish' }, lobster: { id: 377, cooking: 40, name: 'lobsters' },
    shark: { id: 383, cooking: 80, name: 'sharks' },
};
const rawFishIds = new Set(Object.values(rawFish).map(fish => fish.id));

type Stage = {
    label: string;
    level: number;
    spot: number;
    guildSpot?: number;
    option: RegExp;
    tool: { id: number; name: string; stock: number };
    fish: (typeof rawFish)[keyof typeof rawFish];
};

// The Catherby NPCs named Fishing spot have different catches even when
// their options have the same label. Match their NPC types as well.
const stages: Stage[] = [
    { label: 'shrimp and anchovies', level: 1, spot: 320, option: /^net$/i,
        tool: { id: 303, name: 'small fishing net', stock: 5 }, fish: rawFish.shrimp },
    { label: 'mackerel and cod', level: 16, spot: 322, guildSpot: 313, option: /^net$/i,
        tool: { id: 305, name: 'big fishing net', stock: 5 }, fish: rawFish.mackerel },
    { label: 'tuna', level: 35, spot: 321, guildSpot: 312, option: /^harpoon$/i,
        tool: { id: 311, name: 'harpoon', stock: 2 }, fish: rawFish.tuna },
    { label: 'lobsters', level: 40, spot: 321, guildSpot: 312, option: /^cage$/i,
        tool: { id: 301, name: 'lobster pot', stock: 2 }, fish: rawFish.lobster },
    { label: 'sharks', level: 76, spot: 322, guildSpot: 313, option: /^harpoon$/i,
        tool: { id: 311, name: 'harpoon', stock: 2 }, fish: rawFish.shark },
];

const guildStages = stages.flatMap(({ guildSpot, ...stage }) => guildSpot === undefined
    ? [] : [{ ...stage, level: Math.max(68, stage.level), spot: guildSpot }]);

const locations = {
    catherby: {
        name: 'Catherby', bank: catherbyBank, range: catherbyRange, rangeApproach: catherbyRange, rangeTolerance: 3,
        start: beach, search: shoreline, stages,
    },
    guild: {
        name: 'the Fishing Guild', bank: { name: 'Fishing Guild Bank', x: 2586, z: 3419 },
        range: { name: 'the Fishing Guild range', x: 2616, z: 3396 },
        rangeApproach: { name: 'the Fishing Guild range', x: 2616, z: 3398 }, rangeTolerance: 0,
        start: guildDocks, search: [
            guildDocks, { x: 2611, z: 3412 }, { x: 2603, z: 3413 }, { x: 2607, z: 3415 },
            { x: 2604, z: 3420 }, { x: 2604, z: 3425 }, { x: 2599, z: 3420 },
        ], stages: guildStages,
    },
};

type FishingArea = keyof typeof locations;

function skill(state: BotWorldState, name: 'Fishing' | 'Cooking') {
    return state.skills.find(entry => entry.name === name);
}

export function selectFishingStage(state: BotWorldState, cook: boolean, area: FishingArea = 'catherby') {
    const fishing = skill(state, 'Fishing')?.level;
    const cooking = cook ? skill(state, 'Cooking')?.level : undefined;
    if (fishing === undefined || (cook && cooking === undefined)) throw new Error('Fishing or Cooking level is unavailable.');
    // If Cooking has fallen behind, keep catching a fish that can grant
    // Cooking XP, including when Fishing already qualifies for sharks.
    const site = locations[area];
    const stage = site.stages.findLast(entry => fishing >= entry.level && (cooking === undefined || cooking >= entry.fish.cooking));
    if (!stage) throw new Error(`No fishing method at ${site.name} is available at the current levels.`);
    return stage;
}

const quantity = (state: BotWorldState, id: number) =>
    state.inventory.reduce((count, item) => count + (item.id === id ? item.count : 0), 0);

const activity = process.env.RS_ACTIVITY;
const cookingActivity = activity === 'fish-sharks-cook' || activity === 'fish-sharks-guild-cook';
const guildActivity = activity === 'fish-sharks-guild' || activity === 'fish-sharks-guild-cook';

export async function fishSharks({ bot, sdk }: ScriptContext, cook = cookingActivity,
    checkpoint?: TaskCheckpoint, area: FishingArea = guildActivity ? 'guild' : 'catherby') {
    const site = locations[area];
    reportTaskActivity(`Preparing to fish at ${site.name}`);
    await sdk.waitForReady();

    function current() {
        const state = sdk.getState();
        if (!state?.inGame || !state.player || state.player.isDead || sdk.getStateAge() > 10_000) {
            throw new Error('Fishing requires a fresh game state and a living player.');
        }
        return { ...state, player: state.player };
    }

    function observe(predicate: (state: BotWorldState) => boolean, timeout: number) {
        return sdk.waitForCondition(state => !state.inGame || !!state.player?.isDead || predicate(state), timeout).catch(error => {
            if (error instanceof Error && error.message === 'waitForCondition timed out') return null;
            throw error;
        });
    }

    async function requireAction(label: string, action: Promise<{ success: boolean; message: string }>) {
        const result = await action;
        if (!result.success) throw new Error(`${label}: ${result.message}`);
    }

    async function walk(target: Tile & { name: string }, tolerance: number, label: string) {
        const player = sdk.getState()?.player;
        if (player && Math.max(Math.abs(player.worldX - target.x), Math.abs(player.worldZ - target.z)) > tolerance) {
            reportTaskActivity(`Walking to ${target.name}`);
        }
        await requireAction(label, bot.walkTo(target.x, target.z, tolerance));
    }

    function insideGuild(state: BotWorldState) {
        const player = state.player;
        return !!player && player.level === 0 && player.worldX >= 2584 && player.worldX <= 2619
            && player.worldZ >= 3394 && player.worldZ <= 3426;
    }

    async function enterGuild() {
        if (insideGuild(current())) return;
        if (current().bank.isOpen) await requireAction('Close the bank', bot.closeBank());
        if (current().shop.isOpen) await requireAction('Close the shop', bot.closeShop());
        await walk(guildEntrance, 0, 'Reach the Fishing Guild entrance');
        reportTaskActivity('Entering the Fishing Guild');
        for (let attempt = 0; attempt < 3; attempt++) {
            const door = current().nearbyLocs.find(loc => loc.id === 2025 && loc.x === guildEntrance.x && loc.z === 3394);
            const action = door ? await sdk.sendInteractLoc(door.x, door.z, door.id, 1)
                : await sdk.sendWalk(guildEntrance.x, 3395);
            if (action.success && await observe(insideGuild, 4_000) && insideGuild(current())) return;
            if (insideGuild(current())) return;
        }
        throw new Error('Crossing the Fishing Guild entrance was not confirmed.');
    }

    async function openBank(target: (typeof banks)[number]) {
        if (current().bank.isOpen) return;
        await walk(target, 3, 'Reach the bank');
        await bot.dismissBlockingUI();
        if (current().interface?.isOpen) await requireAction('Close the open interface', bot.closeInterface());
        reportTaskActivity(`Opening ${target.name}`);
        await requireAction('Open the bank', bot.openBank());
        if (!current().bank.isOpen) throw new Error('The bank did not open.');
    }

    async function bankBackpack(bank: (typeof banks)[number], label: string, keepId?: number) {
        const deposit = current().inventory.filter(item => item.id !== keepId);
        if (deposit.length) reportTaskActivity(`${label} at ${bank.name}`);
        for (const id of new Set(deposit.map(item => item.id))) {
            const item = current().inventory.find(entry => entry.id === id);
            if (!item) continue;
            await requireAction(`Deposit ${item.name}`, bot.depositItem(item, -1));
            if (quantity(current(), id)) throw new Error(`Deposit of ${item.name} was not confirmed.`);
        }
    }

    async function openFishingShop(tool: Stage['tool']) {
        await walk(harrysShop, 4, 'Reach Harry’s Fishing Shop');
        reportTaskActivity(`Checking for a ${tool.name} at ${harrysShop.name}`);
        const harry = current().nearbyNpcs.find(npc => npc.id === 576);
        if (!harry) throw new Error('Harry was not visible at the Catherby fishing shop.');
        await requireAction('Open Harry’s Fishing Shop', bot.openShop(harry));
    }

    async function buyTool(tool: Stage['tool']) {
        await openFishingShop(tool);
        // In fresh stock the buy price is the standard price. Allow for
        // the largest stock-based increase while at least one remains.
        const shop = current().shop;
        const item = shop.shopItems.find(entry => entry.id === tool.id);
        if (!item?.count) throw new Error(`Harry’s Fishing Shop is out of ${tool.name}s.`);
        const multiplier = shop.shopConfig?.sellMultiplier ?? 1000;
        const haggle = shop.shopConfig?.haggle ?? 10;
        const budget = Math.max(1, Math.floor(item.baseCost * (multiplier + (tool.stock - 1) * haggle) / 1000));
        await requireAction('Close the fishing shop', bot.closeShop());
        await openBank(catherbyBank);
        const gold = current().bank.items.find(entry => entry.id === coins);
        if (!gold?.count) throw new Error(`No banked coins to buy a ${tool.name}.`);
        reportTaskActivity(`Withdrawing coins for a ${tool.name} at ${catherbyBank.name}`);
        await requireAction('Withdraw fishing supply money', bot.withdrawItem(gold, Math.min(gold.count, budget)));
        await requireAction('Close the bank', bot.closeBank());
        try {
            await openFishingShop(tool);
            const stock = current().shop.shopItems.find(entry => entry.id === tool.id);
            if (!stock?.count) throw new Error(`Harry’s Fishing Shop is out of ${tool.name}s.`);
            reportTaskActivity(`Buying a ${tool.name} at ${harrysShop.name}`);
            await requireAction(`Buy a ${tool.name}`, bot.buyFromShop(stock, 1));
        } finally {
            if (current().shop.isOpen) await requireAction('Close the fishing shop', bot.closeShop());
        }
    }

    async function prepareTool(tool: Stage['tool']) {
        await openBank(site.bank);
        await bankBackpack(site.bank, 'Banking the fishing catch', tool.id);
        const stored = current().bank.items.find(item => item.id === tool.id);
        if (!quantity(current(), tool.id) && stored) {
            reportTaskActivity(`Withdrawing a ${tool.name} at ${site.bank.name}`);
            await requireAction(`Withdraw a ${tool.name}`, bot.withdrawItem(stored, 1));
        }
        await requireAction('Close the bank', bot.closeBank());
        if (!quantity(current(), tool.id) && area === 'guild') {
            const spawn = guildToolSpawns[tool.id];
            if (!spawn) throw new Error(`No Fishing Guild spawn for a ${tool.name}.`);
            await walk({ name: `the ${tool.name} spawn`, x: spawn.approachX ?? spawn.x, z: spawn.z }, 0,
                `Reach the Fishing Guild ${tool.name} spawn`);
            reportTaskActivity(`Looking for a ${tool.name} inside the Fishing Guild`);
            for (let attempt = 0; attempt < 3 && !quantity(current(), tool.id); attempt++) {
                const item = (await sdk.scanGroundItems(3)).find(item => item.id === tool.id && item.x === spawn.x && item.z === spawn.z);
                if (item) await bot.pickupItem(item);
                if (!quantity(current(), tool.id)) await sdk.waitForTicks(3);
            }
        } else if (!quantity(current(), tool.id)) {
            try {
                await buyTool(tool);
            } finally {
                if (quantity(current(), coins)) {
                    await openBank(catherbyBank);
                    await bankBackpack(catherbyBank, 'Returning leftover supply coins', tool.id);
                    await requireAction('Close the bank', bot.closeBank());
                }
            }
        }
        if (!quantity(current(), tool.id)) throw new Error(`A ${tool.name} is required.`);
    }

    async function cookBackpack() {
        const fish = Object.values(rawFish).sort((a, b) => b.cooking - a.cooking);
        function nextFish() {
            const state = current();
            const cooking = skill(state, 'Cooking')?.level ?? 0;
            const recipe = fish.find(entry => entry.cooking <= cooking && quantity(state, entry.id));
            const item = state.inventory.find(item => item.id === recipe?.id);
            return recipe && item ? { recipe, item } : undefined;
        }

        if (!nextFish()) return;
        await walk(site.rangeApproach, site.rangeTolerance, `Reach ${site.range.name}`);
        const range = current().nearbyLocs.find(loc => loc.id === 2728 && loc.x === site.range.x && loc.z === site.range.z);
        if (!range) throw new Error(`${site.range.name} was not visible.`);
        const startingXp = skill(current(), 'Cooking')?.experience ?? 0;
        let processed = 0;
        let misses = 0;
        for (let next = nextFish(); next; next = nextFish()) {
            const { recipe, item } = next;
            const { id, name } = item;
            const count = quantity(current(), id);
            const action = misses ? 'Retrying cooking' : 'Cooking';
            reportTaskActivity(`${action} ${recipe.name} at ${site.range.name} - ${count} raw left`);
            const result = await bot.useItemOnLoc(item, range, { timeout: 5_000 });
            // Both a cook and a burn consume the raw fish. Reconcile the
            // inventory even when the SDK could not confirm the interaction.
            if (result.success) {
                await observe(state => quantity(state, id) < count, 5_000);
            }
            if (quantity(current(), id) >= count) await sdk.waitForTicks(2);
            const remaining = quantity(current(), id);
            if (remaining < count) {
                processed += count - remaining;
                if (misses) auditEvent('milestone', 'cooking-retry-recovered', { fish: id, misses });
                misses = 0;
                // Relaunching at the range resumes cooking any raw fish left in the backpack.
                await checkpoint?.();
                continue;
            }
            const message = result.success ? 'No raw fish was consumed.' : result.message;
            auditEvent('setback', 'cooking-action-unconfirmed', { fish: id, remaining, attempt: ++misses, message });
            if (misses >= 4) throw new Error(`Cooking ${name} at ${site.range.name} made no progress after ${misses} attempts. ${message}`);
        }
        auditEvent('milestone', 'cooking-batch-completed', {
            processed, area, xpGained: (skill(current(), 'Cooking')?.experience ?? 0) - startingXp,
        });
    }

    async function fishBackpack(stage: Stage) {
        await walk(site.start, area === 'guild' ? 0 : 3, `Reach ${site.start.name}`);
        let missed = 0;
        let searchStarted: number | undefined;
        const activityLabel = `Fishing for ${stage.label} at ${site.name}`;
        const catchCount = (state: BotWorldState) =>
            state.inventory.reduce((count, item) => count + (rawFishIds.has(item.id) ? item.count : 0), 0);
        const batchComplete = (state: BotWorldState) =>
            state.inventory.length >= capacity || selectFishingStage(state, cook, area) !== stage;
        function availableSpot(state: BotWorldState) {
            const nearby = state.nearbyNpcs
                .filter(npc => npc.id === stage.spot && npc.reachable !== false && npc.optionsWithIndex.some(option => stage.option.test(option.text)))
                .sort((a, b) => a.distance - b.distance);
            return nearby[missed % nearby.length];
        }
        async function searchSpots() {
            const { player } = current();
            const distance = (from: typeof player, point: Tile) =>
                Math.max(Math.abs(from.worldX - point.x), Math.abs(from.worldZ - point.z));
            const points = [...site.search].sort((a, b) => distance(player, a) - distance(player, b));
            for (const point of points) {
                const state = current();
                if (availableSpot(state) || batchComplete(state)) return;
                if (distance(state.player, point) <= 1) continue;
                // A ground click also clears an incidental level-up dialog.
                const move = await sdk.sendWalk(point.x, point.z);
                if (move.success) {
                    await observe(state => !!availableSpot(state) || batchComplete(state)
                        || (!!state.player && distance(state.player, point) <= 1), 12_000);
                }
            }
        }

        cast: while (!batchComplete(current())) {
            const spot = availableSpot(current());
            const option = spot?.optionsWithIndex.find(entry => stage.option.test(entry.text));
            if (!spot || !option) {
                if (searchStarted === undefined) {
                    searchStarted = Date.now();
                    const state = current();
                    auditEvent('setback', 'fishing-spot-unavailable', {
                        fish: stage.label, area, x: state.player.worldX, z: state.player.worldZ,
                        spots: state.nearbyNpcs.filter(npc => npc.id === stage.spot)
                            .map(npc => ({ x: npc.tileX ?? npc.x, z: npc.tileZ ?? npc.z, reachable: npc.reachable })),
                    });
                }
                reportTaskActivity(`Searching for a spot to catch ${stage.label} at ${site.name}`);
                await searchSpots();
                const state = current();
                if (availableSpot(state) || batchComplete(state)) continue;
                // Finish a partial load while waiting for the next spot.
                if (state.inventory.some(item => item.id !== stage.tool.id)) return;
                if (Date.now() - searchStarted >= shorelineSearchTimeout) {
                    throw new Error(`No reachable fishing spot for ${stage.label} at ${site.name}.`);
                }
                reportTaskActivity(`Waiting to recheck ${stage.label} spots at ${site.name}`);
                await sdk.waitForTicks(8);
                continue;
            }
            if (searchStarted !== undefined) {
                auditEvent('milestone', 'fishing-spot-reacquired', {
                    fish: stage.label, x: spot.tileX ?? spot.x, z: spot.tileZ ?? spot.z,
                });
                searchStarted = undefined;
            }
            const before = current();
            let caught = catchCount(before);
            if (before.dialog.isOpen || missed) reportTaskActivity(`Recasting for ${stage.label} at ${site.name}`);
            else reportTaskActivity(activityLabel);
            const stillHere = (state: BotWorldState) =>
                state.nearbyNpcs.some(npc => npc.index === spot.index && npc.id === spot.id
                    && (npc.tileX ?? npc.x) === (spot.tileX ?? spot.x) && (npc.tileZ ?? npc.z) === (spot.tileZ ?? spot.z));
            // Clicking a fishing spot clears a level-up dialog and starts a
            // new cast. The high-level interaction would click Continue first.
            const action = await sdk.sendInteractNpc(spot.index, option.opIndex);
            let closingPreviousDialog = before.dialog.isOpen;
            let xp = skill(before, 'Fishing')?.experience ?? 0;
            let failure = action.message;
            while (action.success) {
                failure = closingPreviousDialog ? 'The dialog stayed open after recasting.' : 'No catch or Fishing XP was observed after casting.';
                const state = await observe(state => batchComplete(state) || !stillHere(state)
                    || catchCount(state) > caught || (skill(state, 'Fishing')?.experience ?? 0) > xp
                    || (closingPreviousDialog ? state.tick > before.tick && !state.dialog.isOpen : state.dialog.isOpen),
                closingPreviousDialog ? 5_000 : 35_000);
                if (!state) break;
                current();
                const gained = skill(state, 'Fishing')?.experience ?? 0;
                const count = catchCount(state);
                const progressed = count > caught || gained > xp;
                if (progressed) {
                    missed = 0;
                    xp = gained;
                    caught = count;
                    reportTaskActivity(`${activityLabel} - ${caught} fish in backpack`);
                }
                if (batchComplete(state)) return;
                if (closingPreviousDialog && state.tick > before.tick && !state.dialog.isOpen) {
                    closingPreviousDialog = false;
                    auditEvent('milestone', 'fishing-recast-closed-dialog', { spot: spot.id, npcIndex: spot.index });
                    if (!progressed) reportTaskActivity(activityLabel);
                }
                if (!stillHere(state) || (!closingPreviousDialog && state.dialog.isOpen)) continue cast;
            }
            if (batchComplete(current())) return;
            if (++missed >= 6) throw new Error(`Could not sustain fishing for ${stage.label}: ${failure}`);
            reportTaskActivity(`Waiting to recast for ${stage.label} at ${site.name}`);
            await sdk.waitForTicks(2);
        }
    }

    const { player } = current();
    if (player.level !== 0) throw new Error('Start this activity on the surface.');
    if (area === 'guild') {
        selectFishingStage(current(), cook, area);
        auditEvent('phase', 'fishing-travel-to-guild');
        await enterGuild();
        if (current().bank.isOpen) await requireAction('Close the bank', bot.closeBank());
        if (current().shop.isOpen) await requireAction('Close the shop', bot.closeShop());
    }
    // A restarted cook task can still be carrying the batch it was working on.
    if (cook && (area === 'guild' || Math.max(Math.abs(player.worldX - catherbyRange.x), Math.abs(player.worldZ - catherbyRange.z)) <= 3)) {
        await cookBackpack();
    }
    const nearestBank = area === 'guild' ? site.bank : banks.reduce((nearest, candidate) =>
        Math.max(Math.abs(candidate.x - player.worldX), Math.abs(candidate.z - player.worldZ)) <
        Math.max(Math.abs(nearest.x - player.worldX), Math.abs(nearest.z - player.worldZ)) ? candidate : nearest);
    auditEvent('phase', 'fishing-bank-starting-items', { area });
    await openBank(nearestBank);
    await bankBackpack(nearestBank, 'Banking starting items');
    const worn = current().equipment;
    if (worn.length) {
        reportTaskActivity('Removing worn gear to bank before fishing');
        await requireAction('Close the bank', bot.closeBank());
        for (const item of worn) await requireAction(`Remove ${item.name}`, bot.unequipItem(item));
        await openBank(nearestBank);
        await bankBackpack(nearestBank, 'Banking worn gear');
    }
    if (current().inventory.length || current().equipment.length) throw new Error('Starting items were not fully banked.');
    await requireAction('Close the bank', bot.closeBank());
    auditEvent('milestone', 'fishing-starting-items-banked', { area });
    if (area === 'catherby') {
        auditEvent('phase', 'fishing-travel-to-catherby');
        await walk(catherbyBank, 3, 'Reach Catherby');
    }

    let previousStage: Stage | undefined;
    for (;;) {
        const stage = selectFishingStage(current(), cook, area);
        if (stage !== previousStage) {
            auditEvent('phase', stage.fish === rawFish.shark ? 'fishing-sharks' : 'fishing-training',
                { fish: stage.label, cook, area });
            previousStage = stage;
        }
        await prepareTool(stage.tool);
        // The bank closed and the next cast has not been sent.
        await checkpoint?.();
        await fishBackpack(stage);
        if (cook) await cookBackpack();
    }
}

if (import.meta.main) {
    reportTaskActivity('Connecting to the game to start fishing');
    await runScript(withTaskUpdateCheckpoints((context, checkpoint) => fishSharks(context,
        cookingActivity || process.argv.includes('--cook'), checkpoint,
        guildActivity || process.argv.includes('--guild') ? 'guild' : 'catherby')));
}

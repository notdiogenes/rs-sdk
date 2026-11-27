import { auditEvent } from '../../sdk/audit-trace';
import { runScript, type ScriptContext } from '../../sdk/runner';
import type { BotWorldState } from '../../sdk/types';
import { miningBanks } from '../mining-routes';

const catherbyBank = { x: 2809, z: 3441 };
const catherbyRange = { x: 2817, z: 3444 };
const harrysShop = { x: 2834, z: 3445 };
const beach = { x: 2845, z: 3433 };
const banks = [catherbyBank, { x: 2655, z: 3284 }, ...Object.values(miningBanks)];
const capacity = 28;
const coins = 995;

const rawFish = {
    shrimp: { id: 317, cooking: 1 }, anchovies: { id: 321, cooking: 1 },
    mackerel: { id: 353, cooking: 10 }, cod: { id: 341, cooking: 18 }, bass: { id: 363, cooking: 43 },
    tuna: { id: 359, cooking: 30 }, swordfish: { id: 371, cooking: 45 },
    lobster: { id: 377, cooking: 40 }, shark: { id: 383, cooking: 80 },
};

type Stage = {
    label: string;
    level: number;
    spot: number;
    option: RegExp;
    tool: { id: number; name: string; stock: number };
    fish: (typeof rawFish)[keyof typeof rawFish];
};

// The Catherby NPCs named Fishing spot have different catches even when
// their options have the same label. Match their NPC types as well.
const stages: Stage[] = [
    { label: 'shrimp and anchovies', level: 1, spot: 320, option: /^net$/i,
        tool: { id: 303, name: 'small fishing net', stock: 5 }, fish: rawFish.shrimp },
    { label: 'mackerel and cod', level: 16, spot: 322, option: /^net$/i,
        tool: { id: 305, name: 'big fishing net', stock: 5 }, fish: rawFish.mackerel },
    { label: 'tuna', level: 35, spot: 321, option: /^harpoon$/i,
        tool: { id: 311, name: 'harpoon', stock: 2 }, fish: rawFish.tuna },
    { label: 'lobsters', level: 40, spot: 321, option: /^cage$/i,
        tool: { id: 301, name: 'lobster pot', stock: 2 }, fish: rawFish.lobster },
    { label: 'sharks', level: 76, spot: 322, option: /^harpoon$/i,
        tool: { id: 311, name: 'harpoon', stock: 2 }, fish: rawFish.shark },
];

function skill(state: BotWorldState, name: 'Fishing' | 'Cooking') {
    return state.skills.find(entry => entry.name === name);
}

export function selectFishingStage(state: BotWorldState, cook: boolean) {
    const fishing = skill(state, 'Fishing')?.level;
    const cooking = cook ? skill(state, 'Cooking')?.level : undefined;
    if (fishing === undefined || (cook && cooking === undefined)) throw new Error('Fishing or Cooking level is unavailable.');
    // If Cooking has fallen behind, keep catching a fish that can grant
    // Cooking XP, including when Fishing already qualifies for sharks.
    const stage = stages.findLast(entry => fishing >= entry.level && (cooking === undefined || cooking >= entry.fish.cooking));
    if (!stage) throw new Error('No Catherby fishing method is available at the current levels.');
    return stage;
}

const quantity = (state: BotWorldState, id: number) =>
    state.inventory.reduce((count, item) => count + (item.id === id ? item.count : 0), 0);

export async function fishSharks({ bot, sdk }: ScriptContext, cook = process.env.RS_ACTIVITY === 'fish-sharks-cook') {
    await sdk.waitForReady();

    function current() {
        const state = sdk.getState();
        if (!state?.inGame || !state.player || state.player.isDead || sdk.getStateAge() > 10_000) {
            throw new Error('Fishing requires a fresh game state and a living player.');
        }
        return { ...state, player: state.player };
    }

    async function requireAction(label: string, action: Promise<{ success: boolean; message: string }>) {
        const result = await action;
        if (!result.success) throw new Error(`${label}: ${result.message}`);
    }

    async function walk(target: { x: number; z: number }, tolerance: number, label: string) {
        await requireAction(label, bot.walkTo(target.x, target.z, tolerance));
    }

    async function openBank(target: { x: number; z: number }) {
        if (current().bank.isOpen) return;
        await walk(target, 3, 'Reach the bank');
        await bot.dismissBlockingUI();
        if (current().interface?.isOpen) await requireAction('Close the open interface', bot.closeInterface());
        await requireAction('Open the bank', bot.openBank());
        if (!current().bank.isOpen) throw new Error('The bank did not open.');
    }

    async function bankBackpack(keepId?: number) {
        const deposit = current().inventory.filter(item => item.id !== keepId);
        for (const id of new Set(deposit.map(item => item.id))) {
            const item = current().inventory.find(entry => entry.id === id);
            if (!item) continue;
            await requireAction(`Deposit ${item.name}`, bot.depositItem(item, -1));
            if (quantity(current(), id)) throw new Error(`Deposit of ${item.name} was not confirmed.`);
        }
    }

    async function openFishingShop() {
        await walk(harrysShop, 4, 'Reach Harry’s Fishing Shop');
        const harry = current().nearbyNpcs.find(npc => npc.id === 576);
        if (!harry) throw new Error('Harry was not visible at the Catherby fishing shop.');
        await requireAction('Open Harry’s Fishing Shop', bot.openShop(harry));
    }

    async function buyTool(tool: Stage['tool']) {
        await openFishingShop();
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
        await requireAction('Withdraw fishing supply money', bot.withdrawItem(gold, Math.min(gold.count, budget)));
        await requireAction('Close the bank', bot.closeBank());
        try {
            await openFishingShop();
            const stock = current().shop.shopItems.find(entry => entry.id === tool.id);
            if (!stock?.count) throw new Error(`Harry’s Fishing Shop is out of ${tool.name}s.`);
            await requireAction(`Buy a ${tool.name}`, bot.buyFromShop(stock, 1));
        } finally {
            if (current().shop.isOpen) await requireAction('Close the fishing shop', bot.closeShop());
        }
    }

    async function prepareTool(tool: Stage['tool']) {
        await openBank(catherbyBank);
        await bankBackpack(tool.id);
        const stored = current().bank.items.find(item => item.id === tool.id);
        if (!quantity(current(), tool.id) && stored) {
            await requireAction(`Withdraw a ${tool.name}`, bot.withdrawItem(stored, 1));
        }
        await requireAction('Close the bank', bot.closeBank());
        if (!quantity(current(), tool.id)) {
            try {
                await buyTool(tool);
            } finally {
                if (quantity(current(), coins)) {
                    await openBank(catherbyBank);
                    await bankBackpack(tool.id);
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
            return state.inventory.find(item => item.id === recipe?.id);
        }

        if (!nextFish()) return;
        await walk(catherbyRange, 3, 'Reach the Catherby range');
        const range = current().nearbyLocs.find(loc => loc.id === 2728 && loc.x === catherbyRange.x && loc.z === catherbyRange.z);
        if (!range) throw new Error('The Catherby range was not visible.');
        for (let item = nextFish(); item; item = nextFish()) {
            const { id, name } = item;
            const count = quantity(current(), id);
            await requireAction(`Use ${name} on the range`, bot.useItemOnLoc(item, range));
            // A burn still consumes the raw fish, so XP is not a reliable
            // completion signal for an individual cook.
            await sdk.waitForCondition(state => quantity(state, id) < count, 10_000);
        }
    }

    async function fishBackpack(stage: Stage) {
        await walk(beach, 3, 'Reach the Catherby fishing spots');
        let missed = 0;
        const batchComplete = (state: BotWorldState) =>
            state.inventory.length >= capacity || selectFishingStage(state, cook) !== stage;
        cast: while (!batchComplete(current())) {
            const nearby = current().nearbyNpcs
                .filter(npc => npc.id === stage.spot && npc.reachable !== false && npc.optionsWithIndex.some(option => stage.option.test(option.text)))
                .sort((a, b) => a.distance - b.distance);
            const spot = nearby[missed % nearby.length];
            const option = spot?.optionsWithIndex.find(entry => stage.option.test(entry.text));
            if (!spot || !option) {
                if (++missed >= 6) throw new Error(`No reachable Catherby fishing spot for ${stage.label}.`);
                await sdk.waitForTicks(4);
                continue;
            }
            const before = current();
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
                failure = closingPreviousDialog ? 'The dialog stayed open after recasting.' : 'No Fishing XP was observed after casting.';
                const state = await sdk.waitForCondition(state =>
                    !state.inGame || !!state.player?.isDead || batchComplete(state) || !stillHere(state)
                    || (skill(state, 'Fishing')?.experience ?? 0) > xp
                    || (closingPreviousDialog ? state.tick > before.tick && !state.dialog.isOpen : state.dialog.isOpen),
                closingPreviousDialog ? 5_000 : 35_000).catch(error => {
                    if (error instanceof Error && error.message === 'waitForCondition timed out') return null;
                    throw error;
                });
                if (!state) break;
                current();
                const gained = skill(state, 'Fishing')?.experience ?? 0;
                if (gained > xp) {
                    missed = 0;
                    xp = gained;
                }
                if (batchComplete(state)) return;
                if (closingPreviousDialog && state.tick > before.tick && !state.dialog.isOpen) {
                    closingPreviousDialog = false;
                    auditEvent('milestone', 'fishing-recast-closed-dialog', { spot: spot.id, npcIndex: spot.index });
                }
                if (!stillHere(state) || (!closingPreviousDialog && state.dialog.isOpen)) continue cast;
            }
            if (batchComplete(current())) return;
            if (++missed >= 6) throw new Error(`Could not sustain fishing for ${stage.label}: ${failure}`);
            await sdk.waitForTicks(2);
        }
    }

    const { player } = current();
    if (player.level !== 0) throw new Error('Start this activity on the surface.');
    const nearestBank = banks.reduce((nearest, candidate) =>
        Math.max(Math.abs(candidate.x - player.worldX), Math.abs(candidate.z - player.worldZ)) <
        Math.max(Math.abs(nearest.x - player.worldX), Math.abs(nearest.z - player.worldZ)) ? candidate : nearest);
    auditEvent('phase', 'fishing-bank-starting-items');
    await openBank(nearestBank);
    await bankBackpack();
    const worn = current().equipment;
    if (worn.length) {
        await requireAction('Close the bank', bot.closeBank());
        for (const item of worn) await requireAction(`Remove ${item.name}`, bot.unequipItem(item));
        await openBank(nearestBank);
        await bankBackpack();
    }
    if (current().inventory.length || current().equipment.length) throw new Error('Starting items were not fully banked.');
    await requireAction('Close the bank', bot.closeBank());
    auditEvent('milestone', 'fishing-starting-items-banked');
    auditEvent('phase', 'fishing-travel-to-catherby');
    await walk(catherbyBank, 3, 'Reach Catherby');

    let previousStage: Stage | undefined;
    for (;;) {
        const stage = selectFishingStage(current(), cook);
        if (stage !== previousStage) {
            auditEvent('phase', stage.fish === rawFish.shark ? 'fishing-sharks' : 'fishing-training',
                { fish: stage.label, cook });
            previousStage = stage;
        }
        await prepareTool(stage.tool);
        await fishBackpack(stage);
        if (cook) await cookBackpack();
    }
}

if (import.meta.main) {
    await runScript(context => fishSharks(context,
        process.env.RS_ACTIVITY === 'fish-sharks-cook' || process.argv.includes('--cook')));
}

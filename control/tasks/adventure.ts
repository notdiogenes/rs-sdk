import { auditEnabled, auditEvent, auditFrame, auditOperation } from '../../sdk/audit-trace';
import { throwIfExecutionAborted } from '../../sdk/execution-context';
import type { ScriptContext } from '../../sdk/runner';
import type { InventoryItem, NearbyNpc } from '../../sdk/types';
import { activity } from '../dashboard-task-catalog';

const swords = [
    [30, 'Adamant longsword'], [20, 'Mithril longsword'], [5, 'Steel longsword'], [1, 'Iron longsword'],
] as const;
const heal = /^(?:bread|cake|2\/3 cake|slice of cake|chocolate slice|cooked chicken|cooked meat|shrimp|trout|salmon|jug of wine)$/i;
// Coins, runes, fire orb, diamond, gold ore, and empty jugs from Hero wine.
const pickpocketLoot = new Set([995, 562, 560, 565, 569, 1601, 444, 1935]);
const wine = 1993;
// Bank items lack inventory options. Use unnoted IDs so raw or noted supplies are never mistaken for food.
const bankFood = new Set([
    315, 319, 325, 329, 333, 339, 347, 351, 355, 361, 365, 373, 379, 385, 391, 397, // Cooked fish.
    1891, 1893, 1895, 1897, 1899, 1901, wine, 2140, 2142, 2309, // Cakes, wine, cooked meat, and bread.
]);
const isPickpocketFood = (item: InventoryItem) =>
    bankFood.has(item.id) && item.optionsWithIndex.some(option => /^(eat|drink)$/i.test(option.text));
const foodTarget = 8;
const inventoryCapacity = 28;
const bankAt = inventoryCapacity - 2;
const lootBatch = 100;
const foodRetryMs = 5 * 60_000;
const attackable = /^attack$/i;
const pocket = /^pickpocket$/i;
const guards = /^guard$/i;
const knights = /^knight of ardougne$/i;
const paladins = /^paladin$/i;
const heroes = /^hero$/i;
// Knight of Ardougne spawn tiles in m41_51.
const knightSpots = [[2652, 3318], [2653, 3300], [2669, 3298], [2671, 3313]] as const;
const guardSpots = [[2651, 3307], [2660, 3308], [2635, 3339]] as const;
const paladinSpots = [[2653, 3315], [2657, 3307]] as const;
const heroSpots = [[2630, 3288], [2642, 3297], [2652, 3318]] as const;
const log = (stage: string, fields: object = {}) =>
    console.log('[pickpocket-demo] ' + JSON.stringify({ stage, ...fields }));

const men = /^man$/i;
const manSpots = [[3222, 3218], [3221, 3228], [3231, 3237]] as const;
const isMissingPickpocketTarget = (reason?: string) =>
    reason === 'target_not_found' || reason === 'npc_not_found' || reason === 'no_pickpocket_option';

export type PickpocketTarget = 'men' | 'guards' | 'knights' | 'paladins' | 'heroes' | 'adaptive';

function npcEvidence(npc: NearbyNpc, action = pocket) {
    const option = npc.optionsWithIndex.find(entry => action.test(entry.text));
    return { id: npc.id, name: npc.name, index: npc.index, x: npc.tileX ?? npc.x, z: npc.tileZ ?? npc.z,
        distance: npc.distance, reachable: npc.reachable, option: option?.text, optionIndex: option?.opIndex };
}

export function adventure({ bot, sdk }: ScriptContext) {
    const world = () => sdk.getState();
    const actionResult = (result: { success: boolean; message: string; reason?: string }) =>
        ({ outcome: result.success ? 'confirmed' : 'failed', sdk: { success: result.success, message: result.message, reason: result.reason } });
    const waitTicks = (ticks: number, intent: string, auditing: boolean) => {
        const until = (sdk.getState()?.tick ?? 0) + ticks;
        const wait = () => sdk.waitForTicks(ticks);
        return auditing ? auditOperation('wait-ticks', intent, { ticks, until }, world, wait,
            () => ({ outcome: 'elapsed', tick: sdk.getState()?.tick, hp: sdk.getState()?.player?.hp })) : wait();
    };
    const level = (name: string) => sdk.getSkill(name)?.baseLevel ?? 0;
    const distance = (x: number, z: number) => {
        const p = sdk.getState()?.player;
        return p && p.level === 0 ? Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) : Infinity;
    };
    const metrics = () => {
        const state = sdk.getState();
        const p = state?.player;
        return {
            tick: state?.tick, x: p?.worldX, z: p?.worldZ, hp: p?.hp, maxHp: p?.maxHp,
            hitpoints: level('Hitpoints'), hitpointsXp: sdk.getSkill('Hitpoints')?.experience,
            attack: level('Attack'), strength: level('Strength'), defence: level('Defence'),
            thieving: level('Thieving'), thievingXp: sdk.getSkill('Thieving')?.experience,
            coins: sdk.countInventoryItems(/^coins$/i),
        };
    };
    const closest = (name: RegExp, option: RegExp, combat = false, eligible?: (npc: NearbyNpc) => boolean) =>
        sdk.getState()?.nearbyNpcs.filter(npc => name.test(npc.name) && npc.reachable !== false &&
            npc.optionsWithIndex.some(entry => option.test(entry.text)) && (!combat || !npc.inCombat) && (!eligible || eligible(npc)))
            .sort((a, b) => a.distance - b.distance)[0];
    const travel = async (x: number, z: number, tolerance: number, timeout: number, auditing = false, intent = 'Reach the next activity waypoint') => {
        if (distance(x, z) <= tolerance) {
            if (auditing) auditEvent('decision', 'walk-to', { intent, outcome: 'skipped', reason: 'already-within-tolerance', x, z, tolerance });
            return true;
        }
        const before = auditing ? auditFrame(sdk.getState()) : undefined;
        const began = auditing ? performance.now() : 0;
        const walk = () => bot.walkTo(x, z, tolerance, { timeout });
        const destination = { x, z, tolerance, timeout };
        const walked = await (auditing ? auditOperation('walk-to', intent, destination, world, walk, result => ({
            outcome: distance(x, z) <= tolerance ? 'arrived' : 'arrival-unconfirmed',
            distance: distance(x, z), sdk: actionResult(result).sdk,
        })) : walk());
        const arrived = distance(x, z) <= tolerance;
        if (auditing) auditEvent('check', 'activity-travel', {
            outcome: arrived ? 'complete' : 'failed', destination: { x, z, tolerance, timeout },
            elapsedMs: Math.round(performance.now() - began), before, after: auditFrame(sdk.getState()),
            sdk: { success: walked.success, reason: walked.reason, message: walked.message },
        });
        if (!arrived) log('walk-incomplete', { destination: [x, z], message: walked.message, ...metrics() });
        return arrived;
    };
    const buySwords = async () => {
        if (swords.every(([, name]) => sdk.findInventoryItem(name) || sdk.getState()?.equipment.some(item => item.name === name))) return;
        if (!await travel(3203, 3397, 3, 110_000)) return;
        const keeper = closest(/^shop (?:keeper|assistant)$/i, /trade/i);
        if (!keeper || !(await bot.openShop(keeper)).success) return;
        try {
            const stock = sdk.getState()?.shop.shopItems ?? [];
            for (const [, name] of [...swords].reverse()) {
                if (sdk.findInventoryItem(name) || sdk.getState()?.equipment.some(item => item.name === name)) continue;
                const offer = stock.find(item => item.name === name && item.count > 0);
                if (offer) {
                    const bought = await bot.buyFromShop(name, 1);
                    log('equipment-purchase', { item: name, bought: bought.amountBought ?? 0, ...metrics() });
                }
            }
        } finally {
            await bot.closeShop();
        }
    };
    const equipBest = async () => {
        const equipped = sdk.getState()?.equipment.find(item => item.slot === 3);
        for (const [required, name] of swords) {
            if (level('Attack') < required) continue;
            if (equipped?.name === name) return;
            const item = sdk.findInventoryItem(name);
            if (item && (await bot.equipItem(item)).success) {
                log('equipment-upgrade', { item: name, ...metrics() });
                return;
            }
        }
        if (!equipped) {
            const starter = sdk.findInventoryItem(/bronze (?:sword|dagger|axe)/i);
            if (starter) await bot.equipItem(starter);
        }
    };
    const trainStyle = async () => {
        const goalAttack = level('Attack') < 30;
        const skill = goalAttack && level('Attack') <= level('Strength') + 7 ? 'Attack'
            : level('Defence') < 20 && level('Hitpoints') >= 20 && level('Strength') >= 25 ? 'Defence' : 'Strength';
        const style = sdk.getState()?.combatStyle;
        const next = style?.styles.find(entry => entry.trainsSkills.includes(skill));
        if (style && next && style.currentStyle !== next.index) {
            const selected = await sdk.sendSetCombatStyle(next.index);
            if (selected.success) {
                await sdk.waitForCondition(s => s.combatStyle?.currentStyle === next.index, 6000).catch(() => {});
            }
        }
    };
    const waitAlive = async (auditing = false) => {
        if (!sdk.getState()?.player?.isDead) return;
        log('death', metrics());
        if (auditing) auditEvent('setback', 'activity-death', { before: auditFrame(sdk.getState()) });
        const wait = () => sdk.waitForCondition(s => s.inGame && !!s.player && !s.player.isDead, 90_000);
        await (auditing ? auditOperation('wait-for-respawn', 'The player is dead. Wait for a living player before resuming the activity.',
            { timeoutMs: 90_000 }, world, wait, () => ({ outcome: 'respawn-observed' })) : wait());
        if (auditing) auditEvent('milestone', 'activity-respawned', { after: auditFrame(sdk.getState()) });
    };
    const eat = async (auditing = false, useBankFood = false) => {
        const food = useBankFood ? sdk.getInventory().find(isPickpocketFood) : sdk.findInventoryItem(heal);
        if (!food) {
            if (auditing) auditEvent('decision', 'eat-food', { intent: 'Restore HP before continuing', outcome: 'skipped', reason: 'no-matching-food' });
            if (auditing) auditEvent('setback', 'out-of-food', { before: auditFrame(sdk.getState()) });
            return false;
        }
        const before = auditing ? auditFrame(sdk.getState()) : undefined;
        const eatFood = () => bot.eatFood(food);
        const eaten = await (auditing ? auditOperation('eat-food', 'Restore HP before continuing', { item: food.name, id: food.id, slot: food.slot },
            world, eatFood, result => ({ ...actionResult(result), hpGained: result.hpGained })) : eatFood());
        if (auditing) auditEvent(eaten.success ? 'milestone' : 'setback', eaten.success ? 'food-eaten' : 'food-eat-failed', {
            item: { id: food.id, name: food.name, count: food.count }, before, after: auditFrame(sdk.getState()), message: eaten.message,
        });
        return eaten.success;
    };
    const rest = async (minimum: number, resupply?: () => Promise<void>, auditing = false, useBankFood = false) => {
        await waitAlive(auditing);
        if (!sdk.getState()?.player || (sdk.getState()?.player?.hp ?? 0) >= minimum) return;
        log('recovering', { minimum, ...metrics() });
        if (auditing) auditEvent('setback', 'low-hp', { minimum, before: auditFrame(sdk.getState()) });
        while ((sdk.getState()?.player?.hp ?? 0) < minimum) {
            await waitAlive(auditing);
            if (!await eat(auditing, useBankFood)) {
                await resupply?.();
                await waitTicks(12, 'Food did not restore HP. Wait for another recovery opportunity before checking HP again.', auditing);
            }
        }
        log('recovered', metrics());
        if (auditing) auditEvent('milestone', 'hp-recovered', { minimum, after: auditFrame(sdk.getState()) });
    };

    async function trainHitpoints(goal: number, shop = false) {
        let current = '';
        const phase = (name: string) => {
            if (!auditEnabled || current === name) return;
            current = name;
            auditEvent('phase', name, { state: auditFrame(sdk.getState()) });
        };
        phase('combat-requirements');
        if (level('Hitpoints') < goal) {
            log('training-hitpoints', { goal: Number.isFinite(goal) ? goal : undefined, ...metrics() });
            if (shop) {
                phase('combat-supplies');
                await buySwords().catch(error => {
                    log('equipment-shop-unavailable', { message: String(error) });
                    auditEvent('setback', 'combat-equipment-shop-error', { message: String(error) });
                });
            }
            let misses = 0;
            let lastLevel = level('Hitpoints');
            let lastXp = sdk.getSkill('Hitpoints')?.experience;
            const reportXp = () => {
                const xp = sdk.getSkill('Hitpoints')?.experience;
                if (xp != null && lastXp != null && xp > lastXp) {
                    auditEvent('milestone', 'combat-round-xp-gained', { xpGained: xp - lastXp, after: auditFrame(sdk.getState()) });
                }
                lastXp = xp;
            };
            while (level('Hitpoints') < goal) {
                if (auditEnabled && sdk.getState()?.player?.isDead) phase('combat-respawn');
                await waitAlive(auditEnabled);
                const stronger = level('Attack') >= 12 && level('Hitpoints') >= 15;
                const spots = stronger ? [[3154, 3325], [3156, 3342]] as const : [[3225, 3300], [3185, 3277]] as const;
                const targetName = stronger ? /^(?:cow|cow calf)$/i : /^chicken$/i;
                const spot = spots[misses % spots.length] ?? spots[0];
                const player = sdk.getState()?.player;
                if (!player) throw new Error('Player state unavailable in Hitpoints phase');
                if (player.combat.inCombat) {
                    phase('combat-fight');
                    if (player.hp <= Math.max(3, Math.floor(player.maxHp / 4)) && !await eat(auditEnabled)) {
                        phase('combat-retreat');
                        const walked = await bot.walkTo(player.worldX, player.worldZ + 12, 2, { timeout: 10_000 });
                        auditEvent('setback', 'combat-emergency-retreat', { hp: player.hp, success: walked.success, message: walked.message, after: auditFrame(sdk.getState()) });
                    }
                    await sdk.waitForTicks(2);
                    continue;
                }
                reportXp();
                const minimum = Math.max(5, Math.ceil(player.maxHp * 0.45));
                if (player.hp < minimum) phase('combat-recovery');
                await rest(minimum, undefined, auditEnabled);
                await equipBest();
                await trainStyle();
                const target = closest(targetName, attackable, true);
                if (!target) {
                    phase('combat-search');
                    auditEvent('setback', 'combat-target-unavailable', { npc: targetName.source, waypoint: spot, misses, state: auditFrame(sdk.getState()) });
                    if (distance(spot[0], spot[1]) > 5) await travel(spot[0], spot[1], 4, 80_000, auditEnabled);
                    misses++;
                    if (misses % 12 === 0) log('combat-rescan', { npc: stronger ? 'Cow' : 'Chicken', ...metrics() });
                    await sdk.waitForTicks(3);
                    continue;
                }
                phase('combat-fight');
                const attack = await bot.attack(target);
                auditEvent(attack.success ? 'milestone' : 'setback', attack.success ? 'combat-engaged' : 'combat-engage-failed',
                    { target: npcEvidence(target, attackable), reason: attack.reason, message: attack.message, after: auditFrame(sdk.getState()) });
                if (attack.success) misses = 0;
                else if (++misses % 10 === 0) log('combat-retry', { reason: attack.reason, npc: target.name, ...metrics() });
                await sdk.waitForTicks(2);
                if (level('Hitpoints') > lastLevel) {
                    lastLevel = level('Hitpoints');
                    log('hitpoints-level', metrics());
                    auditEvent('milestone', 'hitpoints-level', { level: lastLevel });
                }
            }
            reportXp();
        }
        log('hitpoints-goal-reached', { goal, ...metrics() });
        auditEvent('milestone', 'hitpoints-goal-reached', { goal, level: level('Hitpoints') });
    }

    const goToArdougne = async (auditing = false) => {
        if (distance(2662, 3305) <= 50) return;
        log('travelling-to-ardougne', metrics());
        for (let attempt = 0; attempt < 4; attempt++) {
            if (await travel(2662, 3305, 8, 210_000, auditing, 'Reach East Ardougne, where the selected pickpocket targets are located')) return;
            await waitAlive(auditing);
        }
        throw new Error('Could not verify East Ardougne arrival');
    };
    const buyFood = async (auditing = false) => {
        if (!await travel(2654, 3311, 4, 35_000, auditing, 'Reach the baker to buy food for HP recovery')) return;
        const baker = closest(/^baker$/i, /trade/i);
        const opened = baker && await auditOperation('open-food-shop', 'Inspect the baker’s stock for food within the recovery supplies list',
            { target: npcEvidence(baker, /trade/i) }, world, () => bot.openShop(baker), actionResult);
        if (!opened?.success) {
            if (auditing && !baker) auditEvent('decision', 'open-food-shop', { intent: 'Buy recovery food', outcome: 'skipped', reason: 'no-reachable-baker' });
            if (auditing) auditEvent('setback', 'thieving-food-shop-unavailable', { baker: baker?.index, message: opened?.message, state: auditFrame(sdk.getState()) });
            return;
        }
        try {
            let boughtCount = 0;
            for (const [name, limit] of [['Cake', 3], ['Chocolate slice', 8], ['Bread', 10]] as const) {
                const item = sdk.getState()?.shop.shopItems.find(entry => entry.name === name && entry.count > 0);
                if (!item) {
                    if (auditing) auditEvent('decision', 'buy-food', { intent: 'Restock recovery food', outcome: 'skipped', reason: 'out-of-stock', item: name });
                    continue;
                }
                const quantity = Math.min(limit, item.count);
                const bought = await auditOperation('buy-food', 'Buy an available recovery food up to its per-trip limit',
                    { item: name, quantity, stock: item.count, coins: sdk.countInventoryItems(/^coins$/i) }, world,
                    () => bot.buyFromShop(name, quantity), result => ({ ...actionResult(result),
                        outcome: result.partial ? 'partially-bought' : result.success ? 'confirmed' : 'failed',
                        amountBought: result.amountBought }));
                if (bought.amountBought) log('food-restock', { item: name, bought: bought.amountBought, ...metrics() });
                boughtCount += bought.amountBought ?? 0;
                if (auditing && !bought.amountBought) auditEvent('setback', 'thieving-food-purchase-failed', {
                    item: name, stock: item.count, message: bought.message, coins: sdk.countInventoryItems(/^coins$/i),
                });
            }
            if (auditing) auditEvent(boughtCount ? 'milestone' : 'setback', boughtCount ? 'thieving-food-restocked' : 'thieving-food-restock-empty', {
                bought: boughtCount, after: auditFrame(sdk.getState()),
            });
        } finally {
            await auditOperation('close-food-shop', 'Leave the shop and restore access to the inventory', {}, world, () => bot.closeShop(), actionResult);
        }
    };
    const bankLoot = async (auditing = false) => {
        if (!await travel(2656, 3283, 4, 40_000, auditing, 'Reach the bank to free inventory slots for pickpocket loot')) return;
        const opened = await auditOperation('open-bank', 'Open the bank to deposit loot', {}, world, () => bot.openBank(), actionResult);
        if (!opened.success) {
            if (auditing) auditEvent('setback', 'thieving-bank-unavailable', { message: opened.message, state: auditFrame(sdk.getState()) });
            return;
        }
        const slotsBefore = auditing ? sdk.getInventory().length : 0;
        try {
            for (const name of new Set(sdk.getInventory().map(item => item.name))) {
                if (/^coins$/i.test(name) || heal.test(name)) {
                    if (auditing) auditEvent('decision', 'bank-deposit', { intent: 'Keep coins and food available for recovery', outcome: 'skipped', item: name });
                    continue;
                }
                const deposited = await auditOperation('bank-deposit', 'Free slots by depositing all copies of this item',
                    { item: name, amount: 'all' }, world, () => bot.depositItem(name, -1), result => ({
                        ...actionResult(result), outcome: result.partial ? 'partially-deposited' : result.success ? 'confirmed' : 'failed',
                        amountDeposited: result.amountDeposited,
                    }));
                if (auditing && !deposited.success) auditEvent('setback', 'thieving-deposit-failed', { item: name, message: deposited.message });
            }
            if (auditing) {
                const slotsAfter = sdk.getInventory().length;
                const freed = slotsAfter < slotsBefore;
                auditEvent(freed ? 'milestone' : 'setback', freed ? 'thieving-bank-freed-slots' : 'thieving-bank-no-slots-freed',
                    { slotsBefore, slotsAfter, after: auditFrame(sdk.getState()) });
            }
        } finally {
            await auditOperation('close-bank', 'Close the bank to resume normal actions', {}, world, () => bot.closeBank(), actionResult);
        }
    };
    const foodSlots = () => sdk.getInventory().filter(isPickpocketFood).length;
    const lootAmount = (id: number) => sdk.getInventory().filter(item => item.id === id).reduce((sum, item) => sum + item.count, 0);
    const bankableLoot = (item: InventoryItem) =>
        pickpocketLoot.has(item.id) || (item.id === wine && foodSlots() > foodTarget);
    async function bankPickpocketSupplies(lumbridge: boolean, auditing: boolean) {
        if (!world()?.bank.isOpen) {
            const [x, z] = lumbridge ? [3092, 3243] : [2656, 3283];
            const timeout = Math.min(480_000, Math.max(40_000, 25_000 + distance(x, z) * 1000));
            if (!await travel(x, z, 4, timeout, auditing, 'Reach the bank to deposit loot and withdraw food')) {
                throw new Error('Could not reach the pickpocket supply bank.');
            }
            const opened = await auditOperation('open-bank', 'Open the bank to deposit loot and withdraw food', {}, world,
                () => bot.openBank(), actionResult);
            if (!world()?.bank.isOpen) throw new Error(`Could not open the pickpocket supply bank: ${opened.message}`);
        }
        try {
            const loot = new Set(sdk.getInventory().filter(bankableLoot).map(item => item.id));
            for (const id of loot) {
                const item = sdk.getInventory().find(entry => entry.id === id);
                if (!item) continue;
                const before = lootAmount(id);
                const amount = id === wine ? Math.min(foodSlots() - foodTarget, before) : -1;
                const deposited = await auditOperation('bank-deposit', 'Deposit pickpocket loot', { id, item: item.name, amount }, world,
                    () => bot.depositItem(item, amount), result => ({ ...actionResult(result), amountDeposited: result.amountDeposited }));
                if (lootAmount(id) > (amount === -1 ? 0 : before - amount)) {
                    throw new Error(`Could not confirm the ${item.name} deposit: ${deposited.message}`);
                }
            }
            const before = foodSlots();
            for (const item of world()?.bank.items ?? []) {
                if (!bankFood.has(item.id)) continue;
                const amount = Math.min(foodTarget - foodSlots(), bankAt - sdk.getInventory().length, item.count);
                if (amount <= 0) break;
                await auditOperation('bank-withdraw', 'Withdraw unnoted food for HP recovery', { id: item.id, item: item.name, amount }, world,
                    () => bot.withdrawItem(item, amount, { asNote: false }),
                    result => ({ ...actionResult(result), amountWithdrawn: result.amountWithdrawn }));
            }
            const withdrawn = foodSlots() - before;
            if (auditing) auditEvent(withdrawn ? 'milestone' : 'decision', 'thieving-bank-food', {
                outcome: withdrawn ? 'restocked' : before >= foodTarget ? 'already-stocked' : 'no-food-withdrawn',
                foodSlots: foodSlots(), withdrawn, after: auditFrame(world()),
            });
        } finally {
            const closed = await auditOperation('close-bank', 'Close the bank to resume pickpocketing', {}, world, () => bot.closeBank(), actionResult);
            if (!closed.success || world()?.bank.isOpen) throw new Error(`Could not close the pickpocket supply bank: ${closed.message}`);
        }
    }

    async function pickpocket(focus: PickpocketTarget, banking = false) {
        let nextScan = 0;
        let knightWaypoint: number | undefined;
        let knightLegs = 0;
        let rejectedAtTick: number | undefined;
        const rejectedTargets = new Set<string>();
        const targetKey = (npc: NearbyNpc) => `${npc.index}:${npc.id}`;
        const closestPickpocket = (name: RegExp) => closest(name, pocket, false, npc => !rejectedTargets.has(targetKey(npc)));
        let nextFood = 0;
        let nextBank = 0;
        let successes = 0;
        let successesAtBank = 0;
        let lastTarget = '';
        const auditing = auditEnabled;
        let currentPhase = '';
        const phase = (name: string) => {
            if (!auditing || name === currentPhase) return;
            currentPhase = name;
            auditEvent('phase', name, { strategy: focus === 'adaptive' ? 'adaptive-priority' : 'nearest-reachable', focus, state: auditFrame(sdk.getState()) });
        };
        let lastTargetIndex: number | undefined;
        const reportError = (name: string, error: unknown) => {
            if (auditing) auditEvent('setback', name, { message: error instanceof Error ? error.message : String(error), after: auditFrame(sdk.getState()) });
        };
        const lumbridge = focus === 'men';
        const requirement = activity(focus === 'adaptive' ? 'pickpocket-guards' : `pickpocket-${focus}`).requirements
            ?.find(entry => entry.type === 'level' && entry.skill === 'Thieving');
        const required = requirement?.type === 'level' ? requirement.level : 1;
        phase('thieving-requirements');
        if (auditing) auditEvent('check', 'thieving-level-requirement', {
            intent: 'Verify the level requirement for the chosen pickpocket target',
            outcome: level('Thieving') >= required ? 'complete' : 'failed', required, actual: level('Thieving'),
        });
        if (level('Thieving') < required) throw new Error(`This activity needs at least ${required} Thieving`);
        const goToArea = async () => {
            if (!lumbridge) {
                if (auditing && distance(2662, 3305) > 50) phase('thieving-travel');
                return goToArdougne(auditing);
            }
            if (distance(3222, 3222) <= 25) return;
            phase('thieving-travel');
            if (!await travel(3222, 3222, 5, 150_000, auditing, 'Reach Lumbridge to look for Men')) throw new Error('Could not verify Lumbridge arrival');
        };
        const visitSupplyBank = async () => {
            if (Date.now() < nextBank) return;
            phase('thieving-banking');
            try {
                await bankPickpocketSupplies(lumbridge, auditing);
                successesAtBank = successes;
            } catch (error) {
                throwIfExecutionAborted();
                if (world()?.bank.isOpen) throw error;
                reportError('thieving-banking-error', error);
                nextBank = Date.now() + 45_000;
            }
            if (foodSlots() <= 2) nextFood = Date.now() + foodRetryMs;
        };
        for (;;) {
            const respawnRequired = !!world()?.player?.isDead;
            if (respawnRequired) phase('thieving-respawn');
            await waitAlive(auditing);
            const inventory = sdk.getInventory();
            const slots = inventory.length;
            const bankForFood = banking && foodSlots() <= 2 && Date.now() >= nextFood;
            const hasLoot = banking && inventory.some(bankableLoot);
            const bankForLoot = slots >= bankAt && (banking ? hasLoot : !lumbridge);
            const bankForBatch = hasLoot && successes - successesAtBank >= lootBatch;
            if (auditing) {
                auditEvent('decision', 'thieving-readiness', {
                    intent: 'Check whether the bot needs to respawn, travel, or bank before selecting a target',
                    outcome: 'evaluated', respawnRequired, slots, bankAt: banking || !lumbridge ? bankAt : null,
                    bankThresholdMet: bankForLoot, bankForFood, bankForBatch, area: lumbridge ? 'Lumbridge' : 'East Ardougne',
                    travelRequired: lumbridge ? distance(3222, 3222) > 25 : distance(2662, 3305) > 50,
                });
            }
            if (!banking) await goToArea();
            if (banking && (bankForLoot || bankForFood || bankForBatch)) await visitSupplyBank();
            else if (!banking && bankForLoot) {
                phase('thieving-banking');
                await bankLoot(auditing).catch(error => reportError('thieving-banking-error', error));
            }
            const p = sdk.getState()?.player;
            if (!p) throw new Error('Player state unavailable in pickpocket phase');
            const low = lumbridge ? 3 : Math.max(8, Math.floor(p.maxHp / 3));
            if (auditing) auditEvent('decision', 'thieving-hp-check', { intent: 'Check if HP is safe for another attempt',
                outcome: p.hp <= low ? 'recover-first' : 'continue', hp: p.hp, maxHp: p.maxHp, lowThreshold: low });
            if (p.hp <= low) {
                phase('thieving-recovery');
                await rest(Math.min(p.maxHp, lumbridge ? 6 : Math.max(low + 4, Math.ceil(p.maxHp / 2))), banking ? async () => {
                    if (Date.now() >= nextFood) await visitSupplyBank();
                    phase('thieving-recovery');
                } : lumbridge ? undefined : async () => {
                    if (Date.now() < nextFood) {
                        if (auditing) auditEvent('decision', 'food-resupply', { intent: 'Avoid repeating the shop trip before the resupply cooldown ends',
                            outcome: 'skipped', retryAfterMs: Math.max(0, nextFood - Date.now()) });
                        return;
                    }
                    nextFood = Date.now() + 45_000;
                    phase('thieving-resupply');
                    await buyFood(auditing).catch(error => reportError('thieving-resupply-error', error));
                    phase('thieving-recovery');
                }, auditing, banking);
            }
            if (banking) {
                if (sdk.getInventory().length >= inventoryCapacity) {
                    if (Date.now() >= nextBank) throw new Error('The backpack is still full after banking pickpocket loot. Clear a slot to continue.');
                    await waitTicks(3, 'Wait for the bank retry before pickpocketing with a full backpack', auditing);
                    continue;
                }
                await goToArea();
            }

            if (sdk.getState()?.tick !== rejectedAtTick) rejectedTargets.clear();
            const thieving = level('Thieving');
            const adaptive = focus === 'adaptive';
            const hero = adaptive && thieving >= 80 ? closestPickpocket(heroes) : undefined;
            const knight = adaptive && thieving >= 55 ? closestPickpocket(knights) : undefined;
            const fixedTarget = { men, guards, knights, paladins, heroes, adaptive: guards }[focus];
            const target = adaptive ? hero ?? knight ?? (thieving < 55 ? closestPickpocket(guards) : undefined) : closestPickpocket(fixedTarget);
            if (auditing) {
                const targetNames = adaptive ? /^(?:guard|knight of ardougne|hero)$/i : fixedTarget;
                const candidates = (sdk.getState()?.nearbyNpcs ?? []).filter(npc => targetNames.test(npc.name));
                auditEvent('decision', 'select-pickpocket-target', {
                    intent: adaptive ? 'Pick the highest eligible target tier and prefer the nearest reachable NPC within it'
                        : 'Choose the nearest matching NPC with a Pickpocket option and no known reachability block',
                    outcome: target ? 'selected' : 'no-eligible-target', focus, thieving, candidatesSeen: candidates.length,
                    target: target && npcEvidence(target),
                    candidates: (!target || target.index !== lastTargetIndex) ? candidates.slice(0, 8).map(npc => npcEvidence(npc)) : undefined,
                    state: auditFrame(sdk.getState()),
                });
            }
            if (!target || (adaptive && thieving >= 80 && !hero && nextScan % 12 === 0)) {
                const searchKnights = focus === 'knights' || (adaptive && thieving >= 55 && thieving < 80);
                if (searchKnights && knightWaypoint === undefined) {
                    knightWaypoint = knightSpots.reduce((nearest, [x, z], index) => {
                        const [nearestX, nearestZ] = knightSpots[nearest] ?? knightSpots[0];
                        return distance(x, z) < distance(nearestX, nearestZ) ? index : nearest;
                    }, 0);
                }
                const locations = lumbridge ? manSpots : focus === 'paladins' ? paladinSpots
                    : focus === 'guards' || (adaptive && thieving < 55) ? guardSpots
                    : searchKnights ? knightSpots : heroSpots;
                const spot = locations[(searchKnights ? (knightWaypoint ?? 0) : nextScan) % locations.length] ?? locations[0];
                nextScan++;
                if (auditing && !target) {
                    phase('thieving-search');
                    lastTargetIndex = undefined;
                    const candidates = (sdk.getState()?.nearbyNpcs ?? []).filter(npc => (adaptive ? /^(?:guard|knight of ardougne|hero)$/i : fixedTarget).test(npc.name));
                    auditEvent('setback', 'thieving-target-unavailable', {
                        waypoint: { x: spot[0], z: spot[1] }, candidatesSeen: candidates.length,
                        candidates: candidates.slice(0, 8).map(npc => npcEvidence(npc)), state: auditFrame(sdk.getState()),
                    });
                }
                if (adaptive && thieving >= 80 && knight && !hero && distance(2630, 3288) > 8) {
                    phase('thieving-search');
                    await travel(2630, 3288, 6, 35_000, auditing, 'Look for a Hero while an eligible lower-tier target is available');
                } else if (searchKnights) {
                    const [x, z] = spot;
                    const tolerance = 3;
                    const timeout = 2_500;
                    const before = distance(x, z);
                    let progressed = false;
                    if (before > tolerance) {
                        const startX = world()?.player?.worldX;
                        const startZ = world()?.player?.worldZ;
                        const travelLeg = () => bot.walkTo(x, z, tolerance, { timeout });
                        const moved = () => {
                            const player = world()?.player;
                            return !!player && startX !== undefined && startZ !== undefined &&
                                (player.worldX !== startX || player.worldZ !== startZ);
                        };
                        await auditOperation('walk-to', 'Walk toward the knight waypoint and scan again after this leg',
                            { x, z, tolerance, timeout }, world, travelLeg, result => ({
                                outcome: distance(x, z) <= tolerance ? 'arrived' : moved() ? 'partial-progress' : 'arrival-unconfirmed',
                                distance: distance(x, z), sdk: actionResult(result).sdk,
                            }));
                        progressed = moved();
                        knightLegs++;
                    }
                    if (distance(x, z) <= tolerance || !progressed || knightLegs >= 12) {
                        knightWaypoint = ((knightWaypoint ?? 0) + 1) % knightSpots.length;
                        knightLegs = 0;
                    }
                    if (!progressed) await waitTicks(3, 'Refresh nearby NPCs before continuing the knight search', auditing);
                    continue;
                } else if (!target) {
                    await travel(spot[0], spot[1], 3, 30_000, auditing, 'Check the next search waypoint for a reachable pickpocket target');
                }
                if (!target || (knight && !hero && distance(knight.x, knight.z) > 12)) {
                    await waitTicks(3, 'Give nearby NPC positions time to refresh before searching again', auditing);
                    continue;
                }
            } else {
                nextScan++;
            }
            knightWaypoint = undefined;
            knightLegs = 0;
            phase('thieving-pickpocket');
            if (auditing && target.index !== lastTargetIndex) {
                lastTargetIndex = target.index;
                auditEvent('milestone', 'thieving-target-acquired', { target: npcEvidence(target) });
            }
            if (target.name !== lastTarget) {
                lastTarget = target.name;
                log('pickpocket-target', { npc: target.name, ...metrics() });
            }
            const { success, action, after } = await auditOperation('pickpocket-npc',
                'Use Pickpocket on the selected target to gain Thieving XP and loot. Check for XP, coin gain, or game feedback.',
                { target: npcEvidence(target), focus }, world, async () => {
                    const before = metrics();
                    const revision = sdk.getState()?.revision;
                    const beforeFrame = auditing ? auditFrame(sdk.getState()) : undefined;
                    const began = auditing ? performance.now() : 0;
                    const action = await bot.pickpocketNpc(target);
                    const missingTarget = isMissingPickpocketTarget(action.reason);
                    if (missingTarget) {
                        const tick = sdk.getState()?.tick;
                        if (tick !== rejectedAtTick) rejectedTargets.clear();
                        rejectedAtTick = tick;
                        rejectedTargets.add(targetKey(target));
                    } else if (!action.success && action.reason !== 'stunned') {
                        await waitTicks(5, 'The SDK did not confirm the attempt. Wait for late state or game feedback before classifying it.', auditing);
                    }
                    const after = metrics();
                    const xpGained = (after.thievingXp ?? 0) - (before.thievingXp ?? 0);
                    const messages = sdk.getState()?.gameMessages ?? [];
                    const newSystemMessage = (message: (typeof messages)[number]) => message.type === 0 &&
                        (message.observationId != null && revision != null ? message.observationId > revision : message.tick > (before.tick ?? -1));
                    const successMessage = messages.some(message => !message.sender && /^You pick the .*pocket/i.test(message.text) && newSystemMessage(message));
                    const success = action.success || xpGained > 0 || successMessage;
                    const outcome = success ? 'succeeded' : action.reason?.replaceAll('_', '-') ?? 'unconfirmed';
                    const observedXp = before.thievingXp != null && after.thievingXp != null ? xpGained : action.xpGained ?? 0;
                    const seen = auditing ? world()?.nearbyNpcs.find(npc => npc.index === target.index && npc.id === target.id) : undefined;
                    const evidence = {
                        targetAtResult: auditing ? { visible: !!seen, pickpocketVisible: !!seen?.optionsWithIndex.some(option => pocket.test(option.text)) } : undefined,
                        xpGained: Math.max(0, observedXp), coinsGained: Math.max(0, after.coins - before.coins),
                        hpLost: Math.max(0, (before.hp ?? 0) - (after.hp ?? 0)),
                        confirmation: xpGained > 0 ? 'xp-gain' : successMessage ? 'game-message' : action.success ? 'sdk-observation' : undefined,
                        sdk: actionResult(action).sdk,
                        feedback: auditing ? messages.filter(message => !message.sender && newSystemMessage(message) &&
                            /attempt to pick|pick the .*pocket|fail to pick|stun|caught|can.t reach|cannot reach/i.test(message.text))
                            .slice(-6).map(({ tick, text }) => ({ tick, text })) : undefined,
                    };
                    if (auditing) auditEvent(success ? 'milestone' : 'setback', `pickpocket-attempt-${outcome}`, {
                        outcome, target: npcEvidence(target), before: beforeFrame, after: auditFrame(sdk.getState()),
                        elapsedMs: Math.round(performance.now() - began), ...evidence,
                    });
                    return { success, action, after, outcome, evidence };
                }, result => ({ outcome: result.outcome, ...result.evidence }));
            if (success) successes++;
            log('pickpocket', { npc: target.name, success, reason: action.reason, successes, ...after });
            if (isMissingPickpocketTarget(action.reason)) continue;
            if (action.reason === 'stunned') phase('thieving-stun');
            await waitTicks(action.reason === 'stunned' ? 11 : success ? 1 : 3,
                action.reason === 'stunned' ? 'Let the stun cooldown elapse before trying again'
                    : success ? 'Wait one tick after a confirmed attempt before retrying'
                        : 'Pause after an unconfirmed attempt before retrying', auditing);
        }
    }

    return { trainHitpoints, pickpocket };
}

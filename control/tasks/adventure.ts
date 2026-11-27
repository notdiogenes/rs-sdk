import { auditEnabled, auditEvent, auditFrame } from '../../sdk/audit-trace';
import type { ScriptContext } from '../../sdk/runner';
import type { NearbyNpc } from '../../sdk/types';
import { activity } from '../dashboard-task-catalog';

const swords = [
    [30, 'Adamant longsword'], [20, 'Mithril longsword'], [5, 'Steel longsword'], [1, 'Iron longsword'],
] as const;
const heal = /^(?:bread|cake|2\/3 cake|slice of cake|chocolate slice|cooked chicken|cooked meat|shrimp|trout|salmon|jug of wine)$/i;
const attackable = /^attack$/i;
const pocket = /^pickpocket$/i;
const guards = /^guard$/i;
const knights = /^knight of ardougne$/i;
const paladins = /^paladin$/i;
const heroes = /^hero$/i;
const guardSpots = [[2651, 3307], [2660, 3308], [2635, 3339]] as const;
const paladinSpots = [[2653, 3315], [2657, 3307]] as const;
const heroSpots = [[2630, 3288], [2642, 3297], [2652, 3318]] as const;
const log = (stage: string, fields: object = {}) =>
    console.log('[pickpocket-demo] ' + JSON.stringify({ stage, ...fields }));

const men = /^man$/i;
const manSpots = [[3222, 3218], [3221, 3228], [3231, 3237]] as const;
export type PickpocketTarget = 'men' | 'guards' | 'knights' | 'paladins' | 'heroes' | 'adaptive';

function npcEvidence(npc: NearbyNpc, action = pocket) {
    const option = npc.optionsWithIndex.find(entry => action.test(entry.text));
    return { id: npc.id, name: npc.name, index: npc.index, x: npc.tileX ?? npc.x, z: npc.tileZ ?? npc.z,
        distance: npc.distance, reachable: npc.reachable, option: option?.text, optionIndex: option?.opIndex };
}

export function adventure({ bot, sdk }: ScriptContext) {
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
    const closest = (name: RegExp, option: RegExp, combat = false) =>
        sdk.getState()?.nearbyNpcs.filter(npc => name.test(npc.name) && npc.reachable !== false &&
            npc.optionsWithIndex.some(entry => option.test(entry.text)) && (!combat || !npc.inCombat))
            .sort((a, b) => a.distance - b.distance)[0];
    const travel = async (x: number, z: number, tolerance: number, timeout: number, auditing = false) => {
        if (distance(x, z) <= tolerance) return true;
        const before = auditing ? auditFrame(sdk.getState()) : undefined;
        const began = auditing ? performance.now() : 0;
        const walked = await bot.walkTo(x, z, tolerance, { timeout });
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
        await sdk.waitForCondition(s => s.inGame && !!s.player && !s.player.isDead, 90_000);
        if (auditing) auditEvent('milestone', 'activity-respawned', { after: auditFrame(sdk.getState()) });
    };
    const eat = async (auditing = false) => {
        const food = sdk.findInventoryItem(heal);
        if (!food) {
            if (auditing) auditEvent('setback', 'out-of-food', { before: auditFrame(sdk.getState()) });
            return false;
        }
        const before = auditing ? auditFrame(sdk.getState()) : undefined;
        const eaten = await bot.eatFood(food);
        if (auditing) auditEvent(eaten.success ? 'milestone' : 'setback', eaten.success ? 'food-eaten' : 'food-eat-failed', {
            item: { id: food.id, name: food.name, count: food.count }, before, after: auditFrame(sdk.getState()), message: eaten.message,
        });
        return eaten.success;
    };
    const rest = async (minimum: number, resupply?: () => Promise<void>, auditing = false) => {
        await waitAlive(auditing);
        if (!sdk.getState()?.player || (sdk.getState()?.player?.hp ?? 0) >= minimum) return;
        log('recovering', { minimum, ...metrics() });
        if (auditing) auditEvent('setback', 'low-hp', { minimum, before: auditFrame(sdk.getState()) });
        while ((sdk.getState()?.player?.hp ?? 0) < minimum) {
            await waitAlive(auditing);
            if (!await eat(auditing)) {
                await resupply?.();
                await sdk.waitForTicks(12);
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
            if (await travel(2662, 3305, 8, 210_000, auditing)) return;
            await waitAlive(auditing);
        }
        throw new Error('Could not verify East Ardougne arrival');
    };
    const buyFood = async (auditing = false) => {
        if (!await travel(2654, 3311, 4, 35_000, auditing)) return;
        const baker = closest(/^baker$/i, /trade/i);
        const opened = baker && await bot.openShop(baker);
        if (!opened?.success) {
            if (auditing) auditEvent('setback', 'thieving-food-shop-unavailable', { baker: baker?.index, message: opened?.message, state: auditFrame(sdk.getState()) });
            return;
        }
        try {
            let boughtCount = 0;
            for (const [name, limit] of [['Cake', 3], ['Chocolate slice', 8], ['Bread', 10]] as const) {
                const item = sdk.getState()?.shop.shopItems.find(entry => entry.name === name && entry.count > 0);
                if (!item) continue;
                const bought = await bot.buyFromShop(name, Math.min(limit, item.count));
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
            await bot.closeShop();
        }
    };
    const bankLoot = async (auditing = false) => {
        if (!await travel(2656, 3283, 4, 40_000, auditing)) return;
        const opened = await bot.openBank();
        if (!opened.success) {
            if (auditing) auditEvent('setback', 'thieving-bank-unavailable', { message: opened.message, state: auditFrame(sdk.getState()) });
            return;
        }
        const slotsBefore = auditing ? sdk.getInventory().length : 0;
        try {
            for (const name of new Set(sdk.getInventory().map(item => item.name))) {
                if (/^coins$/i.test(name) || heal.test(name)) continue;
                const deposited = await bot.depositItem(name, -1);
                if (auditing && !deposited.success) auditEvent('setback', 'thieving-deposit-failed', { item: name, message: deposited.message });
            }
            if (auditing) {
                const slotsAfter = sdk.getInventory().length;
                const freed = slotsAfter < slotsBefore;
                auditEvent(freed ? 'milestone' : 'setback', freed ? 'thieving-bank-freed-slots' : 'thieving-bank-no-slots-freed',
                    { slotsBefore, slotsAfter, after: auditFrame(sdk.getState()) });
            }
        } finally {
            await bot.closeBank();
        }
    };
    async function pickpocket(focus: PickpocketTarget) {
        let nextScan = 0;
        let nextFood = 0;
        let successes = 0;
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
            if (!await travel(3222, 3222, 5, 150_000, auditing)) throw new Error('Could not verify Lumbridge arrival');
        };
        for (;;) {
            if (auditing && sdk.getState()?.player?.isDead) phase('thieving-respawn');
            await waitAlive(auditing);
            await goToArea();
            if (!lumbridge && sdk.getInventory().length >= 26) {
                phase('thieving-banking');
                await bankLoot(auditing).catch(error => reportError('thieving-banking-error', error));
            }
            const p = sdk.getState()?.player;
            if (!p) throw new Error('Player state unavailable in pickpocket phase');
            const low = lumbridge ? 3 : Math.max(8, Math.floor(p.maxHp / 3));
            if (p.hp <= low) {
                phase('thieving-recovery');
                await rest(Math.min(p.maxHp, lumbridge ? 6 : Math.max(low + 4, Math.ceil(p.maxHp / 2))), lumbridge ? undefined : async () => {
                    if (Date.now() < nextFood) return;
                    nextFood = Date.now() + 45_000;
                    phase('thieving-resupply');
                    await buyFood(auditing).catch(error => reportError('thieving-resupply-error', error));
                    phase('thieving-recovery');
                }, auditing);
            }

            const thieving = level('Thieving');
            const adaptive = focus === 'adaptive';
            const hero = adaptive && thieving >= 80 ? closest(heroes, pocket) : undefined;
            const knight = adaptive && thieving >= 55 ? closest(knights, pocket) : undefined;
            const fixedTarget = { men, guards, knights, paladins, heroes, adaptive: guards }[focus];
            const target = adaptive ? hero ?? knight ?? (thieving < 55 ? closest(guards, pocket) : undefined) : closest(fixedTarget, pocket);
            if (!target || (adaptive && thieving >= 80 && !hero && nextScan % 12 === 0)) {
                const locations = lumbridge ? manSpots : focus === 'paladins' ? paladinSpots
                    : focus === 'guards' || (adaptive && thieving < 55) ? guardSpots : heroSpots;
                const spot = locations[nextScan % locations.length] ?? locations[0];
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
                    await travel(2630, 3288, 6, 35_000, auditing);
                } else if (!target) {
                    await travel(spot[0], spot[1], 3, 30_000, auditing);
                }
                if (!target || (knight && !hero && distance(knight.x, knight.z) > 12)) {
                    await sdk.waitForTicks(3);
                    continue;
                }
            } else {
                nextScan++;
            }
            phase('thieving-pickpocket');
            if (auditing && target.index !== lastTargetIndex) {
                lastTargetIndex = target.index;
                auditEvent('milestone', 'thieving-target-acquired', { target: npcEvidence(target) });
            }
            if (target.name !== lastTarget) {
                lastTarget = target.name;
                log('pickpocket-target', { npc: target.name, ...metrics() });
            }
            const before = metrics();
            const revision = sdk.getState()?.revision;
            const beforeFrame = auditing ? auditFrame(sdk.getState()) : undefined;
            const began = auditing ? performance.now() : 0;
            const action = await bot.pickpocketNpc(target);
            if (!action.success && action.reason !== 'stunned') await sdk.waitForTicks(5);
            const after = metrics();
            const xpGained = (after.thievingXp ?? 0) - (before.thievingXp ?? 0);
            const messages = sdk.getState()?.gameMessages ?? [];
            const newSystemMessage = (message: (typeof messages)[number]) => message.type === 0 &&
                (message.observationId != null && revision != null ? message.observationId > revision : message.tick > (before.tick ?? -1));
            const success = action.success || xpGained > 0 ||
                messages.some(message => /^You pick the .*pocket/i.test(message.text) && newSystemMessage(message));
            if (auditing) {
                const feedback = messages.filter(message => !message.sender && newSystemMessage(message) &&
                    /attempt to pick|pick the .*pocket|fail to pick|stun|caught|can.t reach|cannot reach/i.test(message.text))
                    .slice(-6).map(({ tick, text }) => ({ tick, text }));
                const outcome = success ? 'succeeded' : action.reason?.replaceAll('_', '-') ?? 'unconfirmed';
                const observedXp = before.thievingXp != null && after.thievingXp != null ? xpGained : action.xpGained ?? 0;
                auditEvent(success ? 'milestone' : 'setback', `pickpocket-attempt-${outcome}`, {
                    target: npcEvidence(target), before: beforeFrame, after: auditFrame(sdk.getState()),
                    elapsedMs: Math.round(performance.now() - began), xpGained: Math.max(0, observedXp),
                    coinsGained: Math.max(0, after.coins - before.coins), hpLost: Math.max(0, (before.hp ?? 0) - (after.hp ?? 0)),
                    sdk: { success: action.success, reason: action.reason, message: action.message }, feedback,
                });
            }
            if (success) successes++;
            log('pickpocket', { npc: target.name, success, reason: action.reason, successes, ...after });
            if (action.reason === 'stunned') phase('thieving-stun');
            await sdk.waitForTicks(action.reason === 'stunned' ? 11 : success ? 1 : 3);
        }
    }

    return { trainHitpoints, pickpocket };
}

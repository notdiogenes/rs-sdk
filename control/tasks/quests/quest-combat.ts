import { auditEvent, auditOperation } from '../../../sdk/audit-trace';
import { Spells } from '../../../sdk/spells';
import { PRAYER_INDICES, PRAYER_LEVELS, type NearbyNpc, type PrayerName } from '../../../sdk/types';
import { itemNamed, type QuestContext } from './shared';

export const questFood = /^(?:lobster|swordfish|shark|salmon|trout|cooked meat|cooked chicken|cake|2\/3 cake|slice of cake|tuna|bread)$/i;
export const questFoodSupplies = ['Lobster', 'Swordfish', 'Shark', 'Salmon', 'Trout', 'Cake', 'Tuna', 'Cooked meat'].map(name => ({ name, count: 3 }));

const combatSpells = [
    { name: 'Fire Blast', component: Spells.FIRE_BLAST, magic: 59, maxHit: 16, runes: { 'Death rune': 1, 'Fire rune': 5, 'Air rune': 4 } },
    { name: 'Fire Bolt', component: Spells.FIRE_BOLT, magic: 35, maxHit: 12, runes: { 'Chaos rune': 1, 'Fire rune': 4, 'Air rune': 3 } },
    { name: 'Fire Strike', component: Spells.FIRE_STRIKE, magic: 13, maxHit: 8, runes: { 'Mind rune': 1, 'Fire rune': 3, 'Air rune': 2 } },
] as const;

type Spell = typeof combatSpells[number];
type FightPlan = { style: 'melee' } | { style: 'magic'; spell: Spell };
type Fight = {
    name: string; hitpoints: number; incomingHit: number;
    meleeLevel: number; minimumFood: number;
};

export function questSkill({ sdk }: QuestContext, name: string) {
    return sdk.getSkill(name)?.baseLevel ?? 0;
}

export function canMeleeQuest(ctx: QuestContext, fight: Fight) {
    return questSkill(ctx, 'Attack') >= fight.meleeLevel && questSkill(ctx, 'Strength') >= fight.meleeLevel;
}

function availableCasts({ sdk }: QuestContext, spell: Spell) {
    return Math.min(...Object.entries(spell.runes).map(([name, count]) => Math.floor(sdk.countInventoryItems(itemNamed(name)) / count)));
}

function minimumCasts(hitpoints: number, spell: Spell) {
    // Budget for misses and variable damage, including several casts held in reserve.
    return Math.ceil(hitpoints * 4 / spell.maxHit) + 5;
}

export function questSpellSupplies(ctx: QuestContext, hitpoints: number) {
    const counts = new Map<string, number>();
    for (const spell of combatSpells.filter(entry => entry.magic <= questSkill(ctx, 'Magic'))) {
        for (const [name, each] of Object.entries(spell.runes)) {
            counts.set(name, Math.max(counts.get(name) ?? 0, each * minimumCasts(hitpoints, spell)));
        }
    }
    return [...counts].map(([name, count]) => ({ name, count }));
}

export function planQuestFight(ctx: QuestContext, fight: Fight, options: { magicOnly?: boolean } = {}): FightPlan {
    const { sdk } = ctx;
    const player = sdk.getState()?.player;
    const magic = questSkill(ctx, 'Magic');
    const defence = questSkill(ctx, 'Defence');
    const food = sdk.countInventoryItems(questFood);
    const minimumFood = fight.minimumFood + (fight.incomingHit === 0 ? 0 : defence < 35 ? 4 : defence < 60 ? 2 : 0);
    const reserve = fight.incomingHit * 2 + 2;
    const spells = combatSpells.filter(entry => entry.magic <= magic).map(spell => ({
        spell, available: availableCasts(ctx, spell), required: minimumCasts(fight.hitpoints, spell),
    }));
    const viable = spells.find(entry => entry.available >= entry.required)?.spell;
    const plan: FightPlan | undefined = !options.magicOnly && canMeleeQuest(ctx, fight)
        ? { style: 'melee' }
        : viable && { style: 'magic', spell: viable };
    const needs: string[] = [];
    if (!plan) needs.push(options.magicOnly ? 'enough runes for an available combat spell'
        : `Attack and Strength ${fight.meleeLevel}, or enough runes for an available combat spell`);
    if (!player || player.isDead || player.maxHp <= reserve) needs.push(`more than ${reserve} maximum Hitpoints`);
    if (food < minimumFood) needs.push(`${minimumFood} food items (carrying ${food})`);
    auditEvent('check', 'quest-combat-loadout', {
        outcome: needs.length ? 'blocked' : 'ready', boss: fight.name, plan,
        attack: questSkill(ctx, 'Attack'), strength: questSkill(ctx, 'Strength'), defence, magic,
        health: player?.hp, maximumHealth: player?.maxHp, reserve, food, minimumFood, needs,
        spells: spells.map(entry => ({ spell: entry.spell.name, available: entry.available, required: entry.required })),
    });
    if (needs.length || !plan) throw new Error(`${fight.name} loadout needs ${needs.join('; ')}`);
    return plan;
}

const overheads = ['protect_from_melee', 'protect_from_magic', 'protect_from_missiles'] as const;
type Overhead = typeof overheads[number];

export async function withQuestProtection(ctx: QuestContext, choices: readonly Overhead[], fight: () => Promise<void>) {
    const { bot, sdk } = ctx;
    const prayer = sdk.getPrayerState();
    const previous = overheads.find(name => prayer?.activePrayers[PRAYER_INDICES[name]]);
    const preferred: PrayerName | undefined = prayer && prayer.prayerPoints > 0
        ? choices.find(name => prayer.prayerLevel >= (PRAYER_LEVELS[PRAYER_INDICES[name]] ?? Infinity))
        : undefined;
    let changed = false;
    try {
        if (preferred && preferred !== previous) {
            const result = await bot.activatePrayer(preferred);
            changed = sdk.getPrayerState()?.activePrayers[PRAYER_INDICES[preferred]] === true;
            auditEvent('check', 'quest-combat-overhead', {
                outcome: changed ? 'complete' : 'unavailable', prayer: preferred, previous,
                prayerPoints: sdk.getPrayerState()?.prayerPoints, message: result.message,
            });
        } else {
            auditEvent('check', 'quest-combat-overhead', {
                outcome: preferred ? 'already-active' : 'unavailable', prayer: preferred, previous,
                prayerPoints: prayer?.prayerPoints,
            });
        }
        await fight();
    } finally {
        if (changed && preferred && sdk.getPrayerState()?.activePrayers[PRAYER_INDICES[preferred]]) {
            await bot.deactivatePrayer(preferred);
        }
        if (changed && previous && (sdk.getPrayerState()?.prayerPoints ?? 0) > 0) {
            await bot.activatePrayer(previous);
        }
    }
}

export async function fightQuestNpc(ctx: QuestContext, target: NearbyNpc, fight: Fight, plan: FightPlan, {
    retreat, won = () => false, protectedFromDamage = () => true, reposition,
}: {
    retreat: () => Promise<void>; won?: () => boolean; protectedFromDamage?: () => boolean;
    reposition?: (target: NearbyNpc, retry: number) => Promise<void>;
}) {
    const { sdk, bot } = ctx;
    const reserve = fight.incomingHit * 2 + 2;
    const initialLife = sdk.getState()?.player?.lifeId;
    let failures = 0;
    let attacked = false;
    let lastAttack = -100;
    let lastReposition = -100;
    let lastDamage = sdk.getState()?.tick ?? 0;
    let stalled = 0;
    let lastTargetHealth = target.hp;
    let activePlan = plan;
    const tryFallbackSpell = (remainingHp: number) => combatSpells.find(spell => spell.magic <= questSkill(ctx, 'Magic') &&
        availableCasts(ctx, spell) >= Math.ceil(remainingHp * 2 / spell.maxHit));
    const stop = async (reason: string) => {
        await auditOperation('quest-combat-retreat', 'Leave the fight while the character still has a health reserve',
            { target: target.name, reason }, () => sdk.getState(), retreat, () => ({ outcome: 'complete' }));
        throw new Error(`${target.name}: ${reason}`);
    };
    for (let attempt = 0; attempt < 175; attempt++) {
        if (won()) return;
        const state = sdk.getState();
        const player = state?.player;
        if (!player || player.isDead || player.lifeId !== initialLife) throw new Error(`${target.name}: player died or changed sessions`);
        const npc = state.nearbyNpcs.find(entry => entry.index === target.index && entry.id === target.id);
        if (npc?.hp === 0 || !npc && attacked) return;
        if (!npc) throw new Error(`${target.name} left the scene before an attack was verified`);
        if (!protectedFromDamage()) await stop('required protective equipment was removed');
        const freshHit = state.combatEvents.findLast(event => event.type === 'damage_dealt' && event.damage > 0
            && event.targetType === 'npc' && event.targetIndex === target.index && event.tick > lastDamage);
        if (freshHit || (lastTargetHealth !== null && npc.hp !== null && npc.hp < lastTargetHealth)) {
            lastDamage = freshHit?.tick ?? state.tick;
            stalled = 0;
            auditEvent('check', 'quest-combat-damage', { outcome: 'verified', target: npc.name, index: npc.index,
                damage: freshHit?.damage, previousTargetHp: lastTargetHealth, targetHp: npc.hp, tick: lastDamage });
        }
        lastTargetHealth = npc.hp;
        const healAt = Math.min(player.maxHp - 3, Math.max(reserve + fight.incomingHit, Math.ceil(player.maxHp * 0.55)));
        if (player.hp <= healAt) {
            const food = sdk.findInventoryItem(questFood);
            if (food) {
                const eaten = await auditOperation('quest-combat-eat', 'Restore Hitpoints before the next incoming hit',
                    { target: target.name, health: player.hp, reserve, food: food.name }, () => sdk.getState(),
                    () => bot.eatFood(food), result => ({ outcome: result.success ? 'complete' : 'failed', message: result.message }));
                if (eaten.success) continue;
            }
            if (player.hp <= reserve) await stop(`Hitpoints reached ${player.hp} with no usable food`);
        }
        if (activePlan.style === 'magic' && availableCasts(ctx, activePlan.spell) < 1) await stop('ran out of combat runes');
        const noDamage = attacked && state.tick - Math.max(lastReposition, lastDamage) >= 10;
        if (noDamage) {
            auditEvent('check', 'quest-combat-damage', { outcome: 'unconfirmed', target: npc.name, index: npc.index,
                tick: state.tick, lastAttack, lastDamage, targetHp: npc.hp, rejected: state.opFeedback?.opRejectedCount,
                feedback: state.gameMessages.filter(message => message.type === 0 && !message.sender && message.tick >= lastAttack)
                    .slice(-5).map(message => message.text) });
            lastReposition = state.tick;
            if (++stalled >= 6) await stop('attacks did not produce verified damage');
            if (stalled >= 3 && activePlan.style === 'melee') {
                const spell = tryFallbackSpell(npc.hp ?? fight.hitpoints);
                if (spell) {
                    activePlan = { style: 'magic', spell };
                    auditEvent('check', 'quest-combat-switch-style', { outcome: 'selected', boss: npc.name,
                        style: 'magic', spell: spell.name, casts: availableCasts(ctx, spell), reason: 'melee damage unverified' });
                }
            }
            await reposition?.(npc, stalled);
        }
        if (activePlan.style === 'magic' || !attacked || !player.combat.inCombat || noDamage) {
            lastAttack = state.tick;
            if (!attacked) lastReposition = state.tick;
            const attackPlan = activePlan;
            const action = await auditOperation<{ success: boolean; message: string }>('quest-combat-attack', 'Damage the quest target with the prepared combat style',
                { npc: npc.name, index: npc.index, hp: npc.hp, style: attackPlan.style, spell: attackPlan.style === 'magic' ? attackPlan.spell.name : undefined },
                () => sdk.getState(), () => attackPlan.style === 'magic'
                    ? bot.castSpell(npc, attackPlan.spell.component, 3000)
                    : bot.attack(npc, 2500),
                result => ({ outcome: result.success ? 'engaged' : 'failed', message: result.message }));
            if (action.success) { attacked = true; failures = 0; }
            else if (++failures >= 5) await stop(action.message);
        }
        await sdk.waitForTicks(1);
    }
    await stop('the fight exceeded its action budget');
}

import { auditEvent, auditOperation } from '../../../sdk/audit-trace';
import { findLongPath, isTileWalkable } from '../../../sdk/pathfinding';
import { questSkill } from './quest-combat';
import { buyQuestSupply, continueDialog, itemNamed, prepareQuestStep, questPhase, readQuest, walk, type QuestContext } from './shared';

const faladorBank = [2947, 3368] as const;
const westVarrockBank = [3185, 3435] as const;
const doricAnvil = [2951, 3451] as const;
const varrockAnvil = [3187, 3424] as const;
const canUseDoricAnvil = (ctx: QuestContext) => readQuest(ctx, 7336) === 'complete';
const stock = { copper: 'Copper ore', tin: 'Tin ore', iron: 'Iron ore', coal: 'Coal' } as const;
const rockIds = { copper: [2090, 2091], tin: [2094, 2095], iron: [2092, 2093], coal: [2096, 2097] };
type Ore = keyof typeof stock;

const keep = /^(?:crandor map|map part|maze key|dragonfire shield|hammer|plank|nails|.*pickaxe|.* bar|.* ore|coal|coins)$/i;
const keepForSteel = /^(?:crandor map|map part|maze key|dragonfire shield|hammer|plank|nails|.*pickaxe|steel bar|iron ore|coal|coins)$/i;
const pickaxe = /pickaxe$/i;

function count({ sdk }: QuestContext, name: string) {
    return sdk.countInventoryItems(itemNamed(name));
}

function miningApproach(ctx: QuestContext, rock: { x: number; z: number }) {
    const p = ctx.sdk.getState()?.player;
    if (!p) return undefined;
    const candidates = [[rock.x + 1, rock.z], [rock.x, rock.z - 1], [rock.x - 1, rock.z], [rock.x, rock.z + 1]] as const;
    return candidates.find(([x, z]) => {
        if (p.worldX === x && p.worldZ === z) return true;
        if (!isTileWalkable(p.level, x, z)) return false;
        const end = findLongPath(p.level, p.worldX, p.worldZ, x, z, 50).at(-1);
        return end?.x === x && end.z === z;
    });
}

async function collectOre(ctx: QuestContext, ore: Ore, amount: number) {
    if (count(ctx, stock[ore]) >= amount) return;
    const faladorMine = [2908, 3363] as const;
    const anchors = ore === 'coal' ? [[3236, 3167] as const, [3088, 3432] as const, faladorMine]
        : [ore === 'iron' ? [2903, 3353] as const : faladorMine];
    let lastFailure = '';
    for (const anchor of anchors) {
        lastFailure = await collectOreAt(ctx, ore, amount, anchor);
        if (count(ctx, stock[ore]) >= amount) return;
        auditEvent('check', 'dragon-slayer-ore-site-exhausted', {
            outcome: 'unavailable', ore, anchor, carried: count(ctx, stock[ore]), needed: amount, message: lastFailure,
        });
    }
    throw new Error(`Could not gather ${stock[ore]}: ${lastFailure}`);
}

async function collectOreAt(ctx: QuestContext, ore: Ore, amount: number, anchor: readonly [number, number]) {
    const { sdk } = ctx;
    await walk(ctx, anchor[0], anchor[1], 3);
    let misses = 0;
    const attempted = new Map<string, number>();
    const key = (loc: { x: number; z: number }) => `${loc.x},${loc.z}`;
    while (count(ctx, stock[ore]) < amount) {
        const rock = (await sdk.scanNearbyLocs(12)).filter(loc => rockIds[ore].includes(loc.id) && loc.reachable !== false)
            .sort((a, b) => (attempted.get(key(a)) ?? -1) - (attempted.get(key(b)) ?? -1) || a.distance - b.distance)[0];
        if (!rock) {
            if (++misses >= 12) return `No reachable rock near ${anchor.join(', ')}`;
            await sdk.waitForTicks(3);
            continue;
        }
        attempted.set(key(rock), sdk.getState()?.tick ?? 0);
        const approach = miningApproach(ctx, rock);
        const before = count(ctx, stock[ore]);
        const mined = await auditOperation('dragon-slayer-mine-ship-ore', 'Stand beside the rock and wait for the ore before trying another',
            { ore, id: rock.id, x: rock.x, z: rock.z, approach, remaining: amount - before }, () => sdk.getState(),
            async () => {
                if (!approach) return 'No reachable tile beside the rock';
                await walk(ctx, approach[0], approach[1], 0);
                const current = (await sdk.scanNearbyLocs(5)).find(loc => loc.id === rock.id && loc.x === rock.x && loc.z === rock.z);
                const option = current?.optionsWithIndex.find(option => /^mine$/i.test(option.text));
                if (!current || !option) return 'The rock was depleted before the swing';
                const tick = sdk.getState()?.tick ?? 0;
                const click = await sdk.sendInteractLoc(current.x, current.z, current.id, option.opIndex);
                if (!click.success) return click.message;
                const observed = await sdk.waitForCondition(() => count(ctx, stock[ore]) > before, ore === 'coal' ? 20_000 : 12_000).catch(() => null);
                if (observed) return 'Ore observed in inventory';
                const feedback = sdk.getState()?.gameMessages.filter(message => message.tick >= tick && message.type === 0 && !message.sender)
                    .slice(-5).map(message => message.text);
                auditEvent('check', 'dragon-slayer-mining-feedback', { outcome: 'unconfirmed', ore, rock: current.id, feedback });
                return 'No inventory change after the mining swing';
            }, message => ({
                outcome: count(ctx, stock[ore]) > before ? 'complete' : 'unconfirmed',
                message, available: count(ctx, stock[ore]),
            }));
        if (count(ctx, stock[ore]) > before) misses = 0;
        else if (++misses >= 12) return mined;
        else await sdk.waitForTicks(2);
    }
    return '';
}

async function smeltBars(ctx: QuestContext, type: 'Bronze' | 'Steel', target: number) {
    const { sdk } = ctx;
    const bar = type + ' bar';
    if (count(ctx, bar) >= target) return;
    await walk(ctx, 2975, 3368, 2);
    const furnace = (await sdk.scanNearbyLocs(8)).find(loc => loc.id === 2781 && loc.x === 2975 && loc.z === 3368);
    if (!furnace) throw new Error('The Falador furnace was not visible');
    const ore = itemNamed(type === 'Bronze' ? stock.copper : stock.coal);
    while (count(ctx, bar) < target) {
        const item = sdk.findInventoryItem(ore);
        if (!item) throw new Error(`No ore available to smelt a ${bar}`);
        const before = count(ctx, bar);
        await auditOperation('dragon-slayer-smelt-ship-bar', 'Smelt a bar at the Falador furnace',
            { bar, before, target }, () => sdk.getState(), async () => {
                const sent = await sdk.sendUseItemOnLoc(item.slot, furnace.x, furnace.z, furnace.id);
                if (!sent.success) throw new Error(sent.message);
                await sdk.waitForCondition(() => count(ctx, bar) > before, 9_000);
            }, () => ({ outcome: 'complete', available: count(ctx, bar) }));
    }
}

async function smithAvailable(ctx: QuestContext, metal: 'Bronze' | 'Iron' | 'Steel', product: string, enough: () => boolean) {
    const name = metal + ' bar';
    if (!count(ctx, name) || enough()) return;
    const anvil = canUseDoricAnvil(ctx) ? doricAnvil : varrockAnvil;
    await walk(ctx, anvil[0], anvil[1], 1);
    let misses = 0;
    while (count(ctx, name) && !enough()) {
        await ctx.sdk.waitForTicks(2);
        if (ctx.sdk.getDialog()?.isOpen) await continueDialog(ctx);
        const before = count(ctx, name);
        const result = await auditOperation('dragon-slayer-smith-ship-supply', 'Work a bar at the anvil',
            { metal, product, smithing: questSkill(ctx, 'Smithing') }, () => ctx.sdk.getState(),
            () => ctx.bot.smithAtAnvil(product, { barPattern: itemNamed(name) }), action => ({
                outcome: count(ctx, name) < before ? 'complete' : 'unconfirmed', message: action.message,
                reason: action.reason, remainingBars: count(ctx, name), smithing: questSkill(ctx, 'Smithing'),
                dialogOptions: ctx.sdk.getDialog()?.options.map(option => option.text),
            }));
        if (count(ctx, name) < before) misses = 0;
        else if (++misses >= 3 || result.reason === 'no_bars' || result.reason === 'level_too_low') {
            throw new Error(`Could not smith ${product}: ${result.message}`);
        }
    }
    await ctx.sdk.waitForTicks(2);
    if (ctx.sdk.getDialog()?.isOpen) await continueDialog(ctx);
}

export async function makeShipNails(ctx: QuestContext) {
    const { sdk } = ctx;
    const needed = () => Math.max(0, 12 - count(ctx, 'Nails'));
    if (!needed()) return;
    questPhase('dragon-slayer-smith-ship-nails');
    const qualified = () => questSkill(ctx, 'Smithing') >= 34;
    if (!qualified()) {
        await smithAvailable(ctx, 'Iron', 'iron dagger', () => qualified() || questSkill(ctx, 'Smithing') < 15);
        await smithAvailable(ctx, 'Bronze', 'bronze dagger', qualified);
    }
    if (!qualified()) {
        await prepareQuestStep(ctx, { bank: canUseDoricAnvil(ctx) ? faladorBank : westVarrockBank, slots: 16, keep, withdraw: [
            { name: 'Bronze bar', count: 8 }, { name: 'Iron bar', count: 8 },
        ] });
        await smithAvailable(ctx, 'Iron', 'iron dagger', () => qualified() || questSkill(ctx, 'Smithing') < 15);
        await smithAvailable(ctx, 'Bronze', 'bronze dagger', qualified);
    }
    if ((!qualified() || count(ctx, 'Steel bar') < Math.ceil(needed() / 2)) &&
        !sdk.findInventoryItem(pickaxe) && !sdk.findEquipmentItem(pickaxe)) {
        await prepareQuestStep(ctx, { bank: faladorBank, slots: 2, keep, withdraw: [{ name: 'Bronze pickaxe', count: 1 }] });
        if (!sdk.findInventoryItem(pickaxe)) {
            await walk(ctx, 3231, 3203);
            await buyQuestSupply(ctx, /^bob$/i, 'Bronze pickaxe', 12);
        }
    }
    while (!qualified()) {
        const bars = 9;
        const missing = Math.max(0, bars - count(ctx, 'Bronze bar'));
        const oreSlots = Math.max(0, missing - count(ctx, 'Copper ore')) + Math.max(0, missing - count(ctx, 'Tin ore'));
        await prepareQuestStep(ctx, { bank: faladorBank, slots: oreSlots, keep });
        const before = sdk.getSkill('Smithing')?.experience ?? 0;
        await collectOre(ctx, 'copper', missing);
        await collectOre(ctx, 'tin', missing);
        await smeltBars(ctx, 'Bronze', bars);
        await smithAvailable(ctx, 'Bronze', 'bronze dagger', qualified);
        const after = sdk.getSkill('Smithing')?.experience ?? 0;
        auditEvent('check', 'dragon-slayer-smithing-progress', {
            outcome: after > before ? 'complete' : 'unconfirmed', before, after, level: questSkill(ctx, 'Smithing'),
        });
        if (after <= before) throw new Error('No Smithing XP was observed while preparing Dragon Slayer nails');
    }
    const bars = Math.ceil(needed() / 2);
    if (count(ctx, 'Steel bar') < bars) {
        const missing = bars - count(ctx, 'Steel bar');
        const oreSlots = Math.max(0, missing - count(ctx, 'Iron ore')) + Math.max(0, 2 * missing - count(ctx, 'Coal'));
        await prepareQuestStep(ctx, { bank: faladorBank, slots: oreSlots, keep: keepForSteel, withdraw: [
            { name: 'Iron ore', count: missing }, { name: 'Coal', count: 2 * missing },
        ] });
        while (questSkill(ctx, 'Mining') < 30 && count(ctx, 'Coal') < 2 * missing) {
            await prepareQuestStep(ctx, { bank: faladorBank, slots: 8, keep: /^(?!copper ore$).*$/i });
            // Copper is available at level 1. Leave room for one more verified swing.
            const levelBefore = sdk.getSkill('Mining')?.experience ?? 0;
            await collectOre(ctx, 'copper', count(ctx, 'Copper ore') + 1);
            if ((sdk.getSkill('Mining')?.experience ?? 0) <= levelBefore) throw new Error('Mining did not award XP during ore preparation');
        }
        await collectOre(ctx, 'iron', missing);
        await collectOre(ctx, 'coal', 2 * missing);
        await smeltBars(ctx, 'Steel', bars);
    }
    await smithAvailable(ctx, 'Steel', 'steel nails', () => !needed());
    if (needed()) throw new Error(`Ship repair still needs ${needed()} steel nails`);
}

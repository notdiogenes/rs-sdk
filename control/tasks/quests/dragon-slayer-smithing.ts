import { auditEvent, auditOperation } from '../../../sdk/audit-trace';
import { questSkill } from './quest-combat';
import { buyQuestSupply, itemNamed, prepareQuestStep, questPhase, readQuest, walk, type QuestContext } from './shared';

const faladorBank = [2947, 3368] as const;
const westVarrockBank = [3185, 3435] as const;
const doricAnvil = [2951, 3451] as const;
const varrockAnvil = [3187, 3424] as const;
const canUseDoricAnvil = (ctx: QuestContext) => readQuest(ctx, 7336) === 'complete';
const stock = { copper: 'Copper ore', tin: 'Tin ore', iron: 'Iron ore', coal: 'Coal' } as const;
const rockIds = { copper: [2090, 2091], tin: [2094, 2095], iron: [2092, 2093], coal: [2096, 2097] };
type Ore = keyof typeof stock;

const keep = /^(?:crandor map|map part|maze key|dragonfire shield|hammer|plank|nails|.*pickaxe|.* bar|.* ore|coal|coins)$/i;
const pickaxe = /pickaxe$/i;

function count({ sdk }: QuestContext, name: string) {
    return sdk.countInventoryItems(itemNamed(name));
}

async function collectOre(ctx: QuestContext, ore: Ore, amount: number) {
    if (count(ctx, stock[ore]) >= amount) return;
    const { sdk, bot } = ctx;
    const anchor = ore === 'iron' ? [2903, 3353] : [2908, 3363];
    await walk(ctx, anchor[0]!, anchor[1]!, 3);
    let misses = 0;
    const attempted = new Map<string, number>();
    const key = (loc: { x: number; z: number }) => `${loc.x},${loc.z}`;
    while (count(ctx, stock[ore]) < amount) {
        const rock = (await sdk.scanNearbyLocs(12)).filter(loc => rockIds[ore].includes(loc.id) && loc.reachable !== false)
            .sort((a, b) => (attempted.get(key(a)) ?? -1) - (attempted.get(key(b)) ?? -1) || a.distance - b.distance)[0];
        if (!rock) {
            if (++misses >= 12) throw new Error(`No reachable ${stock[ore]} rock near Falador`);
            await sdk.waitForTicks(3);
            continue;
        }
        attempted.set(key(rock), sdk.getState()?.tick ?? 0);
        const before = count(ctx, stock[ore]);
        const mined = await auditOperation('dragon-slayer-mine-ship-ore', 'Gather ore to make the ship repair nails',
            { ore, id: rock.id, x: rock.x, z: rock.z, remaining: amount - before }, () => sdk.getState(),
            async () => {
                const result = await bot.mineRock(rock, { timeout: 9_000 });
                if (count(ctx, stock[ore]) <= before) await sdk.waitForTicks(4);
                return result;
            }, result => ({
                outcome: count(ctx, stock[ore]) > before ? 'complete' : 'unconfirmed',
                message: result.message, available: count(ctx, stock[ore]),
            }));
        if (count(ctx, stock[ore]) > before) misses = 0;
        else if (++misses >= 12) throw new Error(`Could not gather ${stock[ore]}: ${mined.message}`);
    }
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
    while (count(ctx, name) && !enough()) {
        const before = count(ctx, name);
        const result = await auditOperation('dragon-slayer-smith-ship-supply', 'Work a bar at the anvil',
            { metal, product, smithing: questSkill(ctx, 'Smithing') }, () => ctx.sdk.getState(),
            () => ctx.bot.smithAtAnvil(product, { barPattern: itemNamed(name) }), action => ({
                outcome: count(ctx, name) < before ? 'complete' : 'unconfirmed', message: action.message,
            }));
        if (!result.success || count(ctx, name) >= before) throw new Error(`Could not smith ${product}: ${result.message}`);
    }
}

export async function makeShipNails(ctx: QuestContext) {
    const { sdk } = ctx;
    const needed = () => Math.max(0, 12 - count(ctx, 'Nails'));
    if (!needed()) return;
    questPhase('dragon-slayer-smith-ship-nails');
    const qualified = () => questSkill(ctx, 'Smithing') >= 34;
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
        await prepareQuestStep(ctx, { bank: faladorBank, slots: 12, keep });
        const before = sdk.getSkill('Smithing')?.experience ?? 0;
        const bars = 6;
        const missing = Math.max(0, bars - count(ctx, 'Bronze bar'));
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
        await prepareQuestStep(ctx, { bank: faladorBank, slots: 3 * missing, keep, withdraw: [
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

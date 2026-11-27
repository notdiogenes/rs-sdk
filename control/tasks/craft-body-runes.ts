import { auditEvent, auditFrame, auditOperation } from '../../sdk/audit-trace';
import type { ScriptContext } from '../../sdk/runner';
import type { BotWorldState, NearbyLoc } from '../../sdk/types';

const essenceId = 1436;
const bank = { x: 3185, z: 3436 };
const airBank = { x: 3092, z: 3243 };
const bodyLevel = 20;
const goal = 99;
const backpackSize = 28;
// The client publishes integer XP. The hosted curve reaches level 20 at 3,105 XP.
const level20Xp = 3105;
const airXp = 5;

// runecraft.dbrow and loc.pack use 64-tile map squares and concrete location IDs.
const air = {
    name: 'Air', rune: 556, talisman: 1438, ruins: 2452, altar: 2478, portal: 2465,
    outside: { x: 2985, z: 3292 }, square: { x: 44, z: 75 },
};
const body = {
    name: 'Body', rune: 559, talisman: 1446, ruins: 2457, altar: 2483, portal: 2470,
    outside: { x: 3053, z: 3445 }, square: { x: 39, z: 75 },
};
type Rune = typeof body;

function count(items: ReadonlyArray<{ id: number; count: number }>, id: number) {
    return items.reduce((sum, item) => item.id === id ? sum + item.count : sum, 0);
}

function runecraft(state: BotWorldState) {
    const skill = state.skills.find(entry => entry.name === 'Runecraft');
    if (!skill?.baseLevel || !Number.isFinite(skill.experience)) throw new Error('Waiting for live Runecraft stats.');
    return skill;
}

function near(state: BotWorldState, target: { x: number; z: number }, distance: number) {
    const p = state.player;
    return !!p && p.level === 0 && Math.max(Math.abs(p.worldX - target.x), Math.abs(p.worldZ - target.z)) <= distance;
}

function inTemple(state: BotWorldState, rune: Rune) {
    const p = state.player;
    return !!p && p.level === 0 && Math.floor(p.worldX / 64) === rune.square.x
        && Math.floor(p.worldZ / 64) === rune.square.z;
}

export async function craftBodyRunes({ bot, sdk }: ScriptContext) {
    const current = () => {
        const state = sdk.getState();
        if (!state?.inGame || !state.player || state.player.isDead) throw new Error('Runecrafting needs a live, living player.');
        return state;
    };
    const phase = (name: string, rune: Rune) => auditEvent('phase', name, {
        rune: rune.name, level: runecraft(current()).baseLevel, state: auditFrame(current()),
    });
    const act = async <T extends { success: boolean; message: string }>(
        name: string, intent: string, parameters: object, action: () => Promise<T>,
    ) => {
        const result = await auditOperation(name, intent, parameters, () => sdk.getState(), action,
            value => ({ outcome: value.success ? 'complete' : 'failed', message: value.message }));
        if (!result.success) throw new Error(`${intent}: ${result.message}`);
        return result;
    };

    async function walk(target: { x: number; z: number }, radius: number, name: string) {
        if (near(current(), target, radius)) return;
        await act('walk-to-runecraft-waypoint', `Reach ${name}`, target,
            () => bot.walkTo(target.x, target.z, radius, { timeout: 180_000 }));
        if (!near(current(), target, radius)) throw new Error(`Arrival at ${name} was not verified.`);
    }

    async function location(id: number, label: string): Promise<NearbyLoc> {
        const visible = current().nearbyLocs.find(loc => loc.id === id);
        const target = visible ?? (await sdk.scanNearbyLocs(32)).find(loc => loc.id === id);
        if (!target) throw new Error(`${label} is not visible near the expected tile.`);
        return target;
    }

    async function observe(name: string, predicate: (state: BotWorldState) => boolean) {
        try {
            return await sdk.waitForCondition(state => state.inGame && !!state.player && !state.player.isDead && predicate(state), 12_000);
        } catch {
            auditEvent('setback', 'runecraft-effect-unconfirmed', { effect: name, after: auditFrame(sdk.getState()) });
            throw new Error(`The game did not confirm ${name}.`);
        }
    }

    async function exit(rune: Rune) {
        phase('runecraft-exit', rune);
        const portal = await location(rune.portal, `${rune.name} exit portal`);
        await act('use-runecraft-portal', `Use the ${rune.name} temple exit`, { id: portal.id, x: portal.x, z: portal.z },
            () => bot.interactLoc(portal, /^use$/i));
        await observe(`the ${rune.name} temple exit`, state => near(state, rune.outside, 12));
    }

    async function closeBank() {
        if (!current().bank.isOpen) return;
        await act('close-runecraft-bank', 'Close the bank', {}, () => bot.closeBank());
    }

    const airNeeded = (state: BotWorldState) => Math.max(1, Math.ceil((level20Xp - runecraft(state).experience) / airXp));

    async function restock(rune: Rune) {
        phase('runecraft-bank', rune);
        if (!current().bank.isOpen) {
            const useDraynor = rune === air && near(current(), air.outside, 25);
            await walk(useDraynor ? airBank : bank, 4, useDraynor ? 'Draynor Bank' : 'Varrock West Bank');
            await act('open-runecraft-bank', 'Open the bank', {}, () => bot.openBank());
        }
        try {
            if (!current().bank.isOpen) throw new Error('Bank access was not verified.');
            const talisman = current().bank.items.find(item => item.id === rune.talisman);
            if (!count(current().inventory, rune.talisman)) {
                if (!talisman) throw new Error(`No ${rune.name} talisman in the backpack or bank.`);
                await act('withdraw-runecraft-talisman', `Withdraw a ${rune.name} talisman`, { id: rune.talisman },
                    () => bot.withdrawItem(talisman, 1, { asNote: false }));
            }
            for (const product of [air, body]) {
                const runes = current().inventory.find(item => item.id === product.rune);
                if (!runes) continue;
                await act('deposit-crafted-runes', `Deposit ${product.name} runes`, { id: product.rune, count: runes.count },
                    () => bot.depositItem(runes, -1));
            }
            if (rune === body) {
                const airTalisman = current().inventory.find(item => item.id === air.talisman);
                if (airTalisman) await act('deposit-air-talisman', 'Bank the Air talisman after the bootstrap', { id: air.talisman },
                    () => bot.depositItem(airTalisman, -1));
            }
            const carried = count(current().inventory, essenceId);
            const needed = rune === air ? airNeeded(current()) : backpackSize;
            if (rune === air && carried > needed) {
                const essence = current().inventory.find(item => item.id === essenceId)!;
                await act('deposit-surplus-essence', 'Save essence beyond the Air rune bootstrap', { amount: carried - needed },
                    () => bot.depositItem(essence, carried - needed));
            }
            const state = current();
            const stock = state.bank.items.find(item => item.id === essenceId);
            const held = count(state.inventory, essenceId);
            const amount = Math.min(backpackSize - state.inventory.length, needed - held, stock?.count ?? 0);
            if (amount > 0 && stock) {
                await act('withdraw-rune-essence', 'Withdraw rune essence', { amount, stock: stock.count },
                    () => bot.withdrawItem(stock, amount, { asNote: false }));
            }
            if (!count(current().inventory, essenceId)) {
                throw new Error(stock?.count ? 'The backpack has no space for unnoted rune essence.' : 'No rune essence remains in the bank.');
            }
            auditEvent('milestone', 'runecraft-bank-loaded', {
                rune: rune.name, essence: count(current().inventory, essenceId), bankEssence: count(current().bank.items, essenceId),
            });
        } catch (error) {
            await closeBank().catch(() => {});
            throw error;
        }
        await closeBank();
    }

    while (runecraft(current()).baseLevel < goal) {
        const state = current();
        const rune = runecraft(state).baseLevel < bodyLevel ? air : body;
        const temple = [air, body].find(candidate => inTemple(state, candidate));
        const essence = count(state.inventory, essenceId);
        if (temple && (temple !== rune || !essence || (rune === air && essence > airNeeded(state)))) {
            await exit(temple);
            continue;
        }
        if (!temple) {
            if (!essence || !count(state.inventory, rune.talisman) || (rune === air && essence > airNeeded(state))) await restock(rune);
            else await closeBank();
            phase('runecraft-enter', rune);
            await walk(rune.outside, 4, `${rune.name} ruins`);
            const ruins = await location(rune.ruins, `${rune.name} ruins`);
            const talisman = current().inventory.find(item => item.id === rune.talisman);
            if (!talisman) throw new Error(`${rune.name} talisman is missing before temple entry.`);
            // This SDK helper observes general action feedback. The map-square change confirms entry.
            const entered = await bot.useItemOnLoc(talisman, ruins, { timeout: 5500 });
            auditEvent('action', 'use-runecraft-talisman', { rune: rune.name, id: ruins.id, success: entered.success, message: entered.message });
            await observe(`${rune.name} temple entry`, next => inTemple(next, rune));
        }
        phase('runecraft-craft', rune);
        const altar = await location(rune.altar, `${rune.name} altar`);
        const before = current();
        const beforeStock = count(before.inventory, essenceId);
        const beforeRunes = count(before.inventory, rune.rune);
        const beforeXp = runecraft(before).experience;
        const after = await auditOperation('craft-runes', `Craft ${rune.name} runes and verify the batch`,
            { id: altar.id, x: altar.x, z: altar.z, essence: beforeStock }, () => sdk.getState(), async () => {
                const result = await bot.interactLoc(altar, /^craft-rune$/i);
                if (!result.success) throw new Error(`Craft ${rune.name} runes: ${result.message}`);
                return observe(`${rune.name} rune crafting`, next => count(next.inventory, essenceId) < beforeStock
                    && count(next.inventory, rune.rune) > beforeRunes && runecraft(next).experience > beforeXp);
            }, next => ({
                outcome: 'complete', essenceUsed: beforeStock - count(next.inventory, essenceId),
                runesCrafted: count(next.inventory, rune.rune) - beforeRunes, xpGained: runecraft(next).experience - beforeXp,
            }));
        auditEvent('milestone', 'runecraft-batch-confirmed', {
            rune: rune.name, essenceUsed: beforeStock - count(after.inventory, essenceId),
            runesCrafted: count(after.inventory, rune.rune) - beforeRunes,
            xpGained: runecraft(after).experience - beforeXp, level: runecraft(after).baseLevel,
        });
    }
}

if (import.meta.main) {
    const { runScript } = await import('../../sdk/runner');
    await runScript(craftBodyRunes);
}

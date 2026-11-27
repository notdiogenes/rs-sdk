import { auditEvent, auditFrame, auditOperation } from '../../sdk/audit-trace';
import type { ScriptContext } from '../../sdk/runner';
import type { BotWorldState, InventoryItem, NearbyLoc } from '../../sdk/types';
import { guildLadder, inMiningGuild, miningBanks, miningDistance, miningResources, miningSelection, rankMiningSites, type MiningSite, type Tile } from '../mining-routes';

const pickaxe = 1275;
const capacity = 28;
const insideEssenceMine = (p: Tile) => Math.floor(p.x / 64) === 45 && Math.floor(p.z / 64) === 75;
const canEat = (item: InventoryItem) => item.optionsWithIndex.some(option => /^eat$/i.test(option.text));
const tile = (state: BotWorldState) => ({ x: state.player!.worldX, z: state.player!.worldZ });
const skill = (state: BotWorldState) => state.skills.find(entry => entry.name === 'Mining');
const hasPick = (state: BotWorldState) => [...state.inventory, ...state.equipment].some(item => item.id === pickaxe);

export async function mineResources({ bot, sdk }: ScriptContext, task = process.env.RS_ACTIVITY ?? 'mine-iron-bank') {
    const selection = miningSelection(task);
    function current() {
        const state = sdk.getState();
        if (!state?.inGame || !state.player || state.player.isDead || sdk.getStateAge() > 10_000) {
            throw new Error('Mining requires a fresh game state and a living player.');
        }
        if (state.player.level !== 0 || (state.player.worldZ >= 3520 && !insideEssenceMine(tile(state)) && !inMiningGuild(tile(state)))) {
            throw new Error('Mining requires a supported location outside the Wilderness.');
        }
        return state;
    }

    const level = skill(current())?.baseLevel;
    if (level === undefined || level < 41) throw new Error('Mining level 41 is required to use the rune pickaxe.');
    const { resource } = selection;
    const settings = miningResources[resource];
    const products: readonly number[] = settings.items;
    const rockIds: readonly number[] = settings.rocks;
    const isProduct = (item: InventoryItem) => products.includes(item.id);
    const quantity = (state: BotWorldState) => state.inventory.filter(isProduct).reduce((sum, item) => sum + item.count, 0);
    if (level < settings.level) throw new Error(`${settings.label} requires Mining level ${settings.level}.`);
    if (resource === 'essence' && current().questJournal?.[7335] !== 'complete' && !insideEssenceMine(tile(current()))) {
        throw new Error('Rune Mysteries must be complete to access the rune essence mine.');
    }
    if (resource === 'gems' && current().questJournal?.[7376] !== 'complete' &&
        miningDistance(tile(current()), miningBanks.shilo) > 45) {
        throw new Error('Shilo Village must be complete to travel to its gem mine.');
    }

    const phase = (name: string, data: object = {}) => auditEvent('phase', name, {
        resource, mode: selection.mode, ...data, state: auditFrame(current()),
    });
    const observe = (predicate: (state: BotWorldState) => boolean, timeout: number) =>
        sdk.waitForCondition(state => state.inGame && !!state.player && !state.player.isDead && predicate(state), timeout);
    async function act<T extends { success: boolean; message: string }>(
        name: string, message: string, data: object, operation: () => Promise<T>,
    ) {
        const result = await auditOperation(name, message, data, () => sdk.getState(), operation,
            value => ({ outcome: value.success ? 'complete' : 'failed', message: value.message }));
        if (!result.success) throw new Error(`${message}: ${result.message}`);
        return result;
    }

    async function walk(target: Tile & { name: string }, radius: number) {
        if (miningDistance(tile(current()), target) <= radius) return;
        await act('mining-walk', `Reach ${target.name}`, target, () => bot.walkTo(target.x, target.z, radius, { timeout: 150_000 }));
        if (miningDistance(tile(current()), target) > radius) throw new Error(`Arrival at ${target.name} was not confirmed.`);
    }

    async function leaveEssenceMine() {
        if (!insideEssenceMine(tile(current()))) return;
        phase('mining-essence-exit');
        const portals = (await sdk.scanNearbyLocs(36)).filter(loc => loc.id === 2492 && loc.reachable !== false)
            .sort((a, b) => a.distance - b.distance);
        for (const portal of portals) {
            const option = portal.optionsWithIndex[0];
            if (!option) continue;
            const dispatch = await sdk.sendInteractLoc(portal.x, portal.z, portal.id, option.opIndex);
            if (!dispatch.success) continue;
            await observe(state => !insideEssenceMine(tile(state)), 12_000);
            auditEvent('milestone', 'mining-essence-exited');
            return;
        }
        throw new Error('No reachable exit portal was found in the essence mine.');
    }

    async function guildTransition(enter: boolean) {
        const target = enter ? guildLadder : { ...guildLadder, z: guildLadder.z + 6400 };
        await walk(target, 4);
        const ladder = current().nearbyLocs.filter(loc => loc.id === (enter ? 2113 : 1755) && loc.reachable !== false)
            .sort((a, b) => a.distance - b.distance)[0];
        if (!ladder) throw new Error('No reachable Mining Guild ladder was found.');
        const direction = enter ? /^climb-down$/i : /^climb-up$/i;
        await act('mining-guild-ladder', enter ? 'Enter the Mining Guild' : 'Leave the Mining Guild', { id: ladder.id },
            () => bot.interactLoc(ladder, direction));
        await observe(state => inMiningGuild(tile(state)) === enter, 10_000);
    }

    async function openBank(bank: typeof miningBanks.west) {
        if (current().bank.isOpen) return;
        await leaveEssenceMine();
        if (inMiningGuild(tile(current()))) await guildTransition(false);
        await walk(bank, 4);
        await act('mining-open-bank', `Open ${bank.name}`, bank, () => bot.openBank());
        if (!current().bank.isOpen) throw new Error('The game did not confirm bank access.');
    }

    async function closeBank() {
        if (current().bank.isOpen) await act('mining-close-bank', 'Close the bank', {}, () => bot.closeBank());
    }

    async function bankItems(keep: (item: InventoryItem) => boolean) {
        const items = current().inventory.filter(item => !keep(item));
        for (const id of new Set(items.map(item => item.id))) {
            const item = current().inventory.find(entry => entry.id === id);
            if (!item) continue;
            await act('mining-deposit', `Deposit ${item.name}`, { id }, () => bot.depositItem(item, -1));
            if (current().inventory.some(entry => entry.id === id)) throw new Error(`Deposit of ${item.name} was not confirmed.`);
        }
    }

    phase('mining-setup');
    const keep = (item: InventoryItem) => item.id === pickaxe || canEat(item);
    const bag = current();
    if (bag.bank.isOpen || !hasPick(bag) || bag.inventory.some(item => !keep(item))) {
        const bank = Object.values(miningBanks).filter(candidate => candidate !== miningBanks.shilo
            || miningDistance(candidate, tile(bag)) < 75)
            .sort((a, b) => miningDistance(tile(bag), a) - miningDistance(tile(bag), b))[0]!;
        await openBank(insideEssenceMine(tile(bag)) ? miningBanks.east : inMiningGuild(tile(bag)) ? miningBanks.falador : bank);
        await bankItems(keep);
        if (!hasPick(current())) {
            const stored = current().bank.items.find(item => item.id === pickaxe);
            if (!stored) throw new Error('The rune pickaxe was not found in the backpack, equipment, or bank.');
            await act('mining-withdraw-rune-pickaxe', 'Withdraw the rune pickaxe', { id: pickaxe },
                () => bot.withdrawItem(stored, 1, { asNote: false }));
        }
        await closeBank();
    }
    if (!hasPick(current())) throw new Error('The game did not confirm possession of the rune pickaxe.');
    auditEvent('milestone', 'mining-pickaxe-ready', { id: pickaxe, level });

    const isRock = (loc: NearbyLoc) => loc.reachable !== false && rockIds.includes(loc.id) &&
        loc.optionsWithIndex.some(option => /^mine$/i.test(option.text));
    async function mineRock(rock: NearbyLoc) {
        const option = rock.optionsWithIndex.find(entry => /^mine$/i.test(entry.text))!;
        const before = current();
        const xp = skill(before)?.experience ?? 0;
        const count = quantity(before);
        const rejected = before.opFeedback?.opRejectedCount ?? 0;
        const dispatch = await sdk.sendInteractLoc(rock.x, rock.z, rock.id, option.opIndex);
        if (!dispatch.success) return false;
        const timeout = resource === 'adamantite' || resource === 'mithril' ? 45_000 : 24_000;
        const after = await observe(state => (quantity(state) > count && (skill(state)?.experience ?? 0) > xp)
            || (state.opFeedback?.opRejectedCount ?? 0) > rejected, timeout).catch(() => null);
        if (!after || quantity(after) <= count || (skill(after)?.experience ?? 0) <= xp) return false;
        auditEvent('milestone', 'mining-product-confirmed', {
            resource, rock: rock.id, x: rock.x, z: rock.z, quantity: quantity(after) - count,
            xp: skill(after)!.experience - xp,
        });
        return true;
    }

    async function unload(site: MiningSite) {
        const count = quantity(current());
        if (!count) throw new Error('The backpack is full with supplies and has no space for ore.');
        const began = Date.now();
        if (selection.mode === 'bank') {
            phase('mining-bank-trip', { bank: site.bank.name, quantity: count });
            await openBank(site.bank);
            await bankItems(item => !isProduct(item));
            await closeBank();
        } else {
            phase('mining-drop-haul', { quantity: count });
            for (const id of products) {
                const item = current().inventory.find(entry => entry.id === id);
                if (item) await act('mining-drop-product', `Drop ${item.name}`, { id }, () => bot.dropItem(item, 'all'));
            }
        }
        if (quantity(current()) !== 0) throw new Error('The game did not confirm unloading the full haul.');
        auditEvent('milestone', 'mining-haul-confirmed', { resource, mode: selection.mode, quantity: count, elapsedMs: Date.now() - began });
    }

    async function travel(site: MiningSite) {
        if (site.teleport && insideEssenceMine(tile(current()))) return;
        await leaveEssenceMine();
        phase('mining-travel', { site: site.mine.name });
        const underground = inMiningGuild(tile(current()));
        if (Boolean(site.guild) !== underground) await guildTransition(Boolean(site.guild));
        await walk(site.mine, site.teleport ? 4 : 8);
        if (site.teleport) {
            await act('mining-essence-teleport', `Teleport with ${site.teleport}`, { npc: site.teleport },
                () => bot.interactNpc(site.teleport!, /^teleport$/i));
            await observe(state => insideEssenceMine(tile(state)), 12_000);
        }
        auditEvent('milestone', 'mining-site-reached', { site: site.mine.name });
    }

    let quietSweeps = 0;
    while (quietSweeps < 3) {
        const sites = rankMiningSites(resource, selection.mode, tile(current()), level);
        let produced = false;
        for (const site of sites) {
            try {
                await travel(site);
                phase('mining-extract', { site: site.mine.name });
                let missed = 0;
                let emptySince = 0;
                while (missed < 3) {
                    const state = current();
                    if (!hasPick(state)) throw new Error('The rune pickaxe is no longer usable or present.');
                    if (state.player!.hp <= Math.max(8, Math.floor(state.player!.maxHp / 3))) {
                        const food = state.inventory.find(canEat);
                        if (!food) throw new Error('Low HP and no food in the backpack.');
                        await act('mining-eat', 'Recover HP', {}, () => bot.eatFood(food));
                    }
                    if (state.inventory.length >= capacity) {
                        await unload(site);
                        await travel(site);
                        phase('mining-extract', { site: site.mine.name });
                    }
                    const here = current();
                    const rock = here.nearbyLocs.filter(loc => isRock(loc) &&
                        (site.teleport || miningDistance(loc, site.mine) <= 25)).sort((a, b) => a.distance - b.distance)[0];
                    if (!rock) {
                        emptySince ||= Date.now();
                        const competitors = here.nearbyPlayers.filter(player => miningDistance(player, site.mine) <= 16).length;
                        const wait = competitors ? 18_000 : Math.min(90_000, Math.max(24_000, settings.respawn * 1000));
                        if (Date.now() - emptySince >= wait) {
                            auditEvent('setback', 'mining-patch-depleted', { site: site.mine.name, competitors, waitedMs: wait });
                            break;
                        }
                        await sdk.waitForTicks(3);
                        continue;
                    }
                    emptySince = 0;
                    if (await auditOperation('mining-swing', `Mine ${settings.label}`, { rock: rock.id, x: rock.x, z: rock.z },
                        () => sdk.getState(), () => mineRock(rock), ok => ({ outcome: ok ? 'complete' : 'unconfirmed' }))) {
                        produced = true;
                        quietSweeps = 0;
                        missed = 0;
                    } else {
                        missed++;
                        auditEvent('setback', 'mining-swing-unconfirmed', { site: site.mine.name, x: rock.x, z: rock.z, missed });
                        await sdk.waitForTicks(2);
                    }
                }
            } catch (error) {
                if (!hasPick(current()) || current().player!.hp <= 8) throw error;
                auditEvent('setback', 'mining-route-failed', { site: site.mine.name, message: error instanceof Error ? error.message : String(error) });
                await closeBank();
            }
            auditEvent('milestone', 'mining-switch-route', { from: site.mine.name, resource, mode: selection.mode });
        }
        if (!produced) quietSweeps++;
        if (quietSweeps < 3) await sdk.waitForTicks(10);
    }
    throw new Error(`Could not sustain mining ${settings.label} at any checked site.`);
}

if (import.meta.main) {
    const { runScript } = await import('../../sdk/runner');
    await runScript(mineResources);
}

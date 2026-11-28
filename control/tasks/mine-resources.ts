import { auditEvent, auditFrame, auditOperation } from '../../sdk/audit-trace';
import { throwIfExecutionAborted } from '../../sdk/execution-context';
import type { ScriptContext } from '../../sdk/runner';
import type { BotWorldState, InventoryItem, NearbyLoc } from '../../sdk/types';
import { reportTaskActivity } from '../dashboard-task-activity';
import { alKharidTollGate, coalTrucks, fishingGuildBank, guildLadder, inMiningGuild, miningBanks, miningDistance,
    miningResources, miningSelection, miningSiteBanks, miningTravelDistance, miningTravelTimeout, miningTravelVia,
    rankMiningSites, type MiningSite, type Tile } from '../mining-routes';

const pickaxe = 1275;
const capacity = 28;
const insideEssenceMine = (p: Tile) => Math.floor(p.x / 64) === 45 && Math.floor(p.z / 64) === 75;
const canEat = (item: InventoryItem) => item.optionsWithIndex.some(option => /^eat$/i.test(option.text));
const tile = (state: BotWorldState) => ({ x: state.player!.worldX, z: state.player!.worldZ });
const skill = (state: BotWorldState) => state.skills.find(entry => entry.name === 'Mining');
const fishingLevel = (state: BotWorldState) => state.skills.find(entry => entry.name === 'Fishing')?.level ?? 0;
const hasPick = (state: BotWorldState) => [...state.inventory, ...state.equipment].some(item => item.id === pickaxe);

export async function mineResources({ bot, sdk }: ScriptContext, task = process.env.RS_ACTIVITY ?? 'mine-iron-bank',
    bankTarget = process.env.RS_ACTIVITY_BANK_TARGET ? Number(process.env.RS_ACTIVITY_BANK_TARGET) : undefined) {
    const selection = miningSelection(task);
    if (bankTarget !== undefined && (selection.mode !== 'bank' || !Number.isSafeInteger(bankTarget) || bankTarget < 1 || bankTarget > 100_000)) {
        throw new Error('A bank stock target must be between 1 and 100,000 and requires banking mode.');
    }
    function current() {
        throwIfExecutionAborted();
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
    const material = settings.label.toLowerCase();
    const rockLabel = resource === 'gems' ? 'gem rock' : `${material} rock`;
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

    async function walkLeg(target: Tile & { name: string }, radius: number, label = `Walking to ${target.name}`) {
        const distance = miningDistance(tile(current()), target);
        if (distance <= radius) return;
        const timeout = miningTravelTimeout(distance);
        reportTaskActivity(label);
        await act('mining-walk', `Reach ${target.name}`, { ...target, distance, timeout },
            () => bot.walkTo(target.x, target.z, radius, { timeout }));
        if (miningDistance(tile(current()), target) > radius) throw new Error(`Arrival at ${target.name} was not confirmed.`);
    }

    async function dismissTollDialogue() {
        const state = current();
        if (!state.dialog?.isOpen || miningDistance(tile(state), alKharidTollGate) > 2) return;
        const text = [state.dialog.text, ...state.dialog.options.map(option => option.text),
            ...(state.dialog.allComponents ?? []).map(component => component.text)].join(' ');
        if (!/come through this gate|pay a toll|walk around|you may pass for free/i.test(text)) return;
        await act('mining-dismiss-toll', 'Close the Al Kharid toll dialogue', {}, () => sdk.sendCloseModal());
        await observe(next => !next.dialog.isOpen, 5_000);
    }

    async function walk(target: Tile & { name: string }, radius: number, label?: string) {
        const via = miningTravelVia(tile(current()), target);
        await dismissTollDialogue();
        if (via) await walkLeg(via, 0);
        await walkLeg(target, radius, label);
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
        await walk(bank, bank === fishingGuildBank ? 1 : 4);
        reportTaskActivity(`Opening ${bank.name}`);
        await act('mining-open-bank', `Open ${bank.name}`, bank, () => bot.openBank());
        if (!current().bank.isOpen) throw new Error('The game did not confirm bank access.');
    }

    async function openFirstBank(banks: readonly (typeof miningBanks.west)[], quantity?: number) {
        let lastError: unknown;
        for (const bank of banks) {
            try {
                if (quantity !== undefined) phase('mining-bank-trip', { bank: bank.name, quantity });
                await openBank(bank);
                return;
            } catch (error) {
                current();
                lastError = error;
                auditEvent('setback', quantity === undefined ? 'mining-setup-bank-failed' : 'mining-haul-bank-failed', {
                    bank: bank.name, message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        throw lastError;
    }

    async function openSetupBank() {
        if (current().bank.isOpen) return;
        await leaveEssenceMine();
        if (inMiningGuild(tile(current()))) await guildTransition(false);
        const state = current();
        const start = tile(state);
        const preferred = resource === 'coal' && selection.mode === 'bank' && miningDistance(start, coalTrucks.mine) <= 25
            ? miningSiteBanks(coalTrucks, fishingLevel(state)) : [];
        const nearby = Object.values(miningBanks).filter(bank => bank !== miningBanks.shilo || miningDistance(start, bank) < 75)
            .sort((a, b) => miningTravelDistance(start, a) - miningTravelDistance(start, b));
        await openFirstBank([...new Set([...preferred, ...nearby])].slice(0, 3));
    }

    async function closeBank() {
        if (current().bank.isOpen) await act('mining-close-bank', 'Close the bank', {}, () => bot.closeBank());
    }

    async function bankItems(keep: (item: InventoryItem) => boolean, label = 'Banking items') {
        const items = current().inventory.filter(item => !keep(item));
        if (items.length) reportTaskActivity(label);
        for (const id of new Set(items.map(item => item.id))) {
            const item = current().inventory.find(entry => entry.id === id);
            if (!item) continue;
            await act('mining-deposit', `Deposit ${item.name}`, { id }, () => bot.depositItem(item, -1));
            if (current().inventory.some(entry => entry.id === id)) throw new Error(`Deposit of ${item.name} was not confirmed.`);
        }
    }

    let remaining = Infinity;
    function checkStock() {
        if (bankTarget === undefined) return false;
        const { bank } = current();
        if (!bank.isOpen) throw new Error('Open the bank before checking the mining stock target.');
        const banked = bank.items.filter(item => products.includes(item.id)).reduce((sum, item) => sum + item.count, 0);
        remaining = Math.max(0, bankTarget - banked);
        auditEvent('milestone', remaining ? 'mining-bank-target-progress' : 'mining-bank-target-confirmed',
            { resource, banked, target: bankTarget, remaining });
        return remaining === 0;
    }

    phase('mining-setup');
    const keep = (item: InventoryItem) => item.id === pickaxe || canEat(item);
    const bag = current();
    if (bankTarget !== undefined || bag.bank.isOpen || !hasPick(bag) || bag.inventory.some(item => !keep(item))) {
        await openSetupBank();
        await bankItems(keep);
        if (checkStock()) {
            await closeBank();
            return;
        }
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
        if (resource !== 'essence') {
            const position = tile(current());
            const sides = [{ x: rock.x + 1, z: rock.z }, { x: rock.x, z: rock.z - 1 },
                { x: rock.x - 1, z: rock.z }, { x: rock.x, z: rock.z + 1 }]
                .sort((a, b) => miningDistance(a, position) - miningDistance(b, position));
            let side: Tile | undefined;
            for (const point of sides) {
                if (miningDistance(point, position) === 0 || await sdk.canRouteToTile(0, position.x, position.z, point.x, point.z, 50)) {
                    side = point;
                    break;
                }
            }
            if (!side) return { outcome: 'unconfirmed', message: 'No reachable tile beside this rock.' };
            await walk({ ...side, name: 'the tile beside the rock' }, 0, `Moving to a new ${rockLabel}`);
        }
        const atTile = (await sdk.scanNearbyLocs(resource === 'essence' ? 18 : 5))
            .filter(loc => loc.x === rock.x && loc.z === rock.z);
        const live = atTile.find(isRock);
        const option = live?.optionsWithIndex.find(entry => /^mine$/i.test(entry.text));
        if (!live || !option) {
            const reason = atTile.some(loc => rockIds.includes(loc.id)) ? 'The rock is no longer reachable with a Mine option.'
                : 'The rock tile has no active ore on rescan.';
            return { outcome: 'unconfirmed', message: reason };
        }
        const before = current();
        const xp = skill(before)?.experience ?? 0;
        const count = quantity(before);
        const dispatch = await sdk.sendInteractLoc(live.x, live.z, live.id, option.opIndex);
        if (!dispatch.success) return { outcome: 'unconfirmed', message: dispatch.message };
        reportTaskActivity(`Mining ${material}`);
        const timeout = resource === 'adamantite' || resource === 'mithril' ? 45_000 : 24_000;
        const feedback = (state: BotWorldState, pattern: RegExp) => state.gameMessages?.find(message =>
            message.tick > before.tick && message.type === 0 && pattern.test(message.text))?.text;
        const refusal = (state: BotWorldState) =>
            feedback(state, /no (ore|minerals)|need a (pickaxe|mining level)|inventory is too full|can't reach|cannot reach/i);
        const earned = (state: BotWorldState) => quantity(state) > count && (skill(state)?.experience ?? 0) > xp;
        const finished = (state: BotWorldState) => earned(state) || !!refusal(state);
        const swung = (state: BotWorldState) => !!feedback(state, /you swing your pick at the rock/i);
        const startTimeout = 6_000;
        const started = await observe(state => finished(state) || swung(state), startTimeout).catch(() => current());
        if (!finished(started) && !swung(started)) {
            return { outcome: 'unconfirmed', message: 'No mining swing was observed after dispatch.' };
        }
        const after = finished(started) ? started : await observe(finished, timeout - startTimeout).catch(() => current());
        if (!earned(after)) {
            return { outcome: 'unconfirmed', message: refusal(after) || 'The swing started but did not yield ore and XP.' };
        }
        auditEvent('milestone', 'mining-product-confirmed', {
            resource, rock: live.id, x: live.x, z: live.z, quantity: quantity(after) - count,
            xp: skill(after)!.experience - xp,
        });
        return { outcome: 'complete' };
    }

    async function unload(site: MiningSite) {
        const count = quantity(current());
        if (!count) throw new Error('The backpack is full with supplies and has no space for ore.');
        const began = Date.now();
        let complete = false;
        if (selection.mode === 'bank') {
            await openFirstBank(miningSiteBanks(site, fishingLevel(current())), count);
            await bankItems(item => !isProduct(item), `Banking ${material}`);
            complete = checkStock();
            await closeBank();
        } else {
            phase('mining-drop-haul', { quantity: count });
            reportTaskActivity(`Dropping ${material}`);
            for (const id of products) {
                const item = current().inventory.find(entry => entry.id === id);
                if (item) await act('mining-drop-product', `Drop ${item.name}`, { id }, () => bot.dropItem(item, 'all'));
            }
        }
        if (quantity(current()) !== 0) throw new Error('The game did not confirm unloading the full haul.');
        auditEvent('milestone', 'mining-haul-confirmed', { resource, mode: selection.mode, quantity: count, elapsedMs: Date.now() - began });
        return complete;
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
    const retryAfter = new Map<string, number>();
    const productiveRocks = new Set<string>();
    const rockKey = (loc: NearbyLoc) => `${loc.x}:${loc.z}`;
    while (quietSweeps < 3) {
        const visited = new Set<MiningSite>();
        let produced = false;
        for (;;) {
            const state = current();
            const site = rankMiningSites(resource, selection.mode, tile(state), level, fishingLevel(state))
                .find(candidate => !visited.has(candidate));
            if (!site) break;
            visited.add(site);
            try {
                await travel(site);
                phase('mining-extract', { site: site.mine.name });
                const failedRocks = new Set<string>();
                let attemptsWithoutOre = 0;
                let emptySince = 0;
                let yieldedHere = false;
                while (true) {
                    const state = current();
                    if (!hasPick(state)) throw new Error('The rune pickaxe is no longer usable or present.');
                    if (state.player!.hp <= Math.max(8, Math.floor(state.player!.maxHp / 3))) {
                        const food = state.inventory.find(canEat);
                        if (!food) throw new Error('Low HP and no food in the backpack.');
                        await act('mining-eat', 'Recover HP', {}, () => bot.eatFood(food));
                    }
                    if (state.inventory.length >= capacity || quantity(state) >= remaining) {
                        if (await unload(site)) return;
                        await travel(site);
                        phase('mining-extract', { site: site.mine.name });
                    }
                    const here = current();
                    const now = Date.now();
                    const candidates = here.nearbyLocs.filter(loc => isRock(loc) &&
                        (retryAfter.get(rockKey(loc)) ?? 0) <= now &&
                        (site.teleport || miningDistance(loc, site.mine) <= 25)).sort((a, b) => a.distance - b.distance);
                    const proven = candidates.find(loc => productiveRocks.has(rockKey(loc)) && !failedRocks.has(rockKey(loc)));
                    const tooManyMisses = failedRocks.size >= 3 || attemptsWithoutOre >= 6;
                    const rock = proven ?? (tooManyMisses ? undefined : candidates[0]);
                    if (!rock) {
                        if (tooManyMisses) break;
                        if (!emptySince) {
                            emptySince = Date.now();
                            reportTaskActivity(`Waiting for a ${rockLabel}`);
                        }
                        const nearbyPlayers = here.nearbyPlayers.filter(player => miningDistance(player, site.mine) <= 16).length;
                        const wait = nearbyPlayers && !yieldedHere ? 18_000 : Math.min(90_000, Math.max(24_000, settings.respawn * 1000));
                        if (Date.now() - emptySince >= wait) {
                            auditEvent('setback', 'mining-patch-depleted', { site: site.mine.name, nearbyPlayers, yieldedHere, waitedMs: wait });
                            break;
                        }
                        await sdk.waitForTicks(3);
                        continue;
                    }
                    emptySince = 0;
                    const result = await auditOperation('mining-swing', `Mine ${settings.label}`, { rock: rock.id, x: rock.x, z: rock.z },
                        () => sdk.getState(), () => mineRock(rock), value => value);
                    if (result.outcome === 'complete') {
                        produced = true;
                        yieldedHere = true;
                        quietSweeps = 0;
                        attemptsWithoutOre = 0;
                        failedRocks.clear();
                        productiveRocks.add(rockKey(rock));
                        if (resource !== 'essence') retryAfter.set(rockKey(rock), Date.now() + settings.respawn * 1000);
                    } else {
                        attemptsWithoutOre++;
                        failedRocks.add(rockKey(rock));
                        retryAfter.set(rockKey(rock), Date.now() + Math.min(24_000, settings.respawn * 1000));
                        auditEvent('setback', 'mining-swing-unconfirmed', { site: site.mine.name, x: rock.x, z: rock.z,
                            failedRocks: failedRocks.size, message: result.message });
                        await sdk.waitForTicks(2);
                    }
                }
                if (selection.mode === 'bank' && quantity(current()) > 0 && await unload(site)) return;
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

import { auditEvent } from '../../sdk/audit-trace';
import { runScript, type ScriptContext } from '../../sdk/runner';
import { Spells } from '../../sdk/spells';
import type { BotWorldState } from '../../sdk/types';
import { bankLocations, place, type NamedTile, type Tile } from '../bank-locations';
import { reportTaskActivity } from '../dashboard-task-activity';
import { reportBankStockTarget } from './bank-stock';
import { fishingGuildBank } from '../mining-routes';
import { trainSmithingWithIron } from './mithril-smithing-training';
import { withTaskUpdateCheckpoints, type TaskCheckpoint } from './update-checkpoint';

const faladorBank = bankLocations.falador;
const furnace = { ...place('the Falador furnace', 2975, 3368), id: 2781 };
const teleportTile = { x: 2965, z: 3378 };
const catherbyBank = place('Catherby Bank', 2809, 3441);
const mithrilOre = 447;
const coal = 453;
const mithrilBar = 2359;
const coalPerBar = 4;
const barsPerLoad = Math.floor(28 / (1 + coalPerBar));
const faladorRunes = [{ id: 556, amount: 3, name: 'air' }, { id: 555, amount: 1, name: 'water' }, { id: 563, amount: 1, name: 'law' }];
const carried = (state: BotWorldState, id: number) =>
    state.inventory.reduce((total, item) => total + (item.id === id ? item.count : 0), 0);

export async function smeltMithrilFalador(ctx: ScriptContext, checkpoint?: TaskCheckpoint,
    target = process.env.RS_ACTIVITY_BANK_TARGET ? Number(process.env.RS_ACTIVITY_BANK_TARGET) : undefined) {
    const { bot, sdk } = ctx;
    if (target !== undefined && (!Number.isSafeInteger(target) || target < 1 || target > 100_000)) {
        throw new Error('Choose a bank target between 1 and 100,000 mithril bars.');
    }
    reportTaskActivity('Preparing to smelt mithril bars');
    await sdk.waitForReady();

    function current() {
        const state = sdk.getState();
        if (!state?.inGame || !state.player || state.player.isDead || sdk.getStateAge() > 10_000) {
            throw new Error('Mithril smelting requires a fresh game state and a living player.');
        }
        return { ...state, player: state.player };
    }

    function distance(tile: Tile) {
        const { player } = current();
        return Math.max(Math.abs(player.worldX - tile.x), Math.abs(player.worldZ - tile.z));
    }

    function inFalador() {
        const { player } = current();
        return player.level === 0 && player.worldX >= 2943 && player.worldX <= 3020
            && player.worldZ >= 3336 && player.worldZ <= 3396;
    }

    function quantity(id: number) {
        return carried(current(), id);
    }

    function stored(id: number) {
        const { bank } = current();
        if (!bank.isOpen) throw new Error('Open the bank before reading banked supplies.');
        return bank.items.find(item => item.id === id)?.count ?? 0;
    }

    async function requireAction(label: string, action: Promise<{ success: boolean; message: string }>) {
        const result = await action;
        if (!result.success) throw new Error(`${label}: ${result.message}`);
    }

    async function walk(tile: NamedTile, tolerance: number) {
        if (distance(tile) <= tolerance) return;
        reportTaskActivity(`Walking to ${tile.name}`);
        await requireAction(`Reach ${tile.name}`, bot.walkTo(tile.x, tile.z, tolerance));
    }

    async function closeBank() {
        if (current().bank.isOpen) await requireAction('Close the bank', bot.closeBank());
    }

    async function openBank(tile: NamedTile) {
        if (current().bank.isOpen && distance(tile) <= 3) return;
        await closeBank();
        if (current().shop.isOpen) await requireAction('Close the shop', bot.closeShop());
        if (current().interface.isOpen) await requireAction('Close the open interface', bot.closeInterface());
        await walk(tile, 3);
        await bot.dismissBlockingUI();
        reportTaskActivity(`Opening ${tile.name}`);
        await requireAction(`Open ${tile.name}`, bot.openBank());
        if (!current().bank.isOpen) throw new Error(`${tile.name} did not open.`);
    }

    async function depositAll() {
        const ids = new Set(current().inventory.map(item => item.id));
        for (const id of ids) {
            const item = current().inventory.find(candidate => candidate.id === id);
            if (!item) continue;
            await requireAction(`Bank ${item.name}`, bot.depositItem(item, -1));
            if (quantity(id)) throw new Error(`Deposit of ${item.name} was not confirmed.`);
        }
        if (current().inventory.length) throw new Error('The backpack was not emptied at the bank.');
    }

    async function withdraw(id: number, amount: number) {
        const item = current().bank.items.find(entry => entry.id === id);
        if (!item || item.count < amount) throw new Error(`The bank cannot supply ${amount} of item ${id}.`);
        const before = quantity(id);
        await requireAction(`Withdraw ${item.name}`, bot.withdrawItem(item, amount));
        if (quantity(id) - before !== amount) throw new Error(`Withdrawal of ${item.name} was not confirmed.`);
    }

    async function bankStartingItems(tile: NamedTile) {
        await openBank(tile);
        reportTaskActivity(`Banking carried items at ${tile.name}`);
        await depositAll();
        const equipped = current().equipment;
        if (equipped.length) {
            await closeBank();
            reportTaskActivity('Removing worn gear for banking');
            for (const item of equipped) await requireAction(`Remove ${item.name}`, bot.unequipItem(item));
            await openBank(tile);
            reportTaskActivity(`Banking worn gear at ${tile.name}`);
            await depositAll();
        }
        if (current().equipment.length) throw new Error('Worn items were not fully banked.');
        auditEvent('milestone', 'smelting-starting-items-banked', { bank: tile.name });
    }

    async function teleport() {
        const magic = sdk.getSkill('Magic')?.level ?? 0;
        if (magic < 37) throw new Error('Falador Teleport requires Magic 37.');
        const missing = faladorRunes.filter(rune => stored(rune.id) < rune.amount);
        if (missing.length) throw new Error(`Missing Falador Teleport runes: ${missing.map(rune => rune.name).join(', ')}.`);
        reportTaskActivity('Withdrawing runes for Falador Teleport');
        for (const rune of faladorRunes) await withdraw(rune.id, rune.amount);
        await closeBank();
        await bot.dismissBlockingUI();
        reportTaskActivity('Casting Falador Teleport');
        await requireAction('Cast Falador Teleport', sdk.sendClickComponent(Spells.FALADOR_TELEPORT));
        await sdk.waitForCondition(state => {
            const player = state.player;
            return player?.level === 0 && Math.max(Math.abs(player.worldX - teleportTile.x), Math.abs(player.worldZ - teleportTile.z)) <= 2
                && !state.inventory.some(item => faladorRunes.some(rune => rune.id === item.id));
        }, 12_000);
        auditEvent('milestone', 'smelting-teleport-confirmed', { destination: 'Falador' });
    }

    async function smeltLoad(amount: number) {
        await walk(furnace, 2);
        const target = (await sdk.scanNearbyLocs(8)).find(loc => loc.id === furnace.id && loc.x === furnace.x && loc.z === furnace.z);
        if (!target) throw new Error('The Falador furnace was not visible.');
        let misses = 0;
        while (quantity(mithrilBar) < amount) {
            await bot.dismissBlockingUI();
            const ore = current().inventory.find(item => item.id === mithrilOre);
            const before = quantity(mithrilBar);
            const oreBefore = quantity(mithrilOre);
            const coalBefore = quantity(coal);
            if (!ore || coalBefore < coalPerBar) throw new Error('The backpack ran out of materials during a mithril batch.');
            reportTaskActivity('Smelting mithril bars at the Falador furnace');
            const sent = await sdk.sendUseItemOnLoc(ore.slot, target.x, target.z, target.id);
            if (sent.success) {
                try {
                    await sdk.waitForCondition(state => carried(state, mithrilBar) > before, 9_000);
                } catch (error) {
                    if (!(error instanceof Error) || error.message !== 'waitForCondition timed out') throw error;
                }
            }
            if (quantity(mithrilBar) === before + 1 && quantity(mithrilOre) === oreBefore - 1 && quantity(coal) === coalBefore - coalPerBar) {
                misses = 0;
                continue;
            }
            if (quantity(mithrilBar) !== before || quantity(coal) !== coalBefore || quantity(mithrilOre) !== oreBefore) {
                throw new Error('The furnace changed the backpack without a confirmed mithril bar.');
            }
            auditEvent('setback', 'mithril-smelt-unconfirmed', { attempt: ++misses, message: sent.message });
            if (misses >= 3) throw new Error('The Falador furnace made no mithril bar after three attempts.');
            reportTaskActivity('Retrying mithril smelting at the Falador furnace');
            await sdk.waitForTicks(2);
        }
    }

    const { player } = current();
    if (player.level !== 0) throw new Error('Start mithril smelting on the surface.');
    const banks = [catherbyBank, fishingGuildBank, ...Object.values(bankLocations)];
    const startingBank = inFalador() ? faladorBank : banks.reduce((nearest, candidate) =>
        distance(candidate) < distance(nearest) ? candidate : nearest);
    const needsTeleport = !inFalador();
    auditEvent('phase', 'smelting-bank-starting-items');
    await bankStartingItems(startingBank);
    if (needsTeleport) await teleport();
    await openBank(faladorBank);

    const startingBars = stored(mithrilBar);
    const availableBatches = () => Math.min(stored(mithrilOre), Math.floor(stored(coal) / coalPerBar));
    const goal = target ?? startingBars + availableBatches();
    auditEvent('check', 'mithril-materials-checked', { banked: startingBars, target: goal, ore: stored(mithrilOre), coal: stored(coal) });
    if (goal > startingBars && !availableBatches()) throw new Error('Falador East Bank has no complete mithril smelting ingredients.');
    if (goal > startingBars && (sdk.getSkill('Smithing')?.baseLevel ?? 0) < 50) {
        auditEvent('phase', 'smelting-train-smithing-with-iron');
        await trainSmithingWithIron(ctx, { openBank, closeBank, depositAll, withdraw, walk });
        await openBank(faladorBank);
        await depositAll();
    }
    if (goal > startingBars && (sdk.getSkill('Smithing')?.level ?? 0) < 50) throw new Error('Mithril bars require Smithing 50.');

    auditEvent('phase', 'smelting-mithril-in-falador');
    while (stored(mithrilBar) < goal) {
        const before = stored(mithrilBar);
        const amount = Math.min(barsPerLoad, goal - before, availableBatches());
        if (!amount) throw new Error(`Mithril ingredients exhausted with ${before} of ${goal} bars in Falador East Bank.`);
        reportTaskActivity('Withdrawing mithril ore and coal at Falador East Bank');
        await withdraw(mithrilOre, amount);
        await withdraw(coal, amount * coalPerBar);
        await closeBank();
        await checkpoint?.();
        await smeltLoad(amount);

        await openBank(faladorBank);
        reportTaskActivity('Depositing mithril bars at Falador East Bank');
        await depositAll();
        await sdk.waitForCondition(state => (state.bank.items.find(item => item.id === mithrilBar)?.count ?? 0) >= before + amount, 3_000);
        const banked = stored(mithrilBar);
        if (banked !== before + amount) throw new Error('The mithril bar deposit did not match the completed batch.');
        auditEvent('milestone', 'mithril-bars-banked', { amount, banked, target: goal });
    }
    const banked = stored(mithrilBar);
    await closeBank();
    auditEvent('milestone', 'mithril-smelting-complete', { banked, smelted: banked - startingBars });
    if (target !== undefined) reportBankStockTarget(banked, target);
}

if (import.meta.main) {
    reportTaskActivity('Connecting to the game to start mithril smelting');
    await runScript(withTaskUpdateCheckpoints(smeltMithrilFalador));
}

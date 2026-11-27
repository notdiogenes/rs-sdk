import { auditEnabled, auditEvent, auditFeedback, auditFrame } from '../../../sdk/audit-trace';
import type { ScriptContext } from '../../../sdk/runner';

export type QuestContext = Pick<ScriptContext, 'bot' | 'sdk'>;
export const questLog = (stage: string, data: object = {}) =>
    console.log('[pickpocket-demo] ' + JSON.stringify({ stage, ...data }));
export const questPhase = (name: string, data: object = {}) => auditEvent('phase', name, data);

export function readQuest({ sdk }: QuestContext, component: number) {
    return sdk.getState()?.questJournal?.[component];
}

export async function waitForQuestJournal(ctx: QuestContext, component: number, expected: 'available' | 'complete', timeout: number) {
    const { sdk } = ctx;
    const name = expected === 'available' ? 'quest-journal-available' : 'quest-journal-complete';
    try {
        await sdk.waitForCondition(s => expected === 'available' ? !!s.questJournal?.[component] : s.questJournal?.[component] === 'complete', timeout);
        auditEvent('check', name, { outcome: 'complete', component, expected, status: readQuest(ctx, component), after: auditFrame(sdk.getState()) });
    } catch (error) {
        auditEvent('check', name, { outcome: 'failed', component, expected, status: readQuest(ctx, component), timeout, after: auditFrame(sdk.getState()) });
        throw error;
    }
}

export async function walk({ bot, sdk }: QuestContext, x: number, z: number, tolerance = 4) {
    const before = auditFrame(sdk.getState());
    const began = performance.now();
    const result = await bot.walkTo(x, z, tolerance, { timeout: 150_000 });
    const p = sdk.getState()?.player;
    const arrived = result.success || (!!p && Math.max(Math.abs(x - p.worldX), Math.abs(z - p.worldZ)) <= tolerance);
    auditEvent('check', 'quest-travel', {
        outcome: arrived ? 'complete' : 'failed', elapsedMs: Math.round(performance.now() - began),
        destination: { x, z, tolerance }, before, after: auditFrame(sdk.getState()), message: result.message,
    });
    if (!arrived) throw new Error(`Could not walk to ${x}, ${z}: ${result.message}`);
}

export async function changeFloor(ctx: QuestContext, direction: 'up' | 'down', x: number, z: number, radius = 7,
    { requireReachable = false }: { requireReachable?: boolean } = {}) {
    const { bot, sdk } = ctx;
    const before = sdk.getState()?.player;
    if (!before) throw new Error('No location for floor change');
    const search = direction === 'up' ? /climb.up|go.up|walk.up/i : /climb.down|go.down|walk.down/i;
    const candidates = (await sdk.scanNearbyLocs(12)).flatMap(loc => {
        if (!/ladder|stair|trapdoor/i.test(loc.name) || Math.max(Math.abs(loc.x - x), Math.abs(loc.z - z)) > radius) return [];
        const option = loc.optionsWithIndex.find(entry => search.test(entry.text));
        return option ? [{ loc, option }] : [];
    }).sort((a, b) => a.loc.distance - b.loc.distance);
    auditEvent('check', 'floor-candidates', {
        direction, origin: auditFrame(sdk.getState()), anchor: { x, z, radius },
        candidates: candidates.slice(0, 8).map(({ loc, option }) => ({
            id: loc.id, name: loc.name, x: loc.x, z: loc.z, plane: loc.level,
            reachable: loc.reachable, option: option.text, index: option.opIndex,
        })),
    });
    const moved = (state: ReturnType<QuestContext['sdk']['getState']>) => {
        const player = state?.player;
        return !!player && (player.level !== before.level || Math.abs(player.worldZ - before.worldZ) > 1000);
    };
    for (const { loc, option } of candidates) {
        if (moved(sdk.getState())) return;
        if (requireReachable && loc.reachable !== true) continue;
        // Surface-to-dungeon ladders can change region while retaining plane zero.
        const began = performance.now();
        const tick = sdk.getState()?.tick ?? 0;
        const action = await bot.interactLoc(loc, option.opIndex);
        const changed = await sdk.waitForCondition(moved, 11_000).catch(() => null);
        const arrived = !!changed || moved(sdk.getState());
        auditEvent('check', 'floor-change', {
            outcome: arrived ? 'complete' : 'unconfirmed', direction, candidateId: loc.id,
            expected: 'plane or region change', elapsedMs: Math.round(performance.now() - began),
            sdk: { success: action.success, reason: action.reason, message: action.message },
            after: auditFrame(sdk.getState()), feedback: auditFeedback(sdk.getState(), tick),
        });
        if (arrived) return;
    }
    auditEvent('check', 'floor-change', { outcome: 'failed', direction, candidateCount: candidates.length,
        expected: 'plane or region change', anchor: { x, z, radius }, requireReachable, after: auditFrame(sdk.getState()) });
    throw new Error(`Could not climb ${direction} near ${x}, ${z} on plane ${before.level}`);
}

export async function talk(ctx: QuestContext, npc: RegExp, choices: RegExp[], maxPages = 24) {
    const { bot, sdk } = ctx;
    auditEvent('milestone', 'quest-dialogue', { npc: npc.source });
    const target = sdk.findNearbyNpc(npc);
    if (auditEnabled) auditEvent('check', 'quest-dialogue-target', {
        outcome: target ? 'complete' : 'failed', npc: npc.source,
        target: target && { id: target.id, index: target.index, x: target.x, z: target.z, reachable: target.reachable },
        before: auditFrame(sdk.getState()),
    });
    if (!target) throw new Error(`Could not find ${npc}`);
    const conversation = await bot.talkTo(target);
    if (!conversation.success && !sdk.getDialog()?.isOpen) throw new Error(conversation.message);
    await continueDialog(ctx, choices, maxPages);
}

export async function continueDialog({ sdk }: QuestContext, choices: RegExp[] = [], maxPages = 24) {
    for (let page = 0; page < maxPages; page++) {
        const dialog = sdk.getDialog();
        if (!dialog?.isOpen) {
            await sdk.waitForTicks(2);
            if (!sdk.getDialog()?.isOpen) return;
            continue;
        }
        if (dialog.options.length) {
            const match = [/^click here to continue$/i, ...choices]
                .find(choice => dialog.options.some(option => choice.test(option.text)));
            if (auditEnabled) auditEvent('check', 'quest-dialogue-choice', {
                outcome: match ? 'complete' : 'failed', page,
                expected: choices.map(choice => choice.source), offered: dialog.options.map(option => option.text), selected: match?.source,
            });
            if (!match) throw new Error('Unexpected quest choices: ' + dialog.options.map(option => option.text).join(' | '));
            const chosen = await sdk.clickDialogByText(match);
            if (!chosen.success) throw new Error(chosen.message);
        } else {
            await sdk.sendClickDialog(0);
        }
        await sdk.waitForTicks(2);
    }
    auditEvent('check', 'quest-dialogue-finished', { outcome: 'failed', pages: maxPages });
    throw new Error('Quest dialogue did not finish');
}

export async function groundItem(ctx: QuestContext, item: RegExp, x: number, z: number, count = 1) {
    const { bot, sdk } = ctx;
    if (sdk.countInventoryItems(item) >= count) return;
    await walk(ctx, x, z, 4);
    for (let attempt = 0; attempt < (count > 1 ? 25 : 9); attempt++) {
        const next = (await sdk.scanGroundItems(12))
            .filter(entry => item.test(entry.name) && Math.max(Math.abs(entry.x - x), Math.abs(entry.z - z)) <= 10)
            .sort((a, b) => Number(b.reachable) - Number(a.reachable) || a.distance - b.distance)[0];
        if (next) {
            const picked = await bot.pickupItem(next);
            auditEvent(picked.success ? 'milestone' : 'setback', picked.success ? 'quest-ground-item-picked' : 'quest-ground-item-failed', {
                item: next.name, id: next.id, x: next.x, z: next.z, attempt: attempt + 1, message: picked.message,
            });
            if (sdk.countInventoryItems(item) >= count) return;
        }
        await sdk.waitForTicks(5);
    }
    auditEvent('check', 'quest-ground-item-available', { outcome: 'failed', item: item.source, x, z, expected: count, held: sdk.countInventoryItems(item) });
    throw new Error(`Could not find ${item} near ${x}, ${z}`);
}

type QuestStepSupplies = {
    slots?: number;
    keep?: RegExp;
    withdraw?: readonly { name: string; count: number; id?: number }[];
    bank?: readonly [number, number];
    beforeBank?: () => Promise<void>;
};

export async function prepareQuestStep(ctx: QuestContext, {
    slots = 0, keep, withdraw = [], bank = [3092, 3243], beforeBank,
}: QuestStepSupplies) {
    const { bot, sdk } = ctx;
    const matches = (supply: (typeof withdraw)[number], item: { id: number; name: string }) =>
        supply.id === undefined ? itemNamed(supply.name).test(item.name) : item.id === supply.id;
    const have = (supply: (typeof withdraw)[number]) => sdk.getInventory()
        .filter(item => matches(supply, item)).reduce((sum, item) => sum + item.count, 0);
    const freeSlots = () => 28 - sdk.getInventory().length;
    const missing = withdraw.filter(item => have(item) < item.count);
    const requiredSlots = Math.max(slots, missing.filter(item => have(item) === 0).length);
    if (freeSlots() >= requiredSlots && !missing.length) {
        auditEvent('check', 'quest-bank-loadout', { outcome: 'skipped', requiredSlots, freeSlots: freeSlots() });
        return;
    }

    auditEvent('check', 'quest-bank-loadout', { outcome: 'needed', bank, requiredSlots, missing });
    questLog('banking-quest-loadout');
    await beforeBank?.();
    await walk(ctx, bank[0], bank[1], 4);
    const opened = await bot.openBank();
    if (!opened.success) throw new Error(opened.message);
    try {
        while (freeSlots() < requiredSlots) {
            const item = sdk.getInventory().findLast(entry => !keep?.test(entry.name) &&
                !withdraw.some(supply => matches(supply, entry)));
            if (!item) throw new Error(`Need ${requiredSlots} free inventory slots for this quest step; the carried quest items fill the backpack`);
            const before = freeSlots();
            const deposited = await bot.depositItem(item, item.count);
            if (!deposited.success || freeSlots() <= before) throw new Error(`Could not free a slot by banking ${item.name}`);
        }
        for (const item of missing) {
            const entry = sdk.getBankItems().find(bankItem => matches(item, bankItem));
            const amount = Math.min(entry?.count ?? 0, item.count - have(item));
            if (entry && amount > 0) {
                const taken = await bot.withdrawItem(entry, amount);
                if (!taken.success) throw new Error(`Could not withdraw ${item.name}: ${taken.message}`);
            }
        }
    } finally {
        if (sdk.isBankOpen()) await bot.closeBank();
    }
    auditEvent('check', 'quest-bank-loadout', {
        outcome: 'complete', requiredSlots, freeSlots: freeSlots(),
        supplies: missing.map(item => ({ ...item, carried: have(item) })),
    });
    questLog('quest-loadout-ready', { items: sdk.getInventory().map(item => [item.name, item.count]) });
}

export async function journalText({ bot, sdk }: QuestContext, component: number, title: RegExp) {
    const strip = (s: string) => s.replace(/@[a-z0-9]{3}@/gi, '').replace(/\s+/g, ' ').trim();
    await bot.closeInterface();
    try {
        const result = await sdk.sendClickComponent(component);
        if (!result.success) throw new Error(result.message);
        const state = await sdk.waitForCondition(s => !!s.openQuestJournal && title.test(strip(s.openQuestJournal.title)), 7000);
        const text = strip(state.openQuestJournal?.text ?? '');
        auditEvent('check', 'quest-journal-read', { outcome: 'complete', component, title: state.openQuestJournal?.title,
            status: state.questJournal?.[component], tail: text.slice(-400) });
        return text;
    } catch (error) {
        auditEvent('check', 'quest-journal-read', { outcome: 'failed', component, expectedTitle: title.source, after: auditFrame(sdk.getState()) });
        throw error;
    } finally {
        await bot.closeInterface();
    }
}

export const itemNamed = (name: string) => new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');

export async function talkAt(ctx: QuestContext, x: number, z: number, name: RegExp, choices: RegExp[] = [], targetTimeoutMs?: number) {
    await walk(ctx, x, z);
    if (targetTimeoutMs !== undefined) {
        const { sdk } = ctx;
        try {
            await sdk.waitForCondition(state => state.nearbyNpcs.some(npc => name.test(npc.name)), targetTimeoutMs);
        } catch (error) {
            if (!(error instanceof Error) || error.message !== 'waitForCondition timed out') throw error;
            if (auditEnabled) {
                const state = sdk.getState();
                auditEvent('check', 'quest-dialogue-target', {
                    outcome: 'failed', npc: name.source, target: null, timeoutMs: targetTimeoutMs,
                    before: auditFrame(state),
                    nearbyNpcNames: state?.nearbyNpcs.map(npc => npc.name) ?? [],
                });
            }
            throw new Error(`Could not find ${name}`);
        }
    }
    await talk(ctx, name, choices);
}

export async function buyQuestSupply({ bot, sdk }: QuestContext, shopkeeper: RegExp, name: string, maximum: number) {
    const opened = await bot.openShop(shopkeeper);
    if (!opened.success) throw new Error(opened.message);
    try {
        const item = sdk.getState()?.shop.shopItems.find(i => i.name === name && i.count > 0);
        if (!item || !Number.isFinite(item.buyPrice) || item.buyPrice > maximum) {
            throw new Error(`${name} is unavailable from the NPC shop for ${maximum} coins or less`);
        }
        const bought = await bot.buyFromShop(item, 1);
        if (!bought.success) throw new Error(bought.message);
    } finally {
        await bot.closeShop();
    }
}

export async function equipQuestSword({ bot, sdk }: QuestContext) {
    const sword = sdk.findInventoryItem(/^adamant longsword$/i);
    if (sword) {
        const equipped = await bot.equipItem(sword);
        if (!equipped.success) throw new Error(equipped.message);
    }
}

export async function useTogether({ sdk }: QuestContext, first: RegExp, second: RegExp) {
    const source = sdk.findInventoryItem(first);
    const target = sdk.findInventoryItem(second);
    if (!source || !target) throw new Error(`Missing ${first} or ${second}`);
    const result = await sdk.sendUseItemOnItem(source.slot, target.slot);
    if (!result.success) throw new Error(result.message);
}

export async function lootFromNpc(ctx: QuestContext, item: RegExp, npc: RegExp, x: number, z: number, count = 1) {
    const { bot, sdk } = ctx;
    const held = () => sdk.countInventoryItems(item);
    if (held() >= count) return;
    await walk(ctx, x, z);
    for (let attempt = 0; attempt < 35 && held() < count; attempt++) {
        const drop = (await sdk.scanGroundItems(10)).find(i => item.test(i.name) && i.reachable !== false);
        if (drop) {
            await bot.pickupItem(drop);
            continue;
        }
        const target = sdk.getNearbyNpcs().filter(i => npc.test(i.name) && i.reachable !== false &&
            !i.inCombat && i.optionsWithIndex.some(o => /^attack$/i.test(o.text))).sort((a, b) => a.distance - b.distance)[0];
        if (target && !sdk.getState()?.player?.combat.inCombat) {
            await bot.attack(target);
            await sdk.waitForCondition(state => !!state.player && !state.player.combat.inCombat, 40_000).catch(() => null);
        }
        await sdk.waitForTicks(3);
    }
    if (held() < count) throw new Error(`Could not obtain ${count} × ${item} near ${x}, ${z}`);
}

export async function questLoc({ sdk }: QuestContext, name: RegExp, option?: RegExp) {
    const loc = (await sdk.scanNearbyLocs(10)).filter(l => name.test(l.name)
        && (!option || l.optionsWithIndex.some(o => option.test(o.text)))).sort((a, b) => a.distance - b.distance)[0];
    if (!loc) throw new Error(`Could not find ${name}${option ? ' with ' + option : ''}`);
    return loc;
}

import type { ScriptContext } from '../../../sdk/runner';

export type QuestContext = Pick<ScriptContext, 'bot' | 'sdk'>;
export const questLog = (stage: string, data: object = {}) =>
    console.log('[pickpocket-demo] ' + JSON.stringify({ stage, ...data }));

export function readQuest({ sdk }: QuestContext, component: number) {
    return sdk.getState()?.questJournal?.[component];
}

export async function walk({ bot, sdk }: QuestContext, x: number, z: number, tolerance = 4) {
    const result = await bot.walkTo(x, z, tolerance, { timeout: 150_000 });
    const p = sdk.getState()?.player;
    if (!result.success && (!p || Math.max(Math.abs(x - p.worldX), Math.abs(z - p.worldZ)) > tolerance)) {
        throw new Error(`Could not walk to ${x}, ${z}: ${result.message}`);
    }
}

export async function changeFloor(ctx: QuestContext, direction: 'up' | 'down', x: number, z: number, radius = 7) {
    const { bot, sdk } = ctx;
    const before = sdk.getState()?.player;
    if (!before) throw new Error('No location for floor change');
    const search = direction === 'up' ? /climb.up|go.up|walk.up/i : /climb.down|go.down|walk.down/i;
    const candidates = (await sdk.scanNearbyLocs(12)).flatMap(loc => {
        if (!/ladder|stair|trapdoor/i.test(loc.name) || Math.max(Math.abs(loc.x - x), Math.abs(loc.z - z)) > radius) return [];
        const option = loc.optionsWithIndex.find(entry => search.test(entry.text));
        return option ? [{ loc, option }] : [];
    }).sort((a, b) => a.loc.distance - b.loc.distance);
    for (const { loc, option } of candidates) {
        // Surface-to-dungeon ladders can change region while retaining plane zero.
        await bot.interactLoc(loc, option.opIndex);
        const changed = await sdk.waitForCondition(state => {
            const p = state.player;
            return !!p && (p.level !== before.level || Math.abs(p.worldZ - before.worldZ) > 1000);
        }, 4500).catch(() => null);
        if (changed) return;
    }
    throw new Error(`Could not climb ${direction} near ${x}, ${z} on plane ${before.level}`);
}

export async function talk(ctx: QuestContext, npc: RegExp, choices: RegExp[]) {
    const { bot, sdk } = ctx;
    const target = sdk.findNearbyNpc(npc);
    if (!target) throw new Error(`Could not find ${npc}`);
    const conversation = await bot.talkTo(target);
    if (!conversation.success && !sdk.getDialog()?.isOpen) throw new Error(conversation.message);
    await continueDialog(ctx, choices);
}

export async function continueDialog({ sdk }: QuestContext, choices: RegExp[] = []) {
    for (let page = 0; page < 24; page++) {
        const dialog = sdk.getDialog();
        if (!dialog?.isOpen) {
            await sdk.waitForTicks(2);
            if (!sdk.getDialog()?.isOpen) return;
            continue;
        }
        if (dialog.options.length) {
            const match = [/^click here to continue$/i, ...choices]
                .find(choice => dialog.options.some(option => choice.test(option.text)));
            if (!match) throw new Error('Unexpected quest choices: ' + dialog.options.map(option => option.text).join(' | '));
            const chosen = await sdk.clickDialogByText(match);
            if (!chosen.success) throw new Error(chosen.message);
        } else {
            await sdk.sendClickDialog(0);
        }
        await sdk.waitForTicks(2);
    }
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
            await bot.pickupItem(next);
            if (sdk.countInventoryItems(item) >= count) return;
        }
        await sdk.waitForTicks(5);
    }
    throw new Error(`Could not find ${item} near ${x}, ${z}`);
}

export async function bankForQuest(ctx: QuestContext, supplies: readonly { name: string; count: number }[],
    bank: readonly [number, number] = [3092, 3243]) {
    const { bot, sdk } = ctx;
    const wanted = new Map(supplies.map(item => [item.name.toLowerCase(), item.count]));
    const current = () => sdk.getInventory();
    const exact = (name: string) => new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
    const have = (name: string) => sdk.countInventoryItems(exact(name));
    const open = async () => {
        const result = await bot.openBank();
        if (!result.success) throw new Error(result.message);
    };
    const deposit = async () => {
        for (const name of new Set(current().map(item => item.name))) {
            const count = have(name) - (wanted.get(name.toLowerCase()) ?? 0);
            if (count > 0 && !(await bot.depositItem(exact(name), count)).success) throw new Error(`Could not bank ${name}`);
        }
    };
    questLog('banking-quest-loadout');
    await walk(ctx, bank[0], bank[1], 4);
    await open();
    try {
        await deposit();
        if (sdk.getEquipment().length) {
            await bot.closeBank();
            for (const item of sdk.getEquipment()) {
                if ((wanted.get(item.name.toLowerCase()) ?? 0) > 0) continue;
                const result = await bot.unequipItem(item);
                if (!result.success) throw new Error(result.message);
            }
            await open();
            await deposit();
        }
        for (const supply of supplies) {
            const entry = sdk.findBankItem(exact(supply.name));
            const needed = supply.count - have(supply.name);
            if (entry && needed > 0) {
                const amount = Math.min(entry.count, needed);
                const taken = await bot.withdrawItem(entry, amount);
                if (!taken.success) throw new Error(`Could not withdraw ${supply.name}`);
            }
        }
    } finally {
        if (sdk.isBankOpen()) await bot.closeBank();
    }
    const surplus = current().find(item => have(item.name) > (wanted.get(item.name.toLowerCase()) ?? 0));
    if (surplus || sdk.getEquipment().some(item => !wanted.has(item.name.toLowerCase()))) {
        throw new Error('Unexpected items remained after banking');
    }
    questLog('quest-loadout-ready', { items: current().map(item => [item.name, item.count]) });
}

export async function journalText({ bot, sdk }: QuestContext, component: number, title: RegExp) {
    const strip = (s: string) => s.replace(/@[a-z0-9]{3}@/gi, '').replace(/\s+/g, ' ').trim();
    await bot.closeInterface();
    try {
        const result = await sdk.sendClickComponent(component);
        if (!result.success) throw new Error(result.message);
        const state = await sdk.waitForCondition(s => !!s.openQuestJournal && title.test(strip(s.openQuestJournal.title)), 7000);
        return strip(state.openQuestJournal?.text ?? '');
    } finally {
        await bot.closeInterface();
    }
}

export const itemNamed = (name: string) => new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');

export async function talkAt(ctx: QuestContext, x: number, z: number, name: RegExp, choices: RegExp[] = []) {
    await walk(ctx, x, z);
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

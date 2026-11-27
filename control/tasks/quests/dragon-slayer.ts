import { auditEvent, auditOperation } from '../../../sdk/audit-trace';
import { runScript } from '../../../sdk/runner';
import { Spells } from '../../../sdk/spells';
import { makeShipNails } from './dragon-slayer-smithing';
import {
    availableQuestTarget, canMeleeQuest, fightQuestNpc, planQuestFight, questFood, questFoodSupplies, questSkill, questSpellSupplies, withQuestProtection,
} from './quest-combat';
import {
    buyQuestSupply, changeFloor, continueDialog, groundItem, journalText, prepareQuestStep, questLog, questPhase,
    readQuest, talk, talkAt, useTogether, waitForQuestJournal, walk, type QuestContext,
} from './shared';

const quest = 'Dragon Slayer';
const journal = 7383;
const title = /^dragon slayer$/i;
const elvarg = { name: 'Elvarg', hitpoints: 120, incomingHit: 10, meleeLevel: 50, minimumFood: 5 };
const elvargGate = { x: 2847, z: 9636 };
const finishedSailing = /all I need to do is kill the dragon/i;
const shipRepaired = /I have repaired my ship/i;
const shipBought = /I bought a ship in Port Sarim/i;
const nedHired = /Ned from Draynor Village has agreed/i;
const coins = /^coins$/i;
const magicDoorSupplies = ['Wizard\'s mind bomb', 'Silk', 'Lobster pot', 'Unfired bowl'];
const meleeRequirements: Record<string, number> = {
    dragon: 60, rune: 40, adamant: 30, mithril: 20, black: 10, steel: 5, iron: 1, bronze: 1,
};
const styles = ['dagger', 'sword', 'mace', 'axe', 'longsword', 'scimitar', 'battleaxe'];
const bankLocation = [3092, 3243] as const;
const mapPieces = [
    { name: 'Melzar’s Maze map piece', id: 1535, count: 1 },
    { name: 'Wormbrain’s map piece', id: 1536, count: 1 },
    { name: 'Oracle’s map piece', id: 1537, count: 1 },
] as const;

const position = ({ sdk }: QuestContext) => {
    const player = sdk.getState()?.player;
    if (!player) throw new Error('No live player position for Dragon Slayer');
    return player;
};

const inventory = ({ sdk }: QuestContext, id: number) => sdk.getInventory().find(item => item.id === id);
const held = ({ sdk }: QuestContext, id: number) => sdk.getInventory().filter(item => item.id === id)
    .reduce((sum, item) => sum + item.count, 0);
const has = (ctx: QuestContext, id: number) => held(ctx, id) > 0;
const area = (ctx: QuestContext, x: number, z: number, range: number) => {
    const p = position(ctx);
    return Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= range;
};

async function activate(ctx: QuestContext, ids: readonly number[], x: number, z: number, intent: string,
    { item, approach = 2, walkFirst = true }: { item?: number; approach?: number; walkFirst?: boolean } = {}) {
    const { sdk } = ctx;
    if (walkFirst) await walk(ctx, x, z, approach);
    const loc = (await sdk.scanNearbyLocs(10)).find(entry => ids.includes(entry.id) && entry.x === x && entry.z === z);
    if (!loc) throw new Error(`${intent}: location ${ids.join('/')} at ${x}, ${z} was not in the scene`);
    const tool = item === undefined ? undefined : inventory(ctx, item);
    if (item !== undefined && !tool) throw new Error(`${intent}: required item ${item} is missing`);
    await auditOperation('dragon-slayer-interact', intent, { id: loc.id, name: loc.name, x, z, tool: tool?.name }, () => sdk.getState(),
        async () => {
            const sent = tool ? await sdk.sendUseItemOnLoc(tool.slot, loc.x, loc.z, loc.id)
                : await sdk.sendInteractLoc(loc.x, loc.z, loc.id, 1);
            if (!sent.success) throw new Error(sent.message);
            await sdk.waitForTicks(3);
            return sent;
        }, sent => ({ outcome: 'dispatched', message: sent.message }));
}

async function takeMapFromChest(ctx: QuestContext, x: number, z: number, ids: readonly number[], piece: number) {
    const { sdk } = ctx;
    if (has(ctx, piece)) return;
    await walk(ctx, x, z - 1, 0);
    for (let attempt = 1; attempt <= 6 && !has(ctx, piece); attempt++) {
        const chest = (await sdk.scanNearbyLocs(8)).find(loc => loc.x === x && loc.z === z && ids.includes(loc.id));
        auditEvent('check', 'dragon-slayer-map-chest', {
            outcome: chest ? 'present' : 'unconfirmed', attempt, x, z, location: chest?.id, reachable: chest?.reachable, piece,
        });
        if (chest) {
            await activate(ctx, [chest.id], x, z, 'Open or search the current map chest', { walkFirst: false });
            if (sdk.getDialog()?.isOpen) await continueDialog(ctx);
        }
        if (!has(ctx, piece)) await sdk.waitForTicks(3);
    }
    if (!has(ctx, piece)) throw new Error(`The map chest at ${x}, ${z} did not yield item ${piece}`);
    await continueDialog(ctx);
}

async function exitZanaris(ctx: QuestContext) {
    const p = position(ctx);
    if (p.worldX < 3140 || p.worldX > 3270 || p.worldZ < 9536 || p.worldZ >= 9600) return;
    const { sdk, bot } = ctx;
    questPhase('dragon-slayer-leave-zanaris');
    await bot.closeInterface();
    sdk.blockDoorTemporarily(0, 3238, 9558, 600_000);
    sdk.blockDoorTemporarily(0, 3233, 9554, 600_000);
    const bank = [3152, 9578] as const;
    const magic = questSkill(ctx, 'Magic');
    const air = /^air rune$/i;
    const fire = /^fire rune$/i;
    const earth = /^earth rune$/i;
    const law = /^law rune$/i;
    const jewellery = /^(?:ring of dueling|amulet of glory)\([1-8]\)$/i;
    const spell = () => sdk.countInventoryItems(law) >= 1 && sdk.countInventoryItems(air) >= 3
        ? magic >= 25 && sdk.countInventoryItems(fire) >= 1 ? Spells.VARROCK_TELEPORT
            : magic >= 31 && sdk.countInventoryItems(earth) >= 1 ? Spells.LUMBRIDGE_TELEPORT
            : undefined
        : undefined;
    if (!spell() && !sdk.findInventoryItem(jewellery)) {
        await prepareQuestStep(ctx, { bank, slots: 6, withdraw: [
            { name: 'Law rune', count: 2 }, { name: 'Air rune', count: 3 }, { name: 'Fire rune', count: 1 },
            { name: 'Earth rune', count: 1 },
        ] });
    }
    if (!spell() && !sdk.findInventoryItem(jewellery)) {
        await walk(ctx, bank[0], bank[1], 3);
        const opened = await bot.openBank();
        if (!opened.success) throw new Error(opened.message);
        try {
            const entry = sdk.findBankItem(jewellery);
            if (entry) {
                const taken = await bot.withdrawItem(entry, 1);
                if (!taken.success) throw new Error(taken.message);
            }
        } finally {
            await bot.closeBank();
        }
    }
    if (!spell() && !sdk.findInventoryItem(jewellery) && magic >= 25 && sdk.countInventoryItems(air) >= 3 &&
        (sdk.countInventoryItems(fire) >= 1 || magic >= 31 && sdk.countInventoryItems(earth) >= 1)) {
        const being = { name: 'Otherworldly being', hitpoints: 66, incomingHit: 5, meleeLevel: 45, minimumFood: 1 };
        await prepareQuestStep(ctx, { bank, slots: 5, withdraw: [
            ...questFoodSupplies,
            ...canMeleeQuest(ctx, being) ? [{ name: 'Adamant longsword', count: 1 }] : questSpellSupplies(ctx, being.hitpoints),
        ] });
        const sword = sdk.findInventoryItem(/^adamant longsword$/i);
        if (sword && canMeleeQuest(ctx, being)) {
            const wield = await bot.equipItem(sword);
            if (!wield.success) throw new Error(wield.message);
        }
        questPhase('dragon-slayer-collect-teleport-rune');
        await walk(ctx, 3156, 9545, 4);
        for (let attempt = 0; attempt < 28 && !spell(); attempt++) {
            if (await pickUp(ctx, 563, 10)) break;
            const state = await sdk.waitForCondition(s => s.nearbyNpcs.some(n => n.id === 126 && n.hp !== 0 && n.reachable !== false), 25000);
            const target = state.nearbyNpcs.find(n => n.id === 126 && n.hp !== 0 && n.reachable !== false);
            if (!target) continue;
            const plan = planQuestFight(ctx, being);
            await withQuestProtection(ctx, ['protect_from_melee'], () => fightQuestNpc(ctx, target, being, plan, {
                retreat: () => walk(ctx, 3156, 9557, 2),
            }));
            await sdk.waitForTicks(3);
            await pickUp(ctx, 563, 10);
        }
    }
    const component = spell();
    const item = sdk.findInventoryItem(jewellery);
    await auditOperation('dragon-slayer-teleport-from-zanaris', 'Leave Zanaris without entering the gated marketplace',
        { component, item: item?.name }, () => sdk.getState(), async () => {
            if (component) {
                const cast = await sdk.sendClickComponent(component);
                if (!cast.success) throw new Error(cast.message);
            } else if (item) {
                const rub = item.optionsWithIndex.find(option => /^rub$/i.test(option.text));
                if (!rub) throw new Error(`${item.name} does not offer a Rub action`);
                await sdk.sendUseItem(item.slot, rub.opIndex);
                await sdk.waitForCondition(state => state.dialog.isOpen, 6000);
                await continueDialog(ctx, [/edgeville|duel arena/i]);
            } else {
                throw new Error('Leaving Zanaris without paying the marketplace tax requires teleport runes or charged jewellery');
            }
            await sdk.waitForCondition(state => (state.player?.worldZ ?? 9600) < 4000, 10000);
        }, () => ({ outcome: 'complete' }));
}

async function getReplacementMazeKey(ctx: QuestContext) {
    if (has(ctx, 1542)) return;
    questPhase('dragon-slayer-recover-maze-key');
    await walk(ctx, 3068, 3517, 0);
    await talk(ctx, /^oziach$/i, [
        /try and get everything together/i, /first piece/i, /where can I find this dragon/i,
    ], 48);
    if (!has(ctx, 1542)) throw new Error('Oziach did not issue a Maze key. Check the bank for an existing copy.');
}

async function getBriefing(ctx: QuestContext) {
    const { sdk } = ctx;
    questPhase('dragon-slayer-briefing');
    let page = await journalText(ctx, journal, title);
    if (readQuest(ctx, journal) === 'not-started') {
        if ((sdk.getState()?.questPoints ?? 0) < 32) throw new Error('The Champions’ Guild requires 32 quest points');
        await talkAt(ctx, 3191, 3362, /^guild master$/i, [/where I could get a rune plate mail/i], 8000);
        await sdk.waitForCondition(s => s.questJournal?.[journal] === 'in-progress', 8000);
        page = await journalText(ctx, journal, title);
    }
    if (!/should speak to Oziach|should return to Oziach/i.test(page)) return;
    await prepareQuestStep(ctx, { bank: [3094, 3491], slots: 2,
        withdraw: /should return to Oziach/i.test(page) ? [{ name: 'Maze key', count: 1 }] : [],
    });
    const introductions = [/can you sell me some rune plate mail/i, /guildmaster of the champions/i,
        /how am I meant to prove/i, /a dragon.*sounds like fun/i];
    const farewell = /try and get everything together/i;
    const findDragon = /where can I find this dragon/i;
    await walk(ctx, 3068, 3517, 0);
    for (const topic of [/first piece/i, /second piece/i, /third piece/i, /where can I get an antidragon shield/i]) {
        await talk(ctx, /^oziach$/i, [...introductions, farewell, topic, findDragon], 48);
    }
    if (/should return to Oziach|should speak to Oziach/i.test(await journalText(ctx, journal, title))) {
        throw new Error('Dragon Slayer journal did not confirm Oziach’s briefing');
    }
}

function shieldEquipped(ctx: QuestContext) {
    return ctx.sdk.getEquipment().some(item => item.id === 1540);
}

async function getShield(ctx: QuestContext) {
    const { sdk } = ctx;
    const hasShield = () => shieldEquipped(ctx) || has(ctx, 1540);
    const aboveCastle = () => area(ctx, 3212, 3218, 16) && position(ctx).level > 0;
    if (hasShield() && !aboveCastle()) return;
    questPhase('dragon-slayer-get-shield');
    if (!hasShield() && !aboveCastle()) {
        await prepareQuestStep(ctx, { slots: 3, withdraw: [{ name: 'Dragonfire shield', count: 1 }] });
        if (hasShield()) return;
    }
    if (aboveCastle() && position(ctx).level === 2) {
        await walk(ctx, 3205, 3227, 1);
        await changeFloor(ctx, 'down', 3205, 3229, 0);
    }
    if (position(ctx).level === 0) {
        await walk(ctx, 3205, 3228, 0);
        await changeFloor(ctx, 'up', 3204, 3229, 0, { requireReachable: true });
    }
    if (!hasShield()) {
        await walk(ctx, 3211, 3219, 0);
        await talk(ctx, /^duke horacio$/i, [/shield that will protect me/i]);
        await sdk.waitForCondition(hasShield, 6000);
    }
    await walk(ctx, 3205, 3228, 0);
    await changeFloor(ctx, 'down', 3204, 3229, 0, { requireReachable: true });
}

function meleeWeaponScore(ctx: QuestContext, name: string) {
    const match = /^(dragon|rune|adamant|mithril|black|steel|iron|bronze) (dagger|sword|mace|axe|longsword|scimitar|battleaxe)(?:\(p[+]*\))?$/i.exec(name);
    if (!match) return -1;
    const level = meleeRequirements[match[1]!.toLowerCase()]!;
    if (questSkill(ctx, 'Attack') < level) return -1;
    return level * 10 + styles.indexOf(match[2]!.toLowerCase());
}

const hasMeleeWeapon = (ctx: QuestContext) => ctx.sdk.getEquipment().some(item => meleeWeaponScore(ctx, item.name) >= 0);

async function prepareCombat(ctx: QuestContext, hitpoints: number) {
    const { sdk, bot } = ctx;
    const wantMelee = canMeleeQuest(ctx, elvarg);
    const best = <T extends { name: string }>(items: T[]) => items
        .filter(item => meleeWeaponScore(ctx, item.name) >= 0)
        .sort((a, b) => meleeWeaponScore(ctx, b.name) - meleeWeaponScore(ctx, a.name))[0];
    if (wantMelee && !hasMeleeWeapon(ctx)) {
        await prepareQuestStep(ctx, { bank: bankLocation, slots: 3, keep: /map part|crandor map|maze key|dragonfire shield/i });
        let weapon = best(sdk.getInventory());
        if (!weapon) {
            await walk(ctx, bankLocation[0], bankLocation[1], 4);
            const opened = await bot.openBank();
            if (!opened.success) throw new Error(opened.message);
            try {
                const option = best(sdk.getBankItems());
                if (option) {
                    const taken = await bot.withdrawItem(option, 1);
                    if (!taken.success) throw new Error(taken.message);
                    weapon = best(sdk.getInventory());
                }
            } finally {
                await bot.closeBank();
            }
        }
        if (weapon) {
            const equipped = await bot.equipItem(weapon);
            if (!equipped.success) throw new Error(equipped.message);
        }
    }
    const useMelee = wantMelee && hasMeleeWeapon(ctx);
    await prepareQuestStep(ctx, { slots: 10, withdraw: useMelee ? [] : questSpellSupplies(ctx, hitpoints),
        keep: /map part|crandor map|maze key|dragonfire shield/i });
    const targetFood = questSkill(ctx, 'Defence') >= 60 ? 9 : 14;
    if (sdk.countInventoryItems(questFood) >= targetFood) return;
    await walk(ctx, bankLocation[0], bankLocation[1], 4);
    const opened = await bot.openBank();
    if (!opened.success) throw new Error(opened.message);
    try {
        for (const { name } of questFoodSupplies) {
            const remaining = Math.min(targetFood - sdk.countInventoryItems(questFood), 25 - sdk.getInventory().length);
            if (remaining <= 0) break;
            const item = sdk.findBankItem(new RegExp(`^${name}$`, 'i'));
            if (!item) continue;
            const taken = await bot.withdrawItem(item, Math.min(remaining, item.count));
            if (!taken.success) throw new Error(taken.message);
        }
    } finally {
        await bot.closeBank();
    }
    auditEvent('check', 'dragon-slayer-combat-supplies', {
        mode: useMelee ? 'melee' : 'magic', food: sdk.countInventoryItems(questFood), targetFood,
        weapon: best(sdk.getEquipment())?.name,
    });
}

async function pickUp(ctx: QuestContext, id: number, radius: number) {
    const drop = (await ctx.sdk.scanGroundItems(radius)).find(item => item.id === id && item.reachable !== false);
    if (!drop) return false;
    const before = held(ctx, id);
    const taken = await ctx.bot.pickupItem(drop);
    return taken.success && held(ctx, id) > before;
}

const mazeRooms = [
    { name: 'Giant rat', hp: 10, hit: 3, npc: 748, key: 1543, door: 2596, x: 2926, z: 3253, dx: -1, dz: 0, nx: 2930, nz: 3252, lx: 2928, lz: 3256 },
    { name: 'Ghost', hp: 25, hit: 4, npc: 749, key: 1544, door: 2597, x: 2931, z: 3253, dx: 1, dz: 0, nx: 2929, nz: 3249, lx: 2934, lz: 3254 },
    { name: 'Skeleton', hp: 29, hit: 4, npc: 750, key: 1545, door: 2598, x: 2924, z: 3249, dx: 0, dz: -1, nx: 2923, nz: 3251, lx: 2940, lz: 3240 },
    { name: 'Zombie', hp: 30, hit: 5, npc: 751, key: 1546, door: 2599, x: 2931, z: 9643, dx: -1, dz: 0, nx: 2932, nz: 9642 },
    { name: 'Melzar the Mad', hp: 44, hit: 8, npc: 753, key: 1547, door: 2600, x: 2929, z: 9652, dx: 0, dz: 1, nx: 2929, nz: 9649 },
    { name: 'Lesser demon', hp: 79, hit: 8, npc: 752, key: 1548, door: 2601, x: 2936, z: 9655, dx: 0, dz: 1, nx: 2936, nz: 9650 },
] as const;

async function escapeMazeFight(ctx: QuestContext, fallback: readonly [number, number]) {
    const { sdk, bot } = ctx;
    const p = () => sdk.getState()?.player;
    if (!p() || p()?.isDead || !p()?.combat.inCombat) return;
    const magic = questSkill(ctx, 'Magic');
    const teleport = held(ctx, 556) >= 3 && has(ctx, 563) &&
        (magic >= 25 && has(ctx, 554) ? Spells.VARROCK_TELEPORT :
            magic >= 31 && has(ctx, 557) ? Spells.LUMBRIDGE_TELEPORT : undefined);
    await auditOperation('dragon-slayer-maze-emergency-exit', 'Move out of incoming combat before returning control',
        { teleport, fallback }, () => sdk.getState(), async () => {
            if (teleport) {
                const dispatched = await sdk.sendClickComponent(teleport);
                const left = dispatched.success && await sdk.waitForCondition(state =>
                    (state.player?.worldZ ?? 9600) < 4000 && (state.player?.worldX ?? 2930) > 3000, 4500).catch(() => null);
                if (left) return 'teleported';
            }
            const food = sdk.findInventoryItem(questFood);
            if (food && (p()?.hp ?? 0) < 25) await bot.eatFood(food);
            await sdk.sendWalk(fallback[0], fallback[1]);
            await sdk.waitForCondition(state => !!state.player && !state.player.isDead && !state.player.combat.inCombat &&
                Math.max(Math.abs(state.player.worldX - fallback[0]), Math.abs(state.player.worldZ - fallback[1])) <= 2, 9000);
            return 'retreated';
        }, method => ({ outcome: 'complete', method }));
}

async function mazeRoom(ctx: QuestContext, room: typeof mazeRooms[number], crossed: () => boolean) {
    const { sdk } = ctx;
    if (crossed()) return;
    questPhase('dragon-slayer-maze-room', { target: room.name, door: { x: room.x, z: room.z } });
    const fallback: readonly [number, number] = room.npc === 752 ? [2929, 9653]
        : room.npc === 753 ? [2928, 9645] : room.npc === 751 ? [2932, 9640]
            : room.npc === 750 ? [2933, 3255] : room.npc === 749 ? [2927, 3256] : [2940, 3248];
    try {
        if (!has(ctx, room.key)) {
            await walk(ctx, room.nx, room.nz, 2);
            const fight = { name: room.name, hitpoints: room.hp, incomingHit: room.hit, meleeLevel: Math.min(40, room.hp), minimumFood: 0 };
            const plan = planQuestFight(ctx, fight, { magicOnly: !hasMeleeWeapon(ctx) });
            for (let attempt = 0; attempt < 5 && !has(ctx, room.key); attempt++) {
                if (await pickUp(ctx, room.key, 8)) break;
                const seen = await sdk.waitForCondition(s => !!availableQuestTarget(s, room.npc) ||
                    !!s.player && s.player.combat.inCombat && s.player.hp < Math.max(25, room.hit * 3), 8000).catch(() => null);
                const target = seen && availableQuestTarget(seen, room.npc);
                if (!target) throw new Error(`${room.name} was not available to fight in this maze room`);
                await withQuestProtection(ctx, ['protect_from_melee'], () => fightQuestNpc(ctx, target, fight, plan, {
                    retreat: () => escapeMazeFight(ctx, fallback),
                }));
                await sdk.waitForTicks(3);
                await pickUp(ctx, room.key, 8);
            }
        }
        if (!has(ctx, room.key)) throw new Error(`No ${room.name} key was recovered`);
        await activate(ctx, [room.door], room.x, room.z, 'Unlock the door for the next maze room', { item: room.key });
        if (!crossed()) await walk(ctx, room.x + room.dx, room.z + room.dz, 0);
        if (!crossed()) throw new Error(`The ${room.name} door did not lead into the expected room`);
        auditEvent('milestone', 'dragon-slayer-maze-door-passed', { door: room.door, target: room.name });
    } catch (error) {
        await escapeMazeFight(ctx, fallback);
        throw error;
    }
}

const inMazeBasement = (ctx: QuestContext) => area(ctx, 2934, 9650, 14);
const inDwarvenMine = (ctx: QuestContext) => area(ctx, 3040, 9846, 42);
const inShipHold = (ctx: QuestContext) => area(ctx, 3047, 9640, 5);
const onShipDeck = (ctx: QuestContext) => area(ctx, 3047, 3208, 1);

async function leaveMazeWithMap(ctx: QuestContext) {
    if (inMazeBasement(ctx)) {
        await walk(ctx, 2939, 9657, 2);
        await changeFloor(ctx, 'up', 2939, 9657, 0);
    }
    const p = position(ctx);
    if (p.level !== 0 || p.worldX < 2921 || p.worldX > 2940 || p.worldZ < 3240 || p.worldZ > 3257) return;
    if (p.worldX >= 2938 && p.worldZ >= 3252) {
        await walk(ctx, 2938, 3252, 0);
        await activate(ctx, [2602], 2938, 3252, 'Leave the maze return corridor', { walkFirst: false });
        await ctx.sdk.waitForCondition(() => position(ctx).worldX === 2937, 5000);
    }
    await walk(ctx, 2940, 3248, 0);
    await activate(ctx, [2595], 2941, 3248, 'Unlock the maze entrance from inside', { item: 1542, walkFirst: false });
    await ctx.sdk.waitForCondition(() => position(ctx).worldX >= 2941, 5000);
    await walk(ctx, 2942, 3248, 0);
    auditEvent('check', 'dragon-slayer-maze-exit', { outcome: 'complete', mapPiece: has(ctx, 1535) });
}

async function leaveDwarvenMine(ctx: QuestContext) {
    if (!inDwarvenMine(ctx)) return;
    if (position(ctx).worldX >= 3051) await activate(ctx, [2586], 3051, 9840, 'Exit the Dwarven Mine map room');
    await walk(ctx, 3019, 9850, 2);
    await changeFloor(ctx, 'up', 3019, 9850, 2);
}

async function melzarsMaze(ctx: QuestContext, inspectBasement?: (ctx: QuestContext) => Promise<void>) {
    const p = () => position(ctx);
    const inside = () => (p().level > 0 && area(ctx, 2930, 3249, 14)) ||
        (p().worldX >= 2921 && p().worldX <= 2940 && p().worldZ >= 3240 && p().worldZ <= 3257) ||
        inMazeBasement(ctx);
    if (!inside()) {
        await getReplacementMazeKey(ctx);
        const mazeHealth = mazeRooms.reduce((sum, room) => sum + room.hp, 0);
        await prepareCombat(ctx, mazeHealth);
        if (questSkill(ctx, 'Magic') >= 31) {
            await prepareQuestStep(ctx, { slots: 3, withdraw: [
                { name: 'Law rune', count: 1 }, { name: 'Air rune', count: 3 }, { name: 'Earth rune', count: 1 },
            ] });
        }
        planQuestFight(ctx, { name: 'Melzar’s Maze', hitpoints: mazeHealth, incomingHit: 8, meleeLevel: 40, minimumFood: 2 },
            { magicOnly: !hasMeleeWeapon(ctx) });
        questPhase('dragon-slayer-maze-entry');
        await activate(ctx, [2595], 2941, 3248, 'Unlock the entrance to Melzar’s Maze', { item: 1542 });
        await walk(ctx, 2940, 3248, 0);
    }
    if (p().level === 0 && p().worldZ < 4000 && p().worldZ > 3242) {
        const room = mazeRooms[0];
        await mazeRoom(ctx, room, () => p().worldX <= room.x - 1 && p().worldZ >= room.z);
        await walk(ctx, room.lx, room.lz, 1);
        await changeFloor(ctx, 'up', room.lx, room.lz, 0);
    }
    if (p().level === 1 && p().worldZ > 3245) {
        const room = mazeRooms[1];
        await mazeRoom(ctx, room, () => p().worldX >= room.x && p().worldZ > 3251);
        await walk(ctx, room.lx, room.lz, 1);
        await changeFloor(ctx, 'up', room.lx, room.lz, 0);
    }
    if (p().level === 2) {
        const room = mazeRooms[2];
        await mazeRoom(ctx, room, () => p().worldZ < room.z);
        await walk(ctx, room.lx, room.lz, 1);
        await changeFloor(ctx, 'down', room.lx, room.lz, 0);
    }
    if (p().level === 1) {
        await walk(ctx, 2937, 3240, 1);
        await changeFloor(ctx, 'down', 2937, 3240, 0);
    }
    if (p().worldZ < 4000) {
        await activate(ctx, [2605], 2932, 3240, 'Descend to the final rooms of the maze');
        await ctx.sdk.waitForCondition(() => p().worldZ > 9600, 8000);
    }
    await mazeRoom(ctx, mazeRooms[3], () => p().worldX <= 2930 || p().worldZ >= 9647);
    await mazeRoom(ctx, mazeRooms[4], () => p().worldZ >= 9652);
    await inspectBasement?.(ctx);
    await mazeRoom(ctx, mazeRooms[5], () => p().worldZ >= 9655 && p().worldX >= 2933);
    questPhase('dragon-slayer-maze-chest');
    await takeMapFromChest(ctx, 2935, 9657, [2603, 2604], 1535);
    await leaveMazeWithMap(ctx);
}

async function makeUnfiredBowl(ctx: QuestContext) {
    const { sdk, bot } = ctx;
    if (has(ctx, 1791)) return;
    if (questSkill(ctx, 'Crafting') < 8) throw new Error('An unfired bowl or level 8 Crafting is needed for the map room');
    if (!has(ctx, 1761) && !has(ctx, 434)) {
        if (!sdk.findInventoryItem(/pickaxe$/i) && !sdk.findEquipmentItem(/pickaxe$/i)) {
            await walk(ctx, 3231, 3203);
            await buyQuestSupply(ctx, /^bob$/i, 'Bronze pickaxe', 12);
        }
        const clayRocks = [{ id: 2108, x: 2986, z: 3239 }, { id: 2109, x: 2987, z: 3240 }];
        for (const target of [...clayRocks, ...clayRocks]) {
            await walk(ctx, target.x, target.z - 1, 0);
            const rock = (await sdk.scanNearbyLocs(4)).find(loc =>
                loc.id === target.id && loc.x === target.x && loc.z === target.z && loc.reachable !== false);
            if (!rock) {
                auditEvent('check', 'dragon-slayer-mine-clay', { ...target, outcome: 'rock-unavailable' });
                continue;
            }
            await auditOperation('dragon-slayer-mine-clay', 'Mine clay to make the Oracle’s unfired bowl',
                target, () => sdk.getState(), async () => {
                    const mined = await bot.mineRock(rock, { timeout: 12000 });
                    if (!has(ctx, 434)) await sdk.waitForTicks(3);
                    return mined;
                }, mined => ({ outcome: has(ctx, 434) ? 'complete' : 'failed', message: mined.message, xp: mined.xpGained }));
            if (has(ctx, 434)) break;
        }
        if (!has(ctx, 434)) throw new Error('No clay was obtained from either Rimmington rock after a retry');
    }
    if (!has(ctx, 1761)) {
        if (!has(ctx, 1929)) {
            if (!has(ctx, 1925)) {
                await walk(ctx, 2947, 3217);
                const seller = sdk.findNearbyNpc(/^shop keeper$/i) ?? sdk.findNearbyNpc(/^shop assistant$/i);
                if (!seller) throw new Error('A bucket is required to soften the clay');
                await buyQuestSupply(ctx, /^shop (?:keeper|assistant)$/i, 'Bucket', 5);
            }
            await activate(ctx, [884], 2956, 3212, 'Fill a bucket at the Rimmington well', { item: 1925 });
            await sdk.waitForCondition(() => has(ctx, 1929), 8000);
        }
        await useTogether(ctx, /^bucket of water$/i, /^clay$/i);
        await sdk.waitForCondition(() => has(ctx, 1761), 5000);
    }
    const bowlComponent = 8897; // skill_multi3:make1_c in interface.pack
    const bowlName = /\bbowl\b/i;
    const bowlOption = (option: { componentId?: number; text: string }) =>
        option.componentId === bowlComponent || bowlName.test(option.text);

    await walk(ctx, 3086, 3409, 0);
    await activate(ctx, [2642], 3087, 3409, 'Open the Barbarian Village pottery wheel with soft clay',
        { item: 1761, walkFirst: false });
    await auditOperation('dragon-slayer-shape-bowl', 'Select one unfired bowl from the pottery wheel menu',
        { bowlComponent }, () => sdk.getState(), async () => {
            const state = await sdk.waitForCondition(s => s.dialog.options.some(bowlOption) ||
                !!s.interface?.options.some(bowlOption), 8000).catch(() => sdk.getState());
            const dialogBowl = state?.dialog.options.find(bowlOption);
            const interfaceBowl = state?.interface?.options.find(bowlOption);
            auditEvent('check', 'dragon-slayer-pottery-options', {
                outcome: dialogBowl || interfaceBowl ? 'ready' : 'missing-bowl',
                dialog: state?.dialog.options, components: state?.dialog.allComponents,
                interface: state?.interface?.options,
            });
            if (!dialogBowl && !interfaceBowl) throw new Error('The pottery menu did not expose the Bowl button');
            const clicked = interfaceBowl ? await sdk.clickInterfaceOption(interfaceBowl) : await sdk.sendClickDialog(dialogBowl!.index);
            if (!clicked.success) throw new Error(clicked.message);
            await sdk.waitForCondition(() => has(ctx, 1791), 8000);
        }, () => ({ outcome: 'complete', item: 1791 }));
    await bot.closeInterface();
}

async function crossAlKharidToll(ctx: QuestContext, east: boolean) {
    const { sdk } = ctx;
    const arrived = () => (position(ctx).worldX >= 3268) === east;
    if (arrived()) return;
    await walk(ctx, east ? 3267 : 3268, 3227, 0);
    await activate(ctx, [2882], 3268, 3227, 'Ask the border guard to cross the Al Kharid toll gate', { walkFirst: false });
    await continueDialog(ctx, [/^yes,?\s+ok\.?$/i]);
    await sdk.waitForCondition(arrived, 8000);
    auditEvent('check', 'dragon-slayer-al-kharid-crossing', { outcome: 'complete', east });
}

async function oracleMap(ctx: QuestContext) {
    const { sdk } = ctx;
    const inMine = () => inDwarvenMine(ctx);
    questPhase('dragon-slayer-oracle-map');
    if (!inMine()) {
        await prepareQuestStep(ctx, { slots: 8, withdraw: [
            ...magicDoorSupplies.map(name => ({ name, count: 1 })),
            { name: 'Coins', count: 65 }, { name: 'Soft clay', count: 1 },
            { name: 'Bronze pickaxe', count: 1 }, { name: 'Bucket of water', count: 1 },
        ] });
        if (!has(ctx, 950)) {
            await crossAlKharidToll(ctx, true);
            await talkAt(ctx, 3299, 3204, /^silk trader$/i, [/how much are they/i, /sounds good/i], 8000);
            await sdk.waitForCondition(() => has(ctx, 950), 6000);
        }
        if (position(ctx).worldX >= 3268 && position(ctx).worldZ < 3240) await crossAlKharidToll(ctx, false);
        if (!has(ctx, 1907)) {
            await talkAt(ctx, 2957, 3370, /^barmaid$/i, [/try the mind bomb/i], 8000);
            await sdk.waitForCondition(() => has(ctx, 1907), 6000);
        }
        if (!has(ctx, 301)) {
            await walk(ctx, 3013, 3225, 3);
            await buyQuestSupply(ctx, /^gerrant$/i, 'Lobster pot', 45);
        }
        await makeUnfiredBowl(ctx);
        await talkAt(ctx, 3015, 3504, /^oracle$/i, [/seek a piece of the map/i], 8000);
        await walk(ctx, 3019, 3450, 2);
        await changeFloor(ctx, 'down', 3019, 3450, 2);
    }
    if (position(ctx).worldX < 3051) {
        await activate(ctx, [2586], 3051, 9840, 'Offer the four items to the Dwarven Mine map room');
        await walk(ctx, 3052, 9840, 0);
    }
    await takeMapFromChest(ctx, 3057, 9841, [2587, 2588], 1537);
    await leaveDwarvenMine(ctx);
}

async function wormbrainMap(ctx: QuestContext) {
    const { sdk, bot } = ctx;
    const telegrab = 1168;
    questPhase('dragon-slayer-wormbrain-map');
    const magic = questSkill(ctx, 'Magic');
    await prepareQuestStep(ctx, { slots: 5, withdraw: magic >= 33 ? [
        ...questSpellSupplies(ctx, 5).map(item => item.name === 'Air rune' ? { ...item, count: item.count + 1 } : item),
        { name: 'Law rune', count: 1 },
    ] : [{ name: 'Coins', count: 10_000 }] });
    if (magic < 33) {
        if (sdk.countInventoryItems(coins) < 10_000) throw new Error('Wormbrain requires level 33 Magic with Telekinetic Grab supplies, or 10,000 coins for the NPC sale');
        await talkAt(ctx, 3014, 3186, /^wormbrain$/i, [/piece of map that I need/i, /could pay you for the map piece/i, /10,000 it is/i], 12000);
        await sdk.waitForCondition(() => has(ctx, 1536), 8000);
        return;
    }
    if (!has(ctx, 563) || !has(ctx, 556)) throw new Error('Bring a Law rune and Air rune for Telekinetic Grab before killing Wormbrain');
    const plan = planQuestFight(ctx, { name: 'Wormbrain', hitpoints: 5, incomingHit: 0, meleeLevel: 1, minimumFood: 0 }, { magicOnly: true });
    if (plan.style !== 'magic') throw new Error('A combat spell is required to target Wormbrain through the bars');
    await walk(ctx, 3014, 3188, 2);
    let cast = 0;
    for (; cast < 15 && !has(ctx, 1536); cast++) {
        const drop = (await sdk.scanGroundItems(10)).find(item => item.id === 1536);
        if (drop) {
            await auditOperation('dragon-slayer-telegrab', 'Retrieve Wormbrain’s map piece through the prison bars',
                { x: drop.x, z: drop.z, item: drop.id }, () => sdk.getState(),
                () => sdk.sendSpellOnGroundItem(drop.x, drop.z, drop.id, telegrab),
                result => ({ outcome: result.success ? 'dispatched' : 'failed', message: result.message }));
            await sdk.waitForCondition(() => has(ctx, 1536), 7500);
            return;
        }
        const npc = sdk.findNearbyNpc(/^wormbrain$/i);
        if (npc && npc.hp !== 0) {
            const hit = await bot.castSpell(npc, plan.spell.component);
            if (!hit.success) throw new Error(hit.message);
        }
        await sdk.waitForTicks(2);
    }
    throw new Error(`No Wormbrain map piece was observed after ${cast} attempts`);
}

async function shipMaterials(ctx: QuestContext) {
    await prepareQuestStep(ctx, { slots: 9, withdraw: [
        { name: 'Coins', count: 2000 }, { name: 'Plank', count: 3 }, { name: 'Nails', count: 12 },
        { name: 'Hammer', count: 1 }, { name: 'Steel bar', count: 6 },
    ] });
    if (!has(ctx, 2347)) await groundItem(ctx, /^hammer$/i, 2934, 3286);
    if (held(ctx, 1539) < 12) await makeShipNails(ctx);
    if (held(ctx, 960) < 3) await groundItem(ctx, /^plank$/i, 2553, 3575, 3);
}

async function shipHold(ctx: QuestContext) {
    const { sdk } = ctx;
    if (area(ctx, 3047, 9640, 5)) return;
    if (!area(ctx, 3047, 3208, 1)) {
        await walk(ctx, 3047, 3204, 1);
        await activate(ctx, [2593], 3047, 3205, 'Board the Lady Lumbridge', { walkFirst: false });
        await sdk.waitForCondition(() => area(ctx, 3047, 3208, 1), 8000);
    }
    await activate(ctx, [2590], 3049, 3208, 'Descend to the hold of the Lady Lumbridge');
    await sdk.waitForCondition(() => area(ctx, 3047, 9640, 5), 10000);
}

async function leaveShip(ctx: QuestContext) {
    const { sdk } = ctx;
    if (inShipHold(ctx)) {
        await activate(ctx, [2592], 3048, 9640, 'Climb from the hold to the deck');
        await sdk.waitForCondition(() => position(ctx).worldZ < 4000, 8000);
    }
    if (onShipDeck(ctx)) {
        await activate(ctx, [2594], 3047, 3206, 'Return to Port Sarim dock to find a captain', { walkFirst: false });
        await sdk.waitForCondition(() => !onShipDeck(ctx), 8000);
    }
}

async function prepareShip(ctx: QuestContext, page: string) {
    const { sdk } = ctx;
    questPhase('dragon-slayer-buy-and-repair-ship');
    if (!area(ctx, 3047, 9640, 5)) {
        await shipMaterials(ctx);
        if (!shipBought.test(page)) {
            if (sdk.countInventoryItems(coins) < 2000) throw new Error('Klarense requires 2,000 coins to buy the Lady Lumbridge');
            await talkAt(ctx, 3047, 3204, /^klarense$/i, [/suppose I could buy it/i, /yep.*sounds good/i], 8000);
            const bought = await journalText(ctx, journal, title);
            if (!shipBought.test(bought)) throw new Error('The journal did not confirm the ship purchase');
        }
    }
    await shipHold(ctx);
    for (let attempt = 0; attempt < 3 && position(ctx).level === 1; attempt++) {
        const before = held(ctx, 960);
        await activate(ctx, [2589], 3047, 9639, 'Patch the ship with a plank and four steel nails', { item: 960 });
        await sdk.waitForCondition(() => held(ctx, 960) < before, 7000);
        await continueDialog(ctx);
    }
    if (!shipRepaired.test(await journalText(ctx, journal, title))) throw new Error('The journal did not confirm the ship repair');
    await leaveShip(ctx);
}

async function bankBeforeElvarg(ctx: QuestContext) {
    const { sdk, bot } = ctx;
    const plan = planQuestFight(ctx, elvarg, { magicOnly: !hasMeleeWeapon(ctx) });
    questPhase('dragon-slayer-bank-before-elvarg', { style: plan.style });
    const combatRunes: Record<string, number> = plan.style === 'magic' ? { ...plan.spell.runes } : {};
    const escape = questSkill(ctx, 'Magic') >= 31 && has(ctx, 563) && has(ctx, 557) && held(ctx, 556) >= 3;
    const needed = (item: { id: number; name: string; count: number }) =>
        item.id === 1538 || item.id === 1540 || questFood.test(item.name) ? item.count
            : combatRunes[item.name] !== undefined ? item.count
            : escape ? ({ 556: 3, 557: 1, 563: 1 } as Record<number, number>)[item.id] ?? 0 : 0;
    await walk(ctx, bankLocation[0], bankLocation[1], 4);
    const staff = sdk.findEquipmentItem(/^dramen staff$/i);
    if (staff) {
        const unequipped = await bot.unequipItem(staff);
        if (!unequipped.success) throw new Error(unequipped.message);
    }
    const opened = await bot.openBank();
    if (!opened.success) throw new Error(opened.message);
    try {
        for (const item of sdk.getInventory()) {
            const extra = item.count - needed(item);
            if (extra <= 0) continue;
            await auditOperation('dragon-slayer-bank-unneeded-item', 'Bank an item or surplus stack before boarding for Elvarg',
                { id: item.id, item: item.name, amount: extra }, () => sdk.getState(), async () => {
                    const deposited = await bot.depositItem(item, extra);
                    if (!deposited.success) throw new Error(deposited.message);
                    return deposited;
                }, result => ({ outcome: 'complete', message: result.message }));
        }
    } finally {
        await bot.closeBank();
    }
    if (sdk.getInventory().some(item => item.count > needed(item)) || sdk.findEquipmentItem(/^dramen staff$/i)) {
        throw new Error('The pre-Elvarg bank check still shows unnecessary items');
    }
    auditEvent('check', 'dragon-slayer-bank-verified', {
        outcome: 'complete', inventory: sdk.getInventory().map(item => ({ id: item.id, name: item.name, count: item.count })),
    });
}

async function fightElvarg(ctx: QuestContext, page: string) {
    const { sdk, bot } = ctx;
    const onCrandor = () => area(ctx, 2845, 3246, 29);
    const inLair = () => area(ctx, 2847, 9645, 30);
    if (!onCrandor() && !inLair()) {
        questPhase('dragon-slayer-prepare-elvarg');
        if (inShipHold(ctx) || onShipDeck(ctx)) await leaveShip(ctx);
        await getShield(ctx);
        await prepareCombat(ctx, elvarg.hitpoints);
        if (!shieldEquipped(ctx)) {
            const shield = inventory(ctx, 1540);
            if (!shield) throw new Error('The anti-dragonbreath shield must be carried before sailing');
            const result = await bot.equipItem(shield);
            if (!result.success || !shieldEquipped(ctx)) throw new Error(`Could not equip the anti-dragonbreath shield: ${result.message}`);
        }
        await bankBeforeElvarg(ctx);
        questPhase('dragon-slayer-sail-crandor');
        if (!nedHired.test(page) && !finishedSailing.test(page)) {
            await talkAt(ctx, 3100, 3258, /^ned$/i, [
                /could you take me to the island of crandor/i, /are you going to take me to crandor island/i,
            ], 8000);
            const map = inventory(ctx, 1538);
            if (map) {
                const ned = sdk.findNearbyNpc(/^ned$/i);
                if (!ned) throw new Error('Ned was no longer in view when giving him the map');
                await auditOperation('dragon-slayer-give-map', 'Give Ned the completed map so he joins the repaired ship',
                    { npc: ned.index, map: map.id }, () => sdk.getState(), () => sdk.sendUseItemOnNpc(map.slot, ned.index),
                    result => ({ outcome: result.success ? 'dispatched' : 'failed', message: result.message }));
                await sdk.waitForCondition(() => !has(ctx, 1538), 8000);
                await continueDialog(ctx);
            }
            if (!nedHired.test(await journalText(ctx, journal, title))) throw new Error('The journal did not confirm that Ned was hired');
        }
        await shipHold(ctx);
        await talkAt(ctx, 3046, 9640, /^ned$/i, [/yep.*lets go/i], 8000);
        await sdk.waitForCondition(() => onCrandor(), 30000);
        await continueDialog(ctx);
    }
    const plan = planQuestFight(ctx, elvarg, { magicOnly: !hasMeleeWeapon(ctx) });
    if (!shieldEquipped(ctx)) throw new Error('Elvarg requires an equipped anti-dragonbreath shield');
    if (onCrandor()) {
        await activate(ctx, [2609], 2833, 3255, 'Descend from Crandor to the dungeon');
        await sdk.waitForCondition(() => inLair(), 9000);
    }
    questPhase('dragon-slayer-elvarg');
    if (position(ctx).worldX <= elvargGate.x) {
        await activate(ctx, [2607], elvargGate.x, elvargGate.z, 'Open Elvarg’s gate with the anti-dragonbreath shield equipped');
        await walk(ctx, 2848, 9636, 0);
    }
    const state = await sdk.waitForCondition(s => s.nearbyNpcs.some(n => n.id === 742 && n.hp !== 0), 15000);
    const dragon = state.nearbyNpcs.find(n => n.id === 742 && n.hp !== 0);
    if (!dragon) throw new Error('Could not find Elvarg after reaching the lair');
    await withQuestProtection(ctx, ['protect_from_melee', 'protect_from_magic'], () => fightQuestNpc(ctx, dragon, elvarg, plan, {
        won: () => readQuest(ctx, journal) === 'complete', protectedFromDamage: () => shieldEquipped(ctx),
        retreat: async () => {
            await activate(ctx, [2607], elvargGate.x, elvargGate.z, 'Retreat through Elvarg’s gate');
            await walk(ctx, 2844, 9636, 0);
        },
    }));
    await waitForQuestJournal(ctx, journal, 'complete', 12000);
}

export async function checkDragonMazeBasement(ctx: QuestContext, inspectBasement: (ctx: QuestContext) => Promise<void>) {
    await waitForQuestJournal(ctx, journal, 'available', 15000);
    await getBriefing(ctx);
    if (!inMazeBasement(ctx) && !has(ctx, 1542)) {
        await prepareQuestStep(ctx, { bank: [2947, 3368], slots: 2, withdraw: [{ name: 'Maze key', count: 1 }] });
    }
    await melzarsMaze(ctx, inspectBasement);
}

if (import.meta.main) {
    const result = await runScript(async ctx => {
        const { sdk } = ctx;
        await sdk.waitForReady();
        await waitForQuestJournal(ctx, journal, 'available', 15000);
        if (readQuest(ctx, journal) === 'complete') return;
        await exitZanaris(ctx);
        await getBriefing(ctx);
        let page = await journalText(ctx, journal, title);
        if (!nedHired.test(page) && !finishedSailing.test(page)) {
            if (has(ctx, 1535) || has(ctx, 1538)) await leaveMazeWithMap(ctx);
            if (has(ctx, 1537) || has(ctx, 1538)) await leaveDwarvenMine(ctx);
            if (shipRepaired.test(page)) await leaveShip(ctx);
            if (!inMazeBasement(ctx) && !area(ctx, 2930, 3248, 14) && !inDwarvenMine(ctx) && !inShipHold(ctx)) {
                questPhase('dragon-slayer-map-preflight');
                await prepareQuestStep(ctx, { slots: 13, withdraw: [
                    { name: 'Maze key', count: 1 }, ...mapPieces, { name: 'Crandor map', count: 1 },
                ] });
                await getShield(ctx);
            }
            if (!has(ctx, 1538)) {
                if (inDwarvenMine(ctx) && !has(ctx, 1537)) await oracleMap(ctx);
                if (!has(ctx, 1535)) await melzarsMaze(ctx);
                if (!has(ctx, 1537)) await oracleMap(ctx);
                if (!has(ctx, 1536)) await wormbrainMap(ctx);
                questPhase('dragon-slayer-assemble-map');
                const first = inventory(ctx, 1535);
                const second = inventory(ctx, 1536);
                if (!first || !second) throw new Error('The map parts are missing or banked');
                await sdk.sendUseItemOnItem(first.slot, second.slot);
                await sdk.waitForCondition(() => has(ctx, 1538), 8000);
                await continueDialog(ctx);
            }
            if (!shipRepaired.test(page)) await prepareShip(ctx, page);
            page = await journalText(ctx, journal, title);
        }
        await fightElvarg(ctx, page);
        questLog('quest-complete', { quest, evidence: 'journal', questPoints: sdk.getState()?.questPoints });
    }, { printState: false, timeout: 7_200_000 });

    if (!result.success) {
        questLog('quest-failed', { quest, error: result.error?.message });
        process.exitCode = 1;
    }
}

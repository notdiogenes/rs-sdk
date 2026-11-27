import { auditEvent, auditOperation } from '../../../sdk/audit-trace';
import { runScript } from '../../../sdk/runner';
import { Spells } from '../../../sdk/spells';
import {
    canMeleeQuest, fightQuestNpc, planQuestFight, questFoodSupplies, questSkill, questSpellSupplies, withQuestProtection,
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
const swordTiers = ['Rune', 'Adamant', 'Mithril', 'Black', 'Steel', 'Iron', 'Bronze'] as const;
const swordLevels = [40, 30, 20, 10, 5, 1, 1] as const;

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
    await prepareQuestStep(ctx, { slots: 2, withdraw: [{ name: 'Maze key', count: 1 }] });
    const introductions = [/can you sell me some rune plate mail/i, /guildmaster of the champions/i,
        /how am I meant to prove/i, /a dragon.*sounds like fun/i];
    const farewell = /try and get everything together/i;
    const findDragon = /where can I find this dragon/i;
    await walk(ctx, 3068, 3517, 0);
    for (const topic of [/first piece/i, /second piece/i, /third piece/i, /where can I get an antidragon shield/i]) {
        await talk(ctx, /^oziach$/i, [...introductions, farewell, topic, findDragon]);
    }
    if (/should return to Oziach|should speak to Oziach/i.test(await journalText(ctx, journal, title))) {
        throw new Error('Dragon Slayer journal did not confirm Oziach’s briefing');
    }
}

function shieldEquipped(ctx: QuestContext) {
    return ctx.sdk.getEquipment().some(item => item.id === 1540);
}

async function getShield(ctx: QuestContext) {
    if (shieldEquipped(ctx) || has(ctx, 1540)) return;
    questPhase('dragon-slayer-get-shield');
    await prepareQuestStep(ctx, { slots: 3, withdraw: [{ name: 'Dragonfire shield', count: 1 }] });
    if (has(ctx, 1540)) return;
    await walk(ctx, 3204, 3229, 2);
    await changeFloor(ctx, 'up', 3204, 3229, 1);
    await talkAt(ctx, 3212, 3220, /^duke horacio$/i, [/shield that will protect me/i], 8000);
    await ctx.sdk.waitForCondition(() => has(ctx, 1540), 6000);
    await walk(ctx, 3204, 3229, 2);
    await changeFloor(ctx, 'down', 3204, 3229, 1);
}

async function prepareCombat(ctx: QuestContext, hitpoints: number, magicOnly = false) {
    const swords = swordTiers.flatMap((metal, i) => questSkill(ctx, 'Attack') >= swordLevels[i]!
        ? [{ name: `${metal} longsword`, count: 1 }, { name: `${metal} sword`, count: 1 }] : []);
    const wantMelee = !magicOnly && canMeleeQuest(ctx, elvarg);
    const weapon = ctx.sdk.getEquipment().some(item => /longsword|scimitar|\bsword$/i.test(item.name) && !/2h/i.test(item.name));
    await prepareQuestStep(ctx, { slots: 12, withdraw: [
        ...wantMelee && !weapon ? swords.slice(0, 4) : [],
        ...wantMelee ? [] : questSpellSupplies(ctx, hitpoints),
        ...questFoodSupplies,
    ] });
    if (wantMelee && !weapon) {
        const owned = swords.find(item => ctx.sdk.countInventoryItems(new RegExp(`^${item.name}$`, 'i')) > 0);
        if (owned) {
            const result = await ctx.bot.equipItem(new RegExp(`^${owned.name}$`, 'i'));
            if (!result.success) throw new Error(result.message);
        } else {
            throw new Error('Prepare a one-handed weapon for melee, or use a character with suitable combat runes');
        }
    }
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

async function mazeRoom(ctx: QuestContext, room: typeof mazeRooms[number], crossed: () => boolean) {
    const { sdk } = ctx;
    if (crossed()) return;
    questPhase('dragon-slayer-maze-room', { target: room.name, door: { x: room.x, z: room.z } });
    if (!has(ctx, room.key)) {
        await walk(ctx, room.nx, room.nz, 2);
        const fight = { name: room.name, hitpoints: room.hp, incomingHit: room.hit, meleeLevel: Math.min(40, room.hp), minimumFood: 0 };
        const plan = planQuestFight(ctx, fight);
        for (let attempt = 0; attempt < 5 && !has(ctx, room.key); attempt++) {
            if (await pickUp(ctx, room.key, 8)) break;
            const seen = await sdk.waitForCondition(s => s.nearbyNpcs.some(n => n.id === room.npc && !n.inCombat), 15000);
            const target = seen.nearbyNpcs.find(n => n.id === room.npc && !n.inCombat);
            if (!target) continue;
            const p = position(ctx);
            await fightQuestNpc(ctx, target, fight, plan, { retreat: async () => {
                await sdk.sendWalk(p.worldX, p.worldZ);
                await sdk.waitForTicks(3);
            } });
            await sdk.waitForTicks(3);
        }
    }
    if (!has(ctx, room.key)) throw new Error(`No ${room.name} key was recovered`);
    await activate(ctx, [room.door], room.x, room.z, 'Unlock the door for the next maze room', { item: room.key });
    await walk(ctx, room.x + room.dx, room.z + room.dz, 0);
    if (!crossed()) throw new Error(`The ${room.name} door did not lead into the expected room`);
    auditEvent('milestone', 'dragon-slayer-maze-door-passed', { door: room.door, target: room.name });
}

async function melzarsMaze(ctx: QuestContext) {
    const p = () => position(ctx);
    const inside = () => (p().level > 0 && area(ctx, 2930, 3249, 14)) ||
        (p().worldX >= 2921 && p().worldX <= 2940 && p().worldZ >= 3239 && p().worldZ <= 3258) ||
        area(ctx, 2934, 9650, 14);
    if (!inside()) {
        await prepareCombat(ctx, 160);
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
    await mazeRoom(ctx, mazeRooms[5], () => p().worldZ >= 9655 && p().worldX >= 2933);
    await activate(ctx, [2603, 2604], 2935, 9657, 'Open or search the Melzar’s Maze map chest');
    if (!has(ctx, 1535)) await activate(ctx, [2604], 2935, 9657, 'Take the Melzar’s Maze map piece');
    await ctx.sdk.waitForCondition(() => has(ctx, 1535), 8000);
    await continueDialog(ctx);
    await walk(ctx, 2939, 9657, 2);
    await changeFloor(ctx, 'up', 2939, 9657, 0);
    if (inside()) {
        await activate(ctx, [2602], 2938, 3252, 'Exit Melzar’s Maze');
        await walk(ctx, 2941, 3252, 1);
    }
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
        await walk(ctx, 2938, 3284, 3);
        const rock = (await sdk.scanNearbyLocs(10)).find(loc => [2108, 2109].includes(loc.id) && loc.reachable !== false);
        if (!rock) throw new Error('Could not locate the Rimmington clay rocks');
        const mined = await bot.mineRock(rock);
        if (!mined.success || !has(ctx, 434)) throw new Error(`Clay mining: ${mined.message}`);
    }
    if (!has(ctx, 1761)) {
        if (!has(ctx, 1929)) {
            if (!has(ctx, 1925)) {
                await walk(ctx, 2947, 3217);
                const seller = sdk.findNearbyNpc(/^shop keeper$/i) ?? sdk.findNearbyNpc(/^shop assistant$/i);
                if (!seller) throw new Error('A bucket is required to soften the clay');
                await buyQuestSupply(ctx, /^shop (?:keeper|assistant)$/i, 'Bucket', 5);
            }
            await walk(ctx, 3221, 3226, 3);
            const water = (await sdk.scanNearbyLocs(12)).find(loc => /fountain|sink|waterpump/i.test(loc.name) && loc.reachable !== false);
            const bucket = inventory(ctx, 1925);
            if (!water || !bucket) throw new Error('Could not find the Falador water source or an empty bucket');
            await sdk.sendUseItemOnLoc(bucket.slot, water.x, water.z, water.id);
            await sdk.waitForCondition(() => has(ctx, 1929), 8000);
        }
        await useTogether(ctx, /^bucket of water$/i, /^clay$/i);
        await sdk.waitForCondition(() => has(ctx, 1761), 5000);
    }
    await activate(ctx, [2642], 2935, 3289, 'Open the pottery wheel with soft clay', { item: 1761 });
    const state = await sdk.waitForCondition(s => !!s.interface?.options.some(option => /\bbowl\b/i.test(option.text)), 8000);
    const bowl = state.interface?.options.find(option => /\bbowl\b/i.test(option.text));
    if (!bowl) throw new Error('Pottery wheel did not offer Bowl');
    const clicked = await sdk.clickInterfaceOption(bowl);
    if (!clicked.success) throw new Error(clicked.message);
    await sdk.waitForCondition(() => has(ctx, 1791), 8000);
    await bot.closeInterface();
}

async function oracleMap(ctx: QuestContext) {
    const { sdk } = ctx;
    const inMine = () => area(ctx, 3040, 9846, 40);
    questPhase('dragon-slayer-oracle-map');
    if (!inMine()) {
        await prepareQuestStep(ctx, { slots: 8, withdraw: [
            ...magicDoorSupplies.map(name => ({ name, count: 1 })),
            { name: 'Coins', count: 65 }, { name: 'Soft clay', count: 1 },
            { name: 'Bronze pickaxe', count: 1 }, { name: 'Bucket of water', count: 1 },
        ] });
        if (!has(ctx, 950)) {
            await talkAt(ctx, 3299, 3204, /^silk trader$/i, [/how much are they/i, /sounds good/i], 8000);
            await sdk.waitForCondition(() => has(ctx, 950), 6000);
        }
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
    await activate(ctx, [2587, 2588], 3057, 9841, 'Open or search the Dwarven Mine map chest');
    if (!has(ctx, 1537)) await activate(ctx, [2588], 3057, 9841, 'Take the Dwarven Mine map piece');
    await sdk.waitForCondition(() => has(ctx, 1537), 8000);
    await continueDialog(ctx);
    await activate(ctx, [2586], 3051, 9840, 'Exit the Dwarven Mine map room');
    await walk(ctx, 3019, 9850, 2);
    await changeFloor(ctx, 'up', 3019, 9850, 2);
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
    const { bot } = ctx;
    await prepareQuestStep(ctx, { slots: 9, withdraw: [
        { name: 'Coins', count: 2000 }, { name: 'Plank', count: 3 }, { name: 'Nails', count: 12 },
        { name: 'Hammer', count: 1 }, { name: 'Steel bar', count: 6 },
    ] });
    if (!has(ctx, 2347)) await groundItem(ctx, /^hammer$/i, 2934, 3286);
    if (held(ctx, 1539) < 12 && questSkill(ctx, 'Smithing') >= 34 && held(ctx, 2353) >= Math.ceil((12 - held(ctx, 1539)) / 2)) {
        await walk(ctx, 3187, 3424);
        for (let attempt = 0; held(ctx, 1539) < 12 && attempt < 6; attempt++) {
            const made = await bot.smithAtAnvil('steel nails', { barPattern: /^steel bar$/i });
            if (!made.success) throw new Error(made.message);
        }
    }
    if (held(ctx, 1539) < 12) throw new Error('Ship repair needs 12 steel nails or level 34 Smithing with enough steel bars');
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
    await activate(ctx, [2592], 3048, 9640, 'Climb from the repaired hold to the deck');
    await sdk.waitForCondition(() => position(ctx).worldZ < 4000, 8000);
    await activate(ctx, [2594], 3047, 3206, 'Return to Port Sarim dock to find a captain', { walkFirst: false });
    await sdk.waitForCondition(() => !area(ctx, 3047, 3208, 1), 8000);
}

async function fightElvarg(ctx: QuestContext, page: string) {
    const { sdk, bot } = ctx;
    const onCrandor = () => area(ctx, 2845, 3246, 29);
    const inLair = () => area(ctx, 2847, 9645, 30);
    if (!onCrandor() && !inLair()) {
        questPhase('dragon-slayer-prepare-elvarg');
        if (!area(ctx, 3047, 9640, 5)) await prepareCombat(ctx, elvarg.hitpoints);
        if (!shieldEquipped(ctx)) {
            const shield = inventory(ctx, 1540);
            if (!shield) throw new Error('The anti-dragonbreath shield must be carried before sailing');
            const result = await bot.equipItem(shield);
            if (!result.success || !shieldEquipped(ctx)) throw new Error(`Could not equip the anti-dragonbreath shield: ${result.message}`);
        }
        planQuestFight(ctx, elvarg);
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
    const plan = planQuestFight(ctx, elvarg);
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

const result = await runScript(async ctx => {
    const { sdk } = ctx;
    await sdk.waitForReady();
    await waitForQuestJournal(ctx, journal, 'available', 15000);
    if (readQuest(ctx, journal) === 'complete') return;
    await exitZanaris(ctx);
    await getBriefing(ctx);
    let page = await journalText(ctx, journal, title);
    if (!nedHired.test(page) && !finishedSailing.test(page)) {
        if (!area(ctx, 2934, 9650, 14) && !area(ctx, 2930, 3248, 14) && !area(ctx, 3040, 9846, 40)
            && !area(ctx, 3047, 9640, 5)) {
            await prepareQuestStep(ctx, { slots: 13, withdraw: [
                { name: 'Maze key', count: 1 }, { name: 'Map part', count: 3 }, { name: 'Crandor map', count: 1 },
            ] });
            await getShield(ctx);
        }
        if (!has(ctx, 1538)) {
            if (area(ctx, 3040, 9846, 40) && !has(ctx, 1537)) await oracleMap(ctx);
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

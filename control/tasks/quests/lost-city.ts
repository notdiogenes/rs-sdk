import { auditEvent, auditOperation } from '../../../sdk/audit-trace';
import { runScript } from '../../../sdk/runner';
import { Spells } from '../../../sdk/spells';
import { fightQuestNpc, planQuestFight, questFood, questFoodSupplies, questSpellSupplies, withQuestProtection } from './quest-combat';
import {
    buyQuestSupply, changeFloor, continueDialog, groundItem, journalText, prepareQuestStep, questLoc,
    questLog, questPhase, readQuest, talk, talkAt, useTogether, waitForQuestJournal, walk, type QuestContext,
} from './shared';

const quest = 'Lost City';
const journal = 7367;
const axe = /^(?:bronze|iron|steel|black|mithril|adamant|rune) axe$/i;
const flax = /^flax$/i;
const spiritFight = { name: 'Tree Spirit', hitpoints: 85, incomingHit: 7, meleeLevel: 45, minimumFood: 3 };
const zombieFight = { name: 'Entrana zombie', hitpoints: 30, incomingHit: 3, meleeLevel: 20, minimumFood: 0 };
const prayerPotion = /^prayer potion\([1-4]\)$/i;
const spiritDefeat = /Spirit defeated I can cut|I cut a branch from the tree/i;
const combatRunes = /^(?:air|fire|mind|chaos|death) rune$/i;
const surface = (x: number, z: number) => x >= 2800 && x < 2865 && z >= 3320 && z <= 3385;
const cave = (x: number, z: number) => x >= 2810 && x <= 2890 && z >= 9720 && z <= 9790;

async function loadAxe(ctx: QuestContext) {
    const { sdk } = ctx;
    if (sdk.findInventoryItem(axe) || sdk.findEquipmentItem(axe)) return;
    await prepareQuestStep(ctx, { withdraw: ['Coins', 'Bronze axe', 'Iron axe', 'Steel axe', 'Mithril axe', 'Adamant axe', 'Rune axe']
        .map(name => ({ name, count: name === 'Coins' ? 116 : 1 })) });
    if (sdk.findInventoryItem(axe) || sdk.findEquipmentItem(axe)) return;
    await walk(ctx, 3231, 3203, 2);
    await buyQuestSupply(ctx, /^bob$/i, 'Bronze axe', 25);
}

async function trainWoodcutting(ctx: QuestContext) {
    const { sdk, bot } = ctx;
    questPhase('lost-city-train-woodcutting');
    await loadAxe(ctx);
    if (sdk.findEquipmentItem(axe) && !sdk.findInventoryItem(axe)) {
        const worn = sdk.findEquipmentItem(axe)!;
        const moved = await bot.unequipItem(worn);
        if (!moved.success) throw new Error(moved.message);
    }
    const level = () => sdk.getSkill('Woodcutting')?.baseLevel ?? 0;
    let misses = 0;
    while (level() < 36) {
        if (sdk.getInventory().length >= 27) {
            await prepareQuestStep(ctx, { slots: 24, keep: axe });
        }
        await walk(ctx, 3102, 3249, 6);
        const targets = (await sdk.scanNearbyLocs(12)).filter(loc => loc.reachable !== false &&
            loc.optionsWithIndex.some(option => /chop/i.test(option.text)) &&
            (/^tree$/i.test(loc.name) || level() >= 15 && /^oak$/i.test(loc.name) || level() >= 30 && /^willow$/i.test(loc.name)));
        targets.sort((a, b) => (Number(/^tree$/i.test(a.name)) - Number(/^tree$/i.test(b.name))) || a.distance - b.distance);
        const target = targets[0];
        const before = sdk.getSkill('Woodcutting')?.experience ?? 0;
        const cut = target && await bot.chopTree(target);
        const after = sdk.getSkill('Woodcutting')?.experience ?? 0;
        auditEvent('check', 'lost-city-woodcutting-progress', {
            outcome: after > before ? 'complete' : 'unconfirmed', level: level(), before, after,
            tree: target && { x: target.x, z: target.z, name: target.name }, message: cut?.message,
        });
        if (after > before) misses = 0;
        else if (++misses >= 6) throw new Error('Could not verify Woodcutting XP near Draynor bank');
        else await sdk.waitForTicks(3);
    }
}

async function trainCrafting(ctx: QuestContext) {
    const { sdk, bot } = ctx;
    questPhase('lost-city-train-crafting');
    const level = () => sdk.getSkill('Crafting')?.baseLevel ?? 0;
    const upstairs = () => sdk.getState()?.player?.level === 1;
    while (level() < 31) {
        if (upstairs()) await changeFloor(ctx, 'down', 2715, 3470, 2);
        await prepareQuestStep(ctx, {
            slots: 26 - sdk.countInventoryItems(flax), keep: flax, withdraw: [{ name: 'Flax', count: 26 }], bank: [2725, 3493],
        });
        questPhase('lost-city-train-crafting');
        if (sdk.countInventoryItems(flax) < 26) {
            await walk(ctx, 2742, 3444, 3);
            let misses = 0;
            while (sdk.countInventoryItems(flax) < 26) {
                const plant = (await sdk.scanNearbyLocs(10)).find(loc => loc.id === 2646 && loc.reachable !== false);
                const before = sdk.countInventoryItems(flax);
                if (plant) {
                    await sdk.sendInteractLoc(plant.x, plant.z, plant.id, 1);
                    await sdk.waitForCondition(() => sdk.countInventoryItems(flax) > before, 4000).catch(() => null);
                }
                if (sdk.countInventoryItems(flax) > before) misses = 0;
                else if (++misses >= 6) throw new Error('Could not pick flax near Seers’ Village');
                else await sdk.waitForTicks(3);
            }
        }
        await walk(ctx, 2715, 3470, 1);
        await changeFloor(ctx, 'up', 2715, 3470, 2);
        await walk(ctx, 2712, 3471, 2);
        const wheel = await questLoc(ctx, /^spinning wheel$/i);
        while (level() < 31) {
            const item = sdk.findInventoryItem(flax);
            if (!item) break;
            const before = sdk.countInventoryItems(flax);
            const result = await bot.useItemOnLoc(item, wheel);
            if (sdk.countInventoryItems(flax) >= before) {
                await sdk.waitForCondition(() => sdk.countInventoryItems(flax) < before, 5000).catch(() => null);
            }
            if (sdk.countInventoryItems(flax) >= before) throw new Error(`Could not verify flax spinning: ${result.message}`);
            auditEvent('milestone', 'lost-city-flax-spun', { level: level(), flaxRemaining: sdk.countInventoryItems(flax) });
        }
    }
    if (upstairs()) await changeFloor(ctx, 'down', 2715, 3470, 2);
}

async function prepareEntrana(ctx: QuestContext) {
    const { sdk, bot } = ctx;
    const travelSupply = /^(?:knife|air rune|earth rune|law rune)$/i;
    const keep = (name: string) => travelSupply.test(name) || combatRunes.test(name) || questFood.test(name) || prayerPotion.test(name);
    const spells = questSpellSupplies(ctx, spiritFight.hitpoints + 2 * zombieFight.hitpoints);
    const withdraw = [
        { name: 'Knife', count: 1 }, { name: 'Earth rune', count: 1 },
        ...spells.some(item => item.name === 'Air rune') ? [] : [{ name: 'Air rune', count: 3 }],
        { name: 'Law rune', count: 1 },
        ...questFoodSupplies,
        ...(sdk.getPrayerState()?.prayerLevel ?? 0) >= 43 ? [{ name: 'Prayer potion(3)', count: 1 }] : [],
        ...spells,
    ];
    await prepareQuestStep(ctx, { slots: Math.max(6, sdk.getEquipment().length), withdraw });
    if (!sdk.getEquipment().length && sdk.getInventory().every(item => keep(item.name))) return;
    await walk(ctx, 3092, 3243, 4);
    for (const item of sdk.getEquipment()) {
        const result = await bot.unequipItem(item);
        if (!result.success) throw new Error(`Entrana equipment check: ${result.message}`);
    }
    const opened = await bot.openBank();
    if (!opened.success) throw new Error(opened.message);
    try {
        for (const name of new Set(sdk.getInventory().map(item => item.name))) {
            if (keep(name)) continue;
            const result = await bot.depositItem(name, -1);
            if (!result.success) throw new Error(`Could not bank ${name} before Entrana: ${result.message}`);
        }
    } finally {
        await bot.closeBank();
    }
}

async function recoverCaveAxe(ctx: QuestContext) {
    const { bot, sdk } = ctx;
    await walk(ctx, 2846, 9760, 2);
    for (let attempt = 0; attempt < 12; attempt++) {
        const drop = (await sdk.scanGroundItems(10)).find(item => axe.test(item.name) && item.reachable !== false);
        if (drop) {
            await bot.pickupItem(drop);
            if (sdk.findInventoryItem(axe)) return;
        }
        const zombie = sdk.getNearbyNpcs().filter(n => n.id === 76 && n.reachable !== false && n.hp !== 0)
            .sort((a, b) => a.distance - b.distance)[0];
        if (zombie) {
            const plan = planQuestFight(ctx, zombieFight);
            await fightQuestNpc(ctx, zombie, zombieFight, plan, { retreat: () => walk(ctx, 2830, 9773, 2) });
        }
        await sdk.waitForTicks(3);
    }
    throw new Error('The Entrana zombies did not yield a usable axe within the attempt budget');
}

async function leaveCave(ctx: QuestContext) {
    const { sdk } = ctx;
    const left = () => {
        const p = sdk.getState()?.player;
        return p && !cave(p.worldX, p.worldZ);
    };
    if (sdk.findInventoryItem(/^law rune$/i)) {
        await sdk.sendClickComponent(Spells.LUMBRIDGE_TELEPORT);
        await sdk.waitForCondition(() => !!left(), 8000).catch(() => null);
    }
    if (!left()) {
        await walk(ctx, 2874, 9749, 1);
        const portal = (await sdk.scanNearbyLocs(8)).find(loc => loc.id === 2407);
        if (!portal) throw new Error('The Entrana cave exit was not visible');
        await sdk.sendInteractLoc(portal.x, portal.z, portal.id, 1);
        await sdk.waitForCondition(() => !!left(), 10000);
        await walk(ctx, 3251, 3525, 8);
    }
}

async function leaveShip(ctx: QuestContext, x: number, z: number, plank: number) {
    const { sdk } = ctx;
    await walk(ctx, x, z, 2);
    const loc = (await sdk.scanNearbyLocs(10)).find(entry => entry.id === plank);
    if (!loc) throw new Error('The ship’s disembarkation gangplank was not visible');
    await auditOperation('cross-gangplank', 'Leave the ship via the disembarkation gangplank',
        { x, z, plank }, () => sdk.getState(), async () => {
            const sent = await sdk.sendInteractLoc(loc.x, loc.z, loc.id, 1);
            if (!sent.success) throw new Error(sent.message);
            await sdk.waitForCondition(s => !!s.player && s.player.level === 0 && s.player.worldZ > z, 12000);
        }, () => ({ outcome: 'complete' }));
}

const result = await runScript(async ctx => {
    const { sdk, bot } = ctx;
    const player = () => sdk.getState()?.player;
    const inside = () => {
        const p = player();
        return p && cave(p.worldX, p.worldZ);
    };
    const onIsland = () => {
        const p = player();
        return p && surface(p.worldX, p.worldZ);
    };
    const has = (id: number) => sdk.getInventory().some(i => i.id === id) || sdk.getEquipment().some(i => i.id === id);
    await sdk.waitForReady();
    await waitForQuestJournal(ctx, journal, 'available', 15000);
    if (readQuest(ctx, journal) === 'complete') return;

    const hasDefeatedSpirit = async () => spiritDefeat.test(await journalText(ctx, journal, /^lost city$/i));
    let defeated = false;
    if (inside() && !has(771) && !has(772)) {
        questPhase('lost-city-read-cave-progress');
        defeated = await hasDefeatedSpirit();
        if (!defeated && sdk.countInventoryItems(questFood) < spiritFight.minimumFood) {
            questPhase('lost-city-restore-depleted-supplies');
            await leaveCave(ctx);
        }
    }
    if (!inside() && !onIsland() && !has(771) && !has(772)) {
        if (readQuest(ctx, journal) === 'not-started') {
            questPhase('lost-city-adventurers');
            await talkAt(ctx, 3145, 3202, /^warrior$/i, [/what are you camped/i, /what makes you think/i, /if it.s hidden/i, /looks like you don.t know/i]);
            await sdk.waitForCondition(s => s.questJournal?.[journal] === 'in-progress', 8000);
        }
        if ((sdk.getSkill('Woodcutting')?.baseLevel ?? 0) < 36) await trainWoodcutting(ctx);
        if ((sdk.getSkill('Crafting')?.baseLevel ?? 0) < 31) await trainCrafting(ctx);
        const page = await journalText(ctx, journal, /^lost city$/i);
        if (/leprechaun.*hiding.*tree.*who can tell me/i.test(page)) {
            questPhase('lost-city-shamus');
            await loadAxe(ctx);
            await walk(ctx, 3138, 3212, 2);
            if (!sdk.findNearbyNpc(/^shamus$/i)) {
                const tree = (await sdk.scanNearbyLocs(10)).find(loc => loc.id === 2409);
                if (!tree) throw new Error('The leprechaun tree is outside the current scene');
                const tool = sdk.findInventoryItem(axe);
                for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
                    const x = tree.x + dx!, z = tree.z + dz!;
                    const approach = await bot.walkTo(x, z, 0, { timeout: 9000 });
                    if (!approach.success || player()?.worldX !== x || player()?.worldZ !== z) continue;
                    const tick = sdk.getState()?.tick ?? 0;
                    const sent = tool ? await sdk.sendUseItemOnLoc(tool.slot, tree.x, tree.z, tree.id)
                        : await sdk.sendInteractLoc(tree.x, tree.z, tree.id, 1);
                    const spawned = await sdk.waitForCondition(s => s.nearbyNpcs.some(n => /^shamus$/i.test(n.name)), 3600).catch(() => null);
                    auditEvent('check', 'lost-city-shamus-spawn', {
                        outcome: spawned ? 'complete' : 'unconfirmed', approach: { x, z }, message: sent.message,
                        feedback: sdk.getState()?.gameMessages.filter(m => m.type === 0 && m.tick >= tick).slice(-4).map(m => m.text),
                    });
                    if (spawned) break;
                }
                if (!sdk.findNearbyNpc(/^shamus$/i)) throw new Error('Shamus did not appear from the reachable sides of the leprechaun tree');
            }
            await talk(ctx, /^shamus$/i, [/how does it fit/i]);
        }
        questPhase('lost-city-entrana-loadout');
        await prepareEntrana(ctx);
        if (!has(946)) await groundItem(ctx, /^knife$/i, 3224, 3202);
        questPhase('lost-city-sail-entrana');
        await talkAt(ctx, 3047, 3235, /^monk of entrana$/i, [/yes.*ready to go/i]);
        await sdk.waitForCondition(() => !!onIsland(), 16000);
        await continueDialog(ctx);
    }
    if (onIsland() && !has(771) && !has(772)) {
        questPhase('lost-city-enter-cave');
        planQuestFight(ctx, spiritFight);
        if ((player()?.level ?? 0) === 0 && (player()?.worldZ ?? 0) < 3334) {
            await walk(ctx, 2829, 3330, 3);
            await changeFloor(ctx, 'up', 2829, 3330, 1);
        }
        if ((player()?.level ?? 0) === 1) await leaveShip(ctx, 2834, 3333, 2415);
        await talkAt(ctx, 2822, 3374, /^cave monk$/i, [/risk i will have to take/i]);
        await sdk.waitForCondition(() => !!inside(), 8000);
    }
    if (!has(771) && !has(772)) {
        if (!inside()) throw new Error('The Entrana cave entrance did not produce a dungeon state');
        if (!sdk.findInventoryItem(axe) && !sdk.findEquipmentItem(axe)) {
            questPhase('lost-city-dungeon-axe');
            await recoverCaveAxe(ctx);
        }
        questPhase('lost-city-tree-spirit');
        await walk(ctx, 2860, 9735, 2);
        const tree = await questLoc(ctx, /^dramen tree$/i);
        for (let attempt = 0; attempt < 4 && !has(771); attempt++) {
            await continueDialog(ctx);
            await auditOperation('chop-dramen-tree', 'Trigger the Tree Spirit or obtain the branch once the fight is complete',
                { x: tree.x, z: tree.z }, () => sdk.getState(),
                () => sdk.sendInteractLoc(tree.x, tree.z, tree.id, 1),
                sent => ({ outcome: sent.success ? 'dispatched' : 'failed', message: sent.message }));
            await sdk.waitForCondition(s => has(771) || !defeated && s.nearbyNpcs.some(n => n.id === 655 && n.hp !== 0), 9000)
                .catch(() => null);
            if (has(771)) break;
            if (defeated) continue;
            const spirit = sdk.getNearbyNpcs().find(n => n.id === 655 && n.hp !== 0);
            if (spirit) {
                const plan = planQuestFight(ctx, spiritFight);
                if (plan.style === 'melee' && !sdk.findEquipmentItem(axe)) {
                    const wielded = await bot.equipItem(axe);
                    if (!wielded.success) throw new Error(wielded.message);
                }
                const prayer = sdk.getPrayerState();
                const potion = sdk.findInventoryItem(prayerPotion);
                const drink = potion?.optionsWithIndex.find(option => /^drink$/i.test(option.text));
                if (prayer && prayer.prayerLevel >= 43 && prayer.prayerPoints < 10 && potion && drink) {
                    const before = prayer.prayerPoints;
                    await auditOperation('lost-city-restore-prayer', 'Restore overhead prayer points after entering the cave',
                        { potion: potion.name, before }, () => sdk.getState(), async () => {
                            const sent = await sdk.sendUseItem(potion.slot, drink.opIndex);
                            return sent.success && !!(await sdk.waitForCondition(state => state.prayers.prayerPoints > before, 5000).catch(() => null));
                        }, restored => ({ outcome: restored ? 'complete' : 'unconfirmed', after: sdk.getPrayerState()?.prayerPoints }));
                }
                await withQuestProtection(ctx, ['protect_from_melee'], () => fightQuestNpc(ctx, spirit, spiritFight, plan, {
                    retreat: () => walk(ctx, 2854, 9744, 2),
                    reposition: async (target, retry) => {
                        const [dx, dz] = [[-2, 0], [2, 0], [0, -2], [0, 2]][(retry - 1) % 4]!;
                        await sdk.sendWalk(target.x + dx!, target.z + dz!);
                        await sdk.waitForTicks(3);
                    },
                }));
                await sdk.waitForTicks(3);
                await continueDialog(ctx);
                defeated = await hasDefeatedSpirit();
            }
        }
        if (!has(771)) throw new Error('Could not verify a Dramen branch after the Tree Spirit fight');
    }
    if (!has(772)) {
        questPhase('lost-city-carve-staff');
        await useTogether(ctx, /^knife$/i, /^dramen branch$/i);
        await sdk.waitForCondition(() => has(772), 8000);
    }
    if (inside()) {
        questPhase('lost-city-leave-cave');
        await leaveCave(ctx);
    }
    if (onIsland()) {
        await talkAt(ctx, 2835, 3335, /^monk of entrana$/i, [/yes.*ready to go/i]);
        await sdk.waitForCondition(() => !onIsland(), 16000);
        await continueDialog(ctx);
        if ((player()?.level ?? 0) === 1) await leaveShip(ctx, 3048, 3232, 2413);
    }
    questPhase('lost-city-enter-zanaris');
    const equip = await bot.equipItem(/^dramen staff$/i);
    if (!equip.success && !sdk.findEquipmentItem(/^dramen staff$/i)) throw new Error(equip.message);
    try {
        await walk(ctx, 3201, 3169, 0);
    } catch (error) {
        // The pathfinder can open the shed on approach and move us to Zanaris as a side effect.
        const p = player();
        if (!p || p.worldX < 3200 || p.worldX > 3270 || p.worldZ < 9500 || p.worldZ > 9600) throw error;
    }
    if (readQuest(ctx, journal) !== 'complete') {
        const door = (await sdk.scanNearbyLocs(10)).find(loc => loc.id === 2406);
        if (door) await sdk.sendInteractLoc(door.x, door.z, door.id, 1);
    }
    await waitForQuestJournal(ctx, journal, 'complete', 16000);
    questLog('quest-complete', { quest, evidence: 'journal', questPoints: sdk.getState()?.questPoints });
}, { printState: false, timeout: 5_400_000 });

if (!result.success) {
    questLog('quest-failed', { quest, error: result.error?.message });
    process.exitCode = 1;
}

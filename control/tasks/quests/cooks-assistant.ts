import { runScript } from '../../../sdk/runner';
import { bankForQuest, changeFloor, groundItem, questLog, readQuest, talk, walk } from './shared';

// Coordinates and the ingredient sequence are cross-checked against the
// LostHQ 2004 guide and rs2b2t/rs2b0t's cooksassistant quest definition.
const journal = 7333;
const cook = /^cook$/i;
const flour = /^pot of flour$/i;
const egg = /^egg$/i;
const milk = /^bucket of milk$/i;
const pot = /^pot$/i;
const bucket = /^bucket$/i;
const grain = /^grain$/i;
const mill = { x: 3166, z: 3306 };
const cookChoices = [/what.s wrong/i, /yes,? i.ll help/i];

const result = await runScript(async ctx => {
    const { bot, sdk } = ctx;
    await sdk.waitForReady();
    await sdk.waitForCondition(s => !!s.questJournal?.[journal], 12_000);
    if (readQuest(ctx, journal) === 'complete') {
        questLog('quest-already-complete', { quest: "Cook's Assistant" });
        return;
    }
    // A previous run may have stopped inside the mill.
    const player = sdk.getState()?.player;
    if (player && player.level > 0 && Math.max(Math.abs(player.worldX - mill.x), Math.abs(player.worldZ - mill.z)) < 10) {
        while ((sdk.getState()?.player?.level ?? 0) > 0) await changeFloor(ctx, 'down', mill.x, mill.z);
    }
    await bankForQuest(ctx, [
        { name: 'Pot of flour', count: 1 }, { name: 'Egg', count: 1 }, { name: 'Bucket of milk', count: 1 },
        { name: 'Pot', count: 1 }, { name: 'Bucket', count: 1 }, { name: 'Grain', count: 1 },
    ]);
    const visitCook = async () => {
        await walk(ctx, 3209, 3215, 4);
        await talk(ctx, cook, cookChoices);
    };
    if (readQuest(ctx, journal) === 'not-started') {
        questLog('quest-start', { quest: "Cook's Assistant" });
        await visitCook();
        await sdk.waitForCondition(s => s.questJournal?.[journal] !== 'not-started' && !!s.questJournal?.[journal], 8000);
    }
    const got = (item: RegExp) => !!sdk.findInventoryItem(item);
    if (readQuest(ctx, journal) === 'complete') {
        questLog('quest-complete', { quest: "Cook's Assistant", evidence: 'journal' });
        return;
    }
    if (!got(flour)) {
        if (!got(pot)) await groundItem(ctx, pot, 3208, 3213);
        // Try the flour bin first, including on resume after earlier milling.
        await walk(ctx, mill.x, mill.z, 4);
        const takeFlour = async () => {
            const bin = sdk.findNearbyLoc(/^flour bin$/i);
            if (!bin) throw new Error('No flour bin at the Lumbridge mill');
            await bot.interactLoc(bin, 1);
            await sdk.waitForCondition(() => got(flour), 2200).catch(() => null);
        };
        await takeFlour();
        if (!got(flour)) {
            if (!got(grain)) {
                await walk(ctx, 3158, 3300, 4);
                const wheat = sdk.findNearbyLoc(/^wheat$/i);
                if (!wheat) throw new Error('Could not find wheat next to the mill');
                await bot.interactLoc(wheat, /pick/i);
                await sdk.waitForCondition(() => got(grain), 8000);
            }
            await walk(ctx, mill.x, mill.z, 4);
            while ((sdk.getState()?.player?.level ?? 0) < 2) await changeFloor(ctx, 'up', mill.x, mill.z);
            const hopper = sdk.findNearbyLoc(/^hopper$/i);
            if (!hopper) throw new Error('The upstairs hopper was not found');
            const first = sdk.getState()?.tick ?? 0;
            await bot.useItemOnLoc(grain, hopper);
            await sdk.waitForCondition(s => s.gameMessages.some(m => m.tick >= first &&
                /grain in the hopper/i.test(m.text)), 5500).catch(() => null);
            const controls = sdk.findNearbyLoc(/^hopper controls?$/i);
            if (!controls) throw new Error('The hopper controls were not found');
            await bot.interactLoc(controls, /operate/i);
            await sdk.waitForTicks(4);
            while ((sdk.getState()?.player?.level ?? 0) > 0) await changeFloor(ctx, 'down', mill.x, mill.z);
            await takeFlour();
            if (!got(flour)) throw new Error('The flour bin did not supply a pot of flour');
        }
        questLog('quest-ingredient', { item: 'Pot of flour' });
    }
    if (!got(egg)) {
        await groundItem(ctx, egg, 3227, 3300);
        questLog('quest-ingredient', { item: 'Egg' });
    }
    if (!got(milk)) {
        if (!got(bucket)) await groundItem(ctx, bucket, 3225, 3294);
        await walk(ctx, 3255, 3288, 5);
        const dairy = sdk.findNearbyLoc(/dairy cow/i);
        const cow = sdk.findNearbyNpc(/^(?:dairy )?cow$/i);
        if (dairy) await bot.useItemOnLoc(bucket, dairy);
        else if (cow) await bot.useItemOnNpc(bucket, cow);
        else throw new Error('No cow found inside the Lumbridge cow field');
        await sdk.waitForCondition(() => got(milk), 10_000);
        questLog('quest-ingredient', { item: 'Bucket of milk' });
    }
    await visitCook();
    await sdk.waitForCondition(s => s.questJournal?.[journal] === 'complete', 12_000);
    questLog('quest-complete', { quest: "Cook's Assistant", evidence: 'journal' });
}, { printState: false, timeout: 900_000 });

if (!result.success) {
    questLog('quest-failed', { quest: "Cook's Assistant", error: result.error?.message });
    process.exitCode = 1;
}

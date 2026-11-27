import { runScript } from '../../../sdk/runner';
import { prepareQuestStep, changeFloor, groundItem, questLog, questPhase, waitForQuestJournal, readQuest, talk, walk } from './shared';

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
const keep = /^(?:pot of flour|egg|bucket of milk|pot|bucket|grain)$/i;

const result = await runScript(async ctx => {
    const { bot, sdk } = ctx;
    await sdk.waitForReady();
    questPhase('quest-journal-preflight');
    await waitForQuestJournal(ctx, journal, 'available', 12_000);
    questPhase('quest-prepare');
    if (readQuest(ctx, journal) === 'complete') {
        questLog('quest-already-complete', { quest: "Cook's Assistant" });
        return;
    }
    // A previous run may have stopped inside the mill.
    const player = sdk.getState()?.player;
    const atMill = !!player && Math.max(Math.abs(player.worldX - mill.x), Math.abs(player.worldZ - mill.z)) < 10;
    if (atMill && player.level > 0) {
        while ((sdk.getState()?.player?.level ?? 0) > 0) await changeFloor(ctx, 'down', mill.x, mill.z);
    }
    const got = (item: RegExp) => !!sdk.findInventoryItem(item);
    const visitCook = async () => {
        await walk(ctx, 3209, 3215, 4);
        await talk(ctx, cook, cookChoices);
    };
    questPhase('cook-start');
    if (readQuest(ctx, journal) === 'not-started') {
        questLog('quest-start', { quest: "Cook's Assistant" });
        await visitCook();
        await sdk.waitForCondition(s => s.questJournal?.[journal] !== 'not-started' && !!s.questJournal?.[journal], 8000);
    }
    if (readQuest(ctx, journal) === 'complete') {
        questLog('quest-complete', { quest: "Cook's Assistant", evidence: 'journal' });
        return;
    }
    questPhase('cook-mill-flour');
    if (!got(flour)) {
        await prepareQuestStep(ctx, { slots: Number(!got(pot)), keep });
        if (!got(pot)) await groundItem(ctx, pot, 3208, 3213);
        // Try the flour bin first, including on resume after earlier milling.
        await walk(ctx, mill.x, mill.z, 4);
        const millMessages = () => (sdk.getState()?.gameMessages ?? [])
            .filter(m => /hopper|flour bin|pot of flour|can.t reach/i.test(m.text)).slice(-5).map(m => m.text).join(' | ');
        const takeFlour = async () => {
            const bin = (await sdk.scanNearbyLocs(8)).find(loc => /^flour bin$/i.test(loc.name));
            if (!bin) throw new Error('No flour bin at the Lumbridge mill');
            const action = await bot.interactLoc(bin, /^empty$/i);
            if (await sdk.waitForCondition(() => got(flour), 3500).catch(() => null)) return action.message;
            const direct = await bot.useItemOnLoc(pot, bin, { timeout: 4000 });
            return `${action.message}; ${direct.message}`;
        };
        await takeFlour();
        if (!got(flour)) {
            if (!got(grain)) {
                await prepareQuestStep(ctx, { slots: 1, keep });
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
            await bot.useItemOnLoc(grain, hopper);
            const controls = (await sdk.scanNearbyLocs(8)).find(loc => /^hopper controls?$/i.test(loc.name) &&
                loc.optionsWithIndex.some(option => /^operate$/i.test(option.text)));
            if (!controls) throw new Error('The hopper controls were not found');
            const startTick = sdk.getState()?.tick ?? 0;
            const operated = await bot.interactLoc(controls, /^operate$/i);
            const milled = await sdk.waitForCondition(s => s.gameMessages.some(m => m.tick >= startTick &&
                /grain slides down the chute|flour bin downstairs is full/i.test(m.text)), 4500).catch(() => null);
            while ((sdk.getState()?.player?.level ?? 0) > 0) await changeFloor(ctx, 'down', mill.x, mill.z);
            const collected = await takeFlour();
            if (!got(flour)) throw new Error(`No flour collected. Hopper ${milled ? 'confirmed' : operated.message}. ` +
                `Bin ${collected}. Game messages ${millMessages()}`);
        }
        questLog('quest-ingredient', { item: 'Pot of flour' });
    }
    questPhase('cook-gather-egg');
    if (!got(egg)) {
        await prepareQuestStep(ctx, { slots: 1, keep });
        await groundItem(ctx, egg, 3227, 3300);
        questLog('quest-ingredient', { item: 'Egg' });
    }
    questPhase('cook-fetch-milk');
    if (!got(milk)) {
        await prepareQuestStep(ctx, { slots: Number(!got(bucket)), keep });
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
    questPhase('cook-deliver');
    await visitCook();
    await waitForQuestJournal(ctx, journal, 'complete', 12_000);
    questLog('quest-complete', { quest: "Cook's Assistant", evidence: 'journal' });
}, { printState: false, timeout: 900_000 });

if (!result.success) {
    questLog('quest-failed', { quest: "Cook's Assistant", error: result.error?.message });
    process.exitCode = 1;
}

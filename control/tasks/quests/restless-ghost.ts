import { runScript } from '../../../sdk/runner';
import { bankForQuest, changeFloor, continueDialog, groundItem, questLog, questPhase, waitForQuestJournal, readQuest, talk, walk } from './shared';

// Route cross-checked against LostHQ's 2004 guide and the rs2b0t
// restlessghost and runemysteries modules (for the tower ladder).
const journal = 7337;
const quest = 'The Restless Ghost';
const skull = /^(?:skull|ghost.s skull)$/i;
const amulet = /^ghostspeak amulet$/i;
const grave = { x: 3250, z: 3193 };
const leaveTower = async (ctx: Parameters<typeof changeFloor>[0]) => {
    if ((ctx.sdk.getState()?.player?.worldZ ?? 0) < 9000) return;
    await walk(ctx, 3104, 9576, 4);
    await changeFloor(ctx, 'up', 3104, 9576);
};

const result = await runScript(async ctx => {
    const { bot, sdk } = ctx;
    await sdk.waitForReady();
    questPhase('quest-journal-preflight');
    await waitForQuestJournal(ctx, journal, 'available', 12_000);
    questPhase('quest-prepare');
    if (readQuest(ctx, journal) === 'complete') {
        questLog('quest-already-complete', { quest });
        return;
    }
    await leaveTower(ctx);
    await bankForQuest(ctx, [
        { name: 'Ghostspeak amulet', count: 1 }, { name: 'Skull', count: 1 }, { name: "Ghost's skull", count: 1 },
    ]);
    const openCoffin = async () => {
        await walk(ctx, grave.x, grave.z, 4);
        const coffin = sdk.getNearbyLocs().find(loc => /^coffin$/i.test(loc.name) &&
            loc.optionsWithIndex.some(option => /^open$/i.test(option.text)));
        if (coffin) {
            await bot.interactLoc(coffin, /^open$/i);
            await sdk.waitForTicks(3);
        }
    };
    questPhase('ghost-start');
    if (readQuest(ctx, journal) === 'not-started') {
        questLog('quest-start', { quest });
        await walk(ctx, 3244, 3206, 4);
        await talk(ctx, /^father aereck$/i, [/looking for a quest/i]);
        await sdk.waitForCondition(s => s.questJournal?.[journal] === 'in-progress', 8000);
    }
    if (!sdk.findInventoryItem(skull)) {
        questPhase('ghost-obtain-amulet');
        if (!sdk.findInventoryItem(amulet) && !sdk.findEquipmentItem(amulet)) {
            await walk(ctx, 3235, 3154, 4);
            await talk(ctx, /^father urhney$/i, [/father aereck sent/i, /ghost haunting/i, /lost the amulet/i]);
            if (!sdk.findInventoryItem(amulet) && !sdk.findEquipmentItem(amulet)) throw new Error('Urhney did not give the amulet');
            questLog('quest-ingredient', { quest, item: 'Ghostspeak amulet' });
        }
        if (!sdk.findEquipmentItem(amulet)) {
            const worn = await bot.equipItem(amulet);
            if (!worn.success) throw new Error(worn.message);
        }
        questPhase('ghost-speak-to-ghost');
        await openCoffin();
        await sdk.waitForCondition(s => s.nearbyNpcs.some(npc => /^restless ghost$/i.test(npc.name)), 6500).catch(() => null);
        await talk(ctx, /^restless ghost$/i, [/tell me what the problem is/i]);
        questPhase('ghost-recover-skull');
        await walk(ctx, 3108, 3162, 3);
        await changeFloor(ctx, 'down', 3105, 3162);
        await groundItem(ctx, skull, 3120, 9565);
        questLog('quest-ingredient', { quest, item: 'Skull' });
        await leaveTower(ctx);
    }
    questPhase('ghost-return-skull');
    await openCoffin();
    const coffin = sdk.findNearbyLoc(/^coffin$/i);
    if (!coffin) throw new Error('Could not find the ghost’s coffin');
    await bot.useItemOnLoc(skull, coffin);
    await continueDialog(ctx);
    await waitForQuestJournal(ctx, journal, 'complete', 12_000);
    questLog('quest-complete', { quest, evidence: 'journal' });
}, { printState: false, timeout: 900_000 });
if (!result.success) {
    questLog('quest-failed', { quest, error: result.error?.message });
    process.exitCode = 1;
}

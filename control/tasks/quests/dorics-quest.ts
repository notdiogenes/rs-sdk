import { runScript } from '../../../sdk/runner';
import { bankForQuest, groundItem, itemNamed, questLog, readQuest, talkAt, walk } from './shared';

const quest = "Doric's Quest";
const journal = 7336;
const ores = [['Clay', 6, 2986, 3240, [2108, 2109]], ['Copper ore', 4, 2978, 3247, [2090, 2091]], ['Iron ore', 2, 2972, 3239, [2092, 2093]]] as const;
const pickaxe = /^(?:bronze|iron|steel|mithril|adamant|rune) pickaxe$/i;

const result = await runScript(async ctx => {
    const { sdk, bot } = ctx;
    await sdk.waitForReady();
    await sdk.waitForCondition(s => !!s.questJournal?.[journal], 15_000);
    if (readQuest(ctx, journal) === 'complete') { questLog('quest-already-complete', { quest }); return; }
    await bankForQuest(ctx, [
        ...ores.map(([name, count]) => ({ name, count })), { name: 'Bronze pickaxe', count: 1 },
    ], [2946, 3369]);
    const visit = () => talkAt(ctx, 2952, 3451, /^doric$/i, [/wanted to use your anvils/i, /yes,? i will get you materials/i]);
    if (readQuest(ctx, journal) === 'not-started') { questLog('quest-start', { quest }); await visit(); }
    const held = (name: string) => sdk.countInventoryItems(itemNamed(name));
    if (ores.some(([name, count]) => held(name) < count) && !sdk.findInventoryItem(pickaxe) && !sdk.findEquipmentItem(pickaxe)) {
        await groundItem(ctx, /^bronze pickaxe$/i, 2963, 3216);
    }
    for (const [name, count, x, z, ids] of ores) {
        if (held(name) >= count) continue;
        await walk(ctx, x, z, 3);
        for (let attempt = 0; attempt < 36 && held(name) < count; attempt++) {
            const rocks = (await sdk.scanNearbyLocs(12)).filter(loc => ids.some(id => id === loc.id) &&
                loc.optionsWithIndex.some(o => /^mine$/i.test(o.text)) && loc.reachable !== false);
            const rock = rocks.sort((a, b) => a.distance - b.distance)[0];
            if (rock) await bot.mineRock(rock, { timeout: 8500 });
            else await sdk.waitForTicks(4);
        }
        if (held(name) < count) throw new Error(`Could not mine the required ${name}`);
        questLog('quest-ingredient', { quest, item: `${count} × ${name}` });
    }
    await visit();
    await sdk.waitForCondition(s => s.questJournal?.[journal] === 'complete', 12_000);
    questLog('quest-complete', { quest, evidence: 'journal', questPoints: sdk.getState()?.questPoints });
}, { printState: false, timeout: 900_000 });

if (!result.success) {
    questLog('quest-failed', { quest, error: result.error?.message });
    process.exitCode = 1;
}

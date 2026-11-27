import { runScript } from '../../../sdk/runner';
import { bankForQuest, buyQuestSupply, changeFloor, continueDialog, itemNamed, journalText, questLoc, questLog, questPhase, waitForQuestJournal, readQuest, talkAt, walk } from './shared';

const quest = "Black Knight's Fortress";
const journal = 7332;
const chain = 'Iron chainbody';
const helm = 'Bronze med helm';
const cabbageId = 1965;
const questChoice = [/i seek a quest/i, /i laugh in the face of danger/i];

const result = await runScript(async ctx => {
    const { bot, sdk } = ctx;
    await sdk.waitForReady();
    questPhase('quest-journal-preflight');
    await waitForQuestJournal(ctx, journal, 'available', 15_000);
    questPhase('quest-prepare');
    if (readQuest(ctx, journal) === 'complete') { questLog('quest-already-complete', { quest }); return; }
    const floor = () => sdk.getState()?.player?.level ?? 0;
    const climb = async (direction: 'up'|'down', x: number, z: number) => {
        await walk(ctx, x, z, 2);
        await changeFloor(ctx, direction, x, z, 1);
    };
    const loc = async (id: number) => {
        const result = (await sdk.scanNearbyLocs(10)).find(candidate => candidate.id === id);
        if (!result) throw new Error(`The fortress location ${id} is unavailable`);
        return result;
    };
    const passage = async (id: number, op: RegExp, x: number, z: number, choices: RegExp[] = []) => {
        await walk(ctx, x, z, 1);
        await bot.interactLoc(await loc(id), op);
        await continueDialog(ctx, choices);
    };
    const castleExit = async () => {
        if (floor() === 2) await climb('down', 2960, 3339);
        if (floor() === 1) await climb('down', 2955, 3338);
    };
    const sirAmik = async () => {
        await climb('up', 2954, 3338); await climb('up', 2960, 3338);
        await talkAt(ctx, 2960, 3336, /^sir amik varze$/i, questChoice);
        await castleExit();
    };
    const player = sdk.getState()?.player;
    if (player && Math.abs(player.worldX - 2960) < 15 && Math.abs(player.worldZ - 3338) < 15) await castleExit();
    if (floor() > 0) throw new Error('A Pirate is upstairs away from Sir Amik’s tower. Exit the fortress before retrying.');
    await bankForQuest(ctx, [
        { name: chain, count: 1 }, { name: helm, count: 1 }, { name: 'Coins', count: 350 }, { name: 'Cabbage', count: 1 },
    ], [2946, 3369]);
    questPhase('fortress-briefing');
    if (readQuest(ctx, journal) === 'not-started') { questLog('quest-start', { quest }); await sirAmik(); }
    const story = () => journalText(ctx, journal, /^black knight.s fortress$/i);
    const page = await story();
    questPhase('fortress-infiltration');
    if (!/sabotaged the witch.s potion/i.test(page)) {
        if (!sdk.findInventoryItem(itemNamed(chain)) && !sdk.findEquipmentItem(itemNamed(chain))) {
            await walk(ctx, 2973, 3312, 3); await buyQuestSupply(ctx, /^wayne$/i, chain, 300);
        }
        if (!sdk.findInventoryItem(itemNamed(helm)) && !sdk.findEquipmentItem(itemNamed(helm))) {
            await walk(ctx, 3076, 3429, 3); await buyQuestSupply(ctx, /^peksa$/i, helm, 50);
        }
        for (const name of [chain, helm]) {
            if (!sdk.findEquipmentItem(itemNamed(name)) && !(await bot.equipItem(itemNamed(name))).success) throw new Error(`Could not equip ${name}`);
        }
        if (!sdk.getInventory().some(i => i.id === cabbageId)) {
            await walk(ctx, 3053, 3295, 2);
            await bot.interactLoc(await questLoc(ctx, /^cabbage$/i, /^pick$/i), /^pick$/i);
            await sdk.waitForCondition(s => s.inventory.some(i => i.id === cabbageId), 8000);
        }
        await passage(2337, /^open$/i, 3016, 3513);
        questPhase('fortress-eavesdrop');
        if (!/eavesdropped on a witch/i.test(page)) {
            await passage(2341, /^push$/i, 3016, 3516);
            await climb('up', 3015, 3519); await climb('up', 3016, 3519);
            await climb('down', 3017, 3516);
            await climb('up', 3023, 3513); await climb('down', 3025, 3513);
            await passage(2339, /^open$/i, 3025, 3512);
            await climb('down', 3021, 3510);
            await passage(2342, /^listen.at$/i, 3025, 3507);
            if (!/eavesdropped on a witch/i.test(await story())) throw new Error('The journal did not confirm the conversation at the grill');
            await climb('up', 3021, 3510);
            await passage(2339, /^open$/i, 3025, 3511);
            await climb('up', 3025, 3513); await climb('down', 3023, 3513);
            await climb('up', 3017, 3516); await climb('down', 3016, 3519);
            await climb('down', 3015, 3519);
            await passage(2341, /^push$/i, 3016, 3517);
        }
        questPhase('fortress-sabotage');
        await passage(2338, /^open$/i, 3019, 3515, [/i don.t care.*going in anyway/i]);
        await climb('up', 3022, 3518);
        await passage(2341, /^push$/i, 3030, 3511);
        const cabbage = sdk.getInventory().find(i => i.id === cabbageId);
        if (!cabbage) throw new Error('Missing ordinary cabbage');
        await bot.useItemOnLoc(cabbage, await loc(2336));
        await continueDialog(ctx);
        if (!/sabotaged the witch.s potion/i.test(await story())) throw new Error('The journal did not confirm the weapon was sabotaged');
        await passage(2341, /^push$/i, 3030, 3510);
        await climb('down', 3022, 3518);
        await passage(2338, /^open$/i, 3021, 3515, [/i don.t care.*going in anyway/i]);
        await passage(2337, /^open$/i, 3016, 3514);
    }
    questPhase('fortress-report');
    await sirAmik();
    await waitForQuestJournal(ctx, journal, 'complete', 12_000);
    questLog('quest-complete', { quest, evidence: 'journal', questPoints: sdk.getState()?.questPoints });
}, { printState: false, timeout: 1_200_000 });

if (!result.success) {
    questLog('quest-failed', { quest, error: result.error?.message });
    process.exitCode = 1;
}

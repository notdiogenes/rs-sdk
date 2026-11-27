import { runScript } from '../../../sdk/runner';
import { prepareQuestStep, buyQuestSupply, changeFloor, continueDialog, itemNamed, journalText, questLoc, questLog, questPhase, waitForQuestJournal, readQuest, talkAt, walk } from './shared';

const quest = "Black Knight's Fortress";
const journal = 7332;
const chain = 'Iron chainbody';
const helm = 'Bronze med helm';
const cabbageId = 1965;
const keep = /^(?:iron chainbody|bronze med helm|cabbage|coins)$/i;
const questChoice = [/i seek a quest/i, /i laugh in the face of danger/i];
const sabotaged = /sabotaged the witch.s potion/i;

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
        await talkAt(ctx, 2960, 3336, /^sir amik varze$/i, questChoice, 3_000);
        await castleExit();
    };
    const crossLadderRoomDoor = async (direction: 'east' | 'west') => {
        const westX = 3021;
        const eastX = 3022;
        const z = 3515;
        const fromX = direction === 'east' ? westX : eastX;
        const toX = direction === 'east' ? eastX : westX;
        await walk(ctx, fromX, z, 0);
        const door = (await sdk.scanNearbyLocs(3)).find(loc => loc.id === 1530 && loc.x === westX && loc.z === z && loc.level === 1);
        if (door) {
            const opened = await bot.openDoor(door);
            if (!opened.success) throw new Error(`Could not open the fortress ladder-room door: ${opened.message}`);
        }
        await walk(ctx, toX, z, 0);
    };
    const climbEavesdropLadder = async () => {
        const player = sdk.getState()?.player;
        if (player && player.worldX <= 3021) await crossLadderRoomDoor('east');
        await walk(ctx, 3023, 3514, 0);
        await changeFloor(ctx, 'up', 3023, 3513, 1, { requireReachable: true });
    };
    const leaveGrillRoute = async () => {
        if (floor() === 0) await climb('up', 3021, 3510);
        if (floor() === 1) {
            const here = sdk.getState()?.player;
            if (here && here.worldX <= 3025 && here.worldZ <= 3512) {
                await walk(ctx, 3025, 3511, 0);
                const door = (await sdk.scanNearbyLocs(3)).find(loc => loc.id === 2339 &&
                    loc.x === 3025 && loc.z === 3511 && loc.level === 1);
                if (door) {
                    const opened = await bot.interactLoc(door, /^open$/i);
                    if (!opened.success) throw new Error(`Could not open the grill-room door: ${opened.message}`);
                }
                await walk(ctx, 3026, 3511, 0);
            }
            // The wall south of the directional ladder blocks the two-tile approach.
            await walk(ctx, 3026, 3513, 0);
            await walk(ctx, 3025, 3514, 0);
            await changeFloor(ctx, 'up', 3025, 3513, 0, { requireReachable: true });
        }
        await walk(ctx, 3023, 3514, 0);
        await changeFloor(ctx, 'down', 3023, 3513, 0, { requireReachable: true });
        await crossLadderRoomDoor('west');
        await climb('up', 3017, 3516); await climb('down', 3016, 3519);
        await climb('down', 3015, 3519);
        await passage(2341, /^push$/i, 3016, 3517);
    };
    const leaveFortress = async () => {
        if ((sdk.getState()?.player?.worldX ?? 0) >= 3020) {
            const opened = await bot.interactLoc(await loc(2338), /^open$/i);
            if (!opened.success) throw new Error(opened.message);
            await sdk.waitForCondition(s => !!s.player && s.player.level === 0 && s.player.worldX < 3020, 6_000);
        }
        await walk(ctx, 3017, 3515, 0);
        await passage(2337, /^open$/i, 3016, 3515);
        await sdk.waitForCondition(s => !!s.player && s.player.level === 0 && s.player.worldZ <= 3514, 6_000);
    };
    const leaveSabotageRoute = async () => {
        if (floor() === 1) {
            await passage(2341, /^push$/i, 3030, 3510);
            await climb('down', 3022, 3518);
        }
        await leaveFortress();
    };
    const story = () => journalText(ctx, journal, /^black knight.s fortress$/i);
    const player = sdk.getState()?.player;
    const nearEavesdropLadder = player?.level === 1 && player.worldX >= 3021 && player.worldX <= 3023 &&
        player.worldZ >= 3513 && player.worldZ <= 3516;
    const nearGrillReturn = player?.level === 1 && player.worldX >= 3024 && player.worldX <= 3027 &&
        player.worldZ >= 3510 && player.worldZ <= 3515;
    const nearCabbageHole = player?.level === 1 && player.worldX >= 3029 && player.worldX <= 3032 &&
        player.worldZ >= 3507 && player.worldZ <= 3512;
    const nearBanquetExit = player?.level === 0 && player.worldX >= 3016 && player.worldX <= 3024 &&
        player.worldZ >= 3515 && player.worldZ <= 3519;
    const savedPage = (nearEavesdropLadder || nearGrillReturn || nearCabbageHole || nearBanquetExit) && readQuest(ctx, journal) === 'in-progress'
        ? await story() : undefined;
    const resumeEavesdrop = nearEavesdropLadder && savedPage !== undefined && !/eavesdropped on a witch|sabotaged the witch.s potion/i.test(savedPage);
    const resumeReturn = nearGrillReturn && savedPage !== undefined &&
        /eavesdropped on a witch/i.test(savedPage) && !sabotaged.test(savedPage);
    const resumeSabotage = nearCabbageHole && savedPage !== undefined &&
        (/eavesdropped on a witch/i.test(savedPage) || sabotaged.test(savedPage));
    const resumeExit = nearBanquetExit && savedPage !== undefined && sabotaged.test(savedPage);
    const resumingInside = resumeEavesdrop || resumeReturn || resumeSabotage || resumeExit;
    if (!resumingInside) {
        if (player && Math.abs(player.worldX - 2960) < 15 && Math.abs(player.worldZ - 3338) < 15) await castleExit();
        if (floor() > 0) throw new Error('A Pirate is upstairs away from Sir Amik’s tower. Exit the fortress before retrying.');
        questPhase('fortress-briefing');
        if (readQuest(ctx, journal) === 'not-started') { questLog('quest-start', { quest }); await sirAmik(); }
    }
    const page = savedPage ?? await story();
    const hasCabbage = () => sdk.getInventory().some(item => item.id === cabbageId);
    const gatherCabbage = async () => {
        await walk(ctx, 3053, 3295, 2);
        await bot.interactLoc(await questLoc(ctx, /^cabbage$/i, /^pick$/i), /^pick$/i);
        await sdk.waitForCondition(hasCabbage, 8000);
    };
    questPhase('fortress-infiltration');
    if (!sabotaged.test(page)) {
        if (!resumingInside) {
            const needsGear = (name: string) => !sdk.findInventoryItem(itemNamed(name)) && !sdk.findEquipmentItem(itemNamed(name));
            const needChain = needsGear(chain);
            const needHelm = needsGear(helm);
            const coins = (needChain ? 300 : 0) + (needHelm ? 50 : 0);
            await prepareQuestStep(ctx, {
                keep, slots: Number(needChain) + Number(needHelm) + Number(!hasCabbage()) +
                    Number(coins > 0 && !sdk.findInventoryItem(/^coins$/i)),
                withdraw: coins ? [{ name: 'Coins', count: coins }] : [], bank: [2946, 3369],
            });
            if (needChain) {
                await walk(ctx, 2973, 3312, 3); await buyQuestSupply(ctx, /^wayne$/i, chain, 300);
            }
            if (needHelm) {
                await walk(ctx, 3076, 3429, 3); await buyQuestSupply(ctx, /^peksa$/i, helm, 50);
            }
            for (const name of [chain, helm]) {
                if (!sdk.findEquipmentItem(itemNamed(name)) && !(await bot.equipItem(itemNamed(name))).success) throw new Error(`Could not equip ${name}`);
            }
            if (!hasCabbage()) await gatherCabbage();
            await passage(2337, /^open$/i, 3016, 3513);
        }
        questPhase('fortress-eavesdrop');
        if (!/eavesdropped on a witch/i.test(page)) {
            if (resumeEavesdrop) {
                questLog('fortress-eavesdrop-resumed', { x: player?.worldX, z: player?.worldZ, plane: player?.level });
            } else {
                await passage(2341, /^push$/i, 3016, 3516);
                await climb('up', 3015, 3519); await climb('up', 3016, 3519);
                await climb('down', 3017, 3516);
            }
            await climbEavesdropLadder();
            await climb('down', 3025, 3513);
            await passage(2339, /^open$/i, 3025, 3512);
            await climb('down', 3021, 3510);
            await passage(2342, /^listen.at$/i, 3025, 3507);
            if (!/eavesdropped on a witch/i.test(await story())) throw new Error('The journal did not confirm the conversation at the grill');
            await leaveGrillRoute();
        } else if (resumeReturn) {
            questLog('fortress-return-resumed', { x: player?.worldX, z: player?.worldZ, plane: player?.level });
            await leaveGrillRoute();
        }
        questPhase('fortress-sabotage');
        let inCabbageRoom = resumeSabotage;
        if (!hasCabbage()) {
            if (inCabbageRoom) await leaveSabotageRoute();
            else await passage(2337, /^open$/i, 3016, 3514);
            await prepareQuestStep(ctx, { slots: 1, keep, bank: [2946, 3369] });
            await gatherCabbage();
            await passage(2337, /^open$/i, 3016, 3513);
            inCabbageRoom = false;
        }
        if (!inCabbageRoom) {
            await passage(2338, /^open$/i, 3019, 3515, [/i don.t care.*going in anyway/i]);
            await climb('up', 3022, 3518);
            await passage(2341, /^push$/i, 3030, 3511);
        }
        const cabbage = sdk.getInventory().find(i => i.id === cabbageId);
        if (!cabbage) throw new Error('Missing ordinary cabbage');
        const used = await bot.useItemOnLoc(cabbage, await loc(2336));
        if (!used.success) throw new Error(used.message);
        // The game consumes the cabbage before the delayed quest update.
        try {
            await sdk.waitForCondition(state => !!state.dialog?.isOpen &&
                /successfully sabotaged/i.test(state.dialog.text ?? ''), 8_000);
        } catch (error) {
            if (!(error instanceof Error) || error.message !== 'waitForCondition timed out') throw error;
        }
        await continueDialog(ctx);
        if (!sabotaged.test(await story())) throw new Error('The journal did not confirm the weapon was sabotaged');
        await leaveSabotageRoute();
    } else if (resumeSabotage || resumeExit) {
        questPhase('fortress-sabotage-exit');
        await leaveSabotageRoute();
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

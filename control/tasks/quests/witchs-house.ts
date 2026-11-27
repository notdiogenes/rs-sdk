import { auditEnabled, auditEvent, auditFrame } from '../../../sdk/audit-trace';
import { runScript } from '../../../sdk/runner';
import { bankForQuest, buyQuestSupply, changeFloor, continueDialog, equipQuestSword, groundItem, journalText, questLoc, questLog, questPhase, waitForQuestJournal, readQuest, talkAt, walk, type QuestContext } from './shared';

const quest = "Witch's House";
const journal = 7351;
const supply = ['Leather gloves', 'Cheese', 'Door key', 'Magnet', 'Diary', 'Key', 'Ball', 'Adamant longsword'];

async function locById({ sdk }: QuestContext, id: number) {
    const loc = (await sdk.scanNearbyLocs(10)).find(candidate => candidate.id === id);
    if (!loc) throw new Error(`Witch's House location ${id} was not in view`);
    return loc;
}

const result = await runScript(async ctx => {
    const { bot, sdk } = ctx;
    await sdk.waitForReady();
    questPhase('quest-journal-preflight');
    await waitForQuestJournal(ctx, journal, 'available', 15_000);
    questPhase('quest-prepare');
    if (readQuest(ctx, journal) === 'complete') { questLog('quest-already-complete', { quest }); return; }
    const has = (id: number) => sdk.getInventory().find(item => item.id === id);
    const boy = () => talkAt(ctx, 2928, 3456, /^boy$/i, [/what.s the matter/i, /i.ll see what i can do/i]);
    const descendDiary = async () => { if ((sdk.getState()?.player?.level ?? 0) === 1) await changeFloor(ctx, 'down', 2906, 3470); };
    const exitCellar = async () => {
        if ((sdk.getState()?.player?.worldZ ?? 0) >= 9800) {
            await walk(ctx, 2907, 9876, 2); await changeFloor(ctx, 'up', 2907, 9876);
        }
    };
    await exitCellar();
    await descendDiary();
    await bankForQuest(ctx, [...supply.map(name => ({name,count:1})), {name:'Coins',count:30}], [2946,3369]);
    questPhase('witch-meet-boy');
    if (readQuest(ctx, journal) === 'not-started') { questLog('quest-start', { quest }); await boy(); }
    if (has(2407)) {
        await boy();
    } else {
        let text = await journalText(ctx, journal, /^witch.s house$/i);
        const unlocked = () => /unlock the back door|shapeshifter.*dead/i.test(text);
        questPhase('witch-gather-supplies');
        if (!unlocked()) {
            if (!has(1059) && !sdk.getEquipment().some(i => i.id === 1059)) {
                await walk(ctx, 3204, 3417, 3);
                await buyQuestSupply(ctx, /^thessalia$/i, 'Leather gloves', 12);
            }
            if (!has(1985)) {
                await walk(ctx, 3014, 3204, 3);
                await buyQuestSupply(ctx, /^wydin$/i, 'Cheese', 8);
            }
        }
        const enterHouse = async () => {
            await walk(ctx, 2899, 3474, 1);
            if (!has(2409)) {
                await bot.interactLoc(await locById(ctx, 2867), 1);
                await continueDialog(ctx);
                if (!has(2409)) throw new Error('Could not find the key under the pot');
            }
            await bot.useItemOnLoc(has(2409)!, await locById(ctx, 2861));
            await walk(ctx, 2904, 3472, 1);
        };
        questPhase('witch-enter-house');
        await enterHouse();
        if (!unlocked()) {
            questPhase('witch-get-magnet');
            if (!has(2410)) {
                if (!sdk.getEquipment().some(i => i.id === 1059)) await bot.equipItem(/^leather gloves$/i);
                await walk(ctx, 2907, 3476, 2);
                await changeFloor(ctx, 'down', 2907, 3476);
                await walk(ctx, 2903, 9873, 0);
                const gate = await locById(ctx, 2866);
                await bot.interactLoc(gate, /^open$/i);
                await walk(ctx, 2899, 9873, 1);
                const closed = (await sdk.scanNearbyLocs(6)).find(loc => loc.id === 2868);
                if (closed) await bot.interactLoc(closed, /^open$/i);
                const open = await locById(ctx, 2869);
                await bot.interactLoc(open, /^search$/i);
                await continueDialog(ctx);
                if (!has(2410)) throw new Error('The cupboard did not yield a magnet');
                await walk(ctx, 2901, 9873, 0);
                const insideGate = (await sdk.scanNearbyLocs(4)).find(loc => (loc.id === 2865 || loc.id === 2866)
                    && loc.optionsWithIndex.some(o => /^open$/i.test(o.text)));
                if (insideGate) await bot.interactLoc(insideGate, /^open$/i);
                await exitCellar();
            }
            questPhase('witch-unlock-garden');
            await walk(ctx, 2902, 3466, 1);
            await bot.useItemOnLoc(/^cheese$/i, await locById(ctx, 2870));
            await continueDialog(ctx);
            const mouse = sdk.getNearbyNpcs().find(n => n.id === 901);
            if (!mouse) throw new Error('The mouse did not appear at the mouse hole');
            await bot.useItemOnNpc(/^magnet$/i, mouse);
            await continueDialog(ctx);
            text = await journalText(ctx, journal, /^witch.s house$/i);
            if (!unlocked()) throw new Error('The journal did not confirm the garden door was unlocked');
        }
        questPhase('witch-read-diary');
        if (!has(2408)) {
            await walk(ctx, 2906, 3469, 2); await changeFloor(ctx, 'up', 2906, 3469);
            await groundItem(ctx, /^diary$/i, 2900, 3473);
            await descendDiary();
        }
        const diary = has(2408);
        if (!diary) throw new Error('Missing the Witch’s diary');
        await sdk.sendUseItem(diary.slot, diary.optionsWithIndex?.find(o => /^read$/i.test(o.text))?.opIndex ?? 1);
        await sdk.waitForTicks(2);
        await bot.closeInterface();
        await equipQuestSword(ctx);

        const caught = () => {
            const p = sdk.getState()?.player;
            return !!p && p.worldX >= 2927 && p.worldX <= 2931 && p.worldZ >= 3454 && p.worldZ <= 3457;
        };
        const garden = async () => {
            await walk(ctx, 2902, 3466, 1);
            await bot.interactLoc(await locById(ctx, 2862), /^open$/i);
            await walk(ctx, 2901, 3465, 0);
        };
        const gardenState = () => {
            const witch = sdk.getNearbyNpcs().find(npc => npc.name.toLowerCase() === 'witch');
            return { ...auditFrame(sdk.getState()), witch: witch && { id: witch.id, x: witch.x, z: witch.z } };
        };
        const gardenRoute = async (points: Array<[number, number]>) => {
            for (const [x,z] of points) {
                if (caught()) throw new Error('The witch spotted A Pirate in the garden');
                const before = auditEnabled ? gardenState() : undefined;
                const began = performance.now();
                let arrived = false;
                try {
                    await walk(ctx, x, z, 0);
                    arrived = true;
                } finally {
                    if (auditEnabled) auditEvent('check', 'garden-leg', {
                        outcome: arrived && !caught() ? 'complete' : 'failed', destination: { x, z },
                        elapsedMs: Math.round(performance.now() - began), before, after: gardenState(),
                    });
                }
            }
        };
        for (let attempt=0; attempt<5 && !has(2407); attempt++) {
            try {
                if (caught()) await enterHouse();
                auditEvent('phase', 'garden-crossing', { strategy: 'direct-waypoints' });
                auditEvent('milestone', 'garden-attempt', { attempt: attempt + 1, strategy: 'direct-waypoints' });
                await garden();
                await gardenRoute([[2901,3460],[2933,3460],[2933,3466],[2912,3466],[2912,3467],[2911,3469]]);
                if (!has(2411)) {
                    await bot.interactLoc(await locById(ctx, 2864), /^check$/i);
                    await continueDialog(ctx);
                }
                if (!has(2411)) throw new Error('The fountain did not yield the shed key');
                await gardenRoute([[2912,3467],[2912,3466],[2933,3466],[2933,3463]]);
                auditEvent('milestone', 'garden-crossed', { attempt: attempt + 1, strategy: 'direct-waypoints' });
                auditEvent('phase', 'shed-fight');
                await bot.useItemOnLoc(has(2411)!, await locById(ctx, 2863));
                for (let fight=0; fight<28 && !has(2407); fight++) {
                    const player = sdk.getState()?.player;
                    if (player?.isDead || (player?.hp ?? 0) < 20) throw new Error('Too little Hitpoints to continue the experiment fight');
                    const npc = sdk.getNearbyNpcs().find(candidate => candidate.id >= 897 && candidate.id <= 900);
                    if (npc && !player?.combat.inCombat) await bot.attack(npc);
                    else if (!npc) {
                        const ball = (await sdk.scanGroundItems(10)).find(item => item.id === 2407);
                        if (ball) await bot.pickupItem(ball);
                        await continueDialog(ctx);
                    }
                    await sdk.waitForTicks(4);
                }
                if (!has(2407)) throw new Error('The experiment fight did not yield the boy’s ball');
            } catch (error) {
                if (!caught()) throw error;
                auditEvent('phase', 'garden-crossing');
                auditEvent('setback', 'witch-caught', { attempt: attempt + 1, strategy: 'direct-waypoints', after: auditFrame(sdk.getState()) });
                if (attempt === 4) throw error;
                questLog('quest-retry', { quest, reason: 'Witch spotted the bot' });
            }
        }
        await boy();
    }
    await waitForQuestJournal(ctx, journal, 'complete', 12_000);
    questLog('quest-complete', { quest, evidence: 'journal', questPoints: sdk.getState()?.questPoints });
}, { printState: false, timeout: 1_200_000 });

if (!result.success) {
    questLog('quest-failed', { quest, error: result.error?.message });
    process.exitCode = 1;
}

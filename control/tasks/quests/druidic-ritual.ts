import { runScript } from '../../../sdk/runner';
import { bankForQuest, changeFloor, equipQuestSword, itemNamed, journalText, lootFromNpc, questLoc, questLog, questPhase, waitForQuestJournal, readQuest, talkAt, walk } from './shared';

const quest = 'Druidic Ritual';
const journal = 7355;
const meats = [
    ['Raw bear meat', 'Enchanted bear', /^bear$/i, 3159, 3233],
    ['Raw rat meat', 'Enchanted rat', /^giant rat$/i, 3206, 3175],
    ['Raw chicken', 'Enchanted chicken', /^chicken$/i, 3228, 3298],
    ['Raw beef', 'Enchanted beef', /^cow$/i, 3243, 3295],
] as const;

const result = await runScript(async ctx => {
    const { bot, sdk } = ctx;
    await sdk.waitForReady();
    questPhase('quest-journal-preflight');
    await waitForQuestJournal(ctx, journal, 'available', 15_000);
    questPhase('quest-prepare');
    if (readQuest(ctx, journal) === 'complete') { questLog('quest-already-complete', { quest }); return; }
    const dungeonExit = async () => {
        if ((sdk.getState()?.player?.worldZ ?? 0) < 9700) return;
        await walk(ctx, 2884, 9797, 3);
        await changeFloor(ctx, 'up', 2884, 9797);
    };
    const townExit = async () => {
        if ((sdk.getState()?.player?.level ?? 0) === 1) await changeFloor(ctx, 'down', 2898, 3428);
    };
    const kaqemeex = () => talkAt(ctx, 2924, 3486, /^kaqemeex$/i, [/in search of a quest/i, /i will try and help/i]);
    const sanfew = async () => {
        await walk(ctx, 2898, 3428, 2);
        await changeFloor(ctx, 'up', 2898, 3428);
        await talkAt(ctx, 2897, 3426, /^Sanfew$/i, [/sent to help purify/i, /i.ll do that then/i, /i.ll get on with it/i]);
        await townExit();
    };
    await dungeonExit();
    await townExit();
    await bankForQuest(ctx, [{ name: 'Adamant longsword', count: 1 },
        ...meats.flatMap(([raw, charged]) => [raw, charged].map(name => ({ name, count: 1 }))),
    ], [2946, 3369]);
    questPhase('druidic-start');
    if (readQuest(ctx, journal) === 'not-started') { questLog('quest-start', { quest }); await kaqemeex(); }
    let text = await journalText(ctx, journal, /^druidic ritual$/i);
    questPhase('druidic-sanfew-briefing');
    if (/should speak to Sanfew/i.test(text)) {
        await sanfew();
        text = await journalText(ctx, journal, /^druidic ritual$/i);
    }
    if (!/gave them to Sanfew/i.test(text)) {
        await equipQuestSword(ctx);
        const has = (name: string) => !!sdk.findInventoryItem(itemNamed(name));
        questPhase('druidic-gather-meats');
        for (const [raw, charged, target, x, z] of meats) {
            if (!has(charged) && !has(raw)) await lootFromNpc(ctx, itemNamed(raw), target, x, z);
        }
        questPhase('druidic-enchant-meats');
        if (meats.some(([, charged]) => !has(charged))) {
            await walk(ctx, 2884, 3397, 2);
            await changeFloor(ctx, 'down', 2884, 3397);
            await walk(ctx, 2888, 9831, 1);
            for (let attempt = 0; attempt < 7; attempt++) {
                const cauldron = await questLoc(ctx, /^cauldron of thunder$/i);
                if (cauldron.reachable) break;
                const door = await questLoc(ctx, /door/i, /^open$/i);
                await bot.interactLoc(door, /^open$/i);
                if (sdk.getState()?.player?.combat.inCombat) {
                    await sdk.waitForCondition(s => !!s.player && !s.player.combat.inCombat, 25_000).catch(() => null);
                }
                await sdk.waitForTicks(2);
            }
            for (const [raw, charged] of meats) {
                if (has(charged)) continue;
                const cauldron = await questLoc(ctx, /^cauldron of thunder$/i);
                await bot.useItemOnLoc(itemNamed(raw), cauldron);
                await sdk.waitForCondition(() => has(charged), 12_000);
                questLog('quest-ingredient', { quest, item: charged });
            }
            await dungeonExit();
        }
        questPhase('druidic-deliver-meats');
        await sanfew();
    }
    questPhase('druidic-report');
    await kaqemeex();
    await waitForQuestJournal(ctx, journal, 'complete', 12_000);
    questLog('quest-complete', { quest, evidence: 'journal', questPoints: sdk.getState()?.questPoints });
}, { printState: false, timeout: 1_200_000 });

if (!result.success) {
    questLog('quest-failed', { quest, error: result.error?.message });
    process.exitCode = 1;
}

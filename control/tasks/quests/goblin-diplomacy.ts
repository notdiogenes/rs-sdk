import { runScript } from '../../../sdk/runner';
import { prepareQuestStep, equipQuestSword, groundItem, itemNamed, journalText, lootFromNpc, questLoc, questLog, questPhase, waitForQuestJournal, readQuest, talkAt, useTogether, walk } from './shared';

const quest = 'Goblin Diplomacy';
const journal = 7338;
const armor = 'Goblin mail';
const orange = 'Orange goblin mail';
const blue = 'Blue goblin mail';

const result = await runScript(async ctx => {
    const { bot, sdk } = ctx;
    await sdk.waitForReady();
    questPhase('quest-journal-preflight');
    await waitForQuestJournal(ctx, journal, 'available', 15_000);
    questPhase('quest-prepare');
    if (readQuest(ctx, journal) === 'complete') { questLog('quest-already-complete', { quest }); return; }
    questPhase('goblin-start');
    if (readQuest(ctx, journal) === 'not-started') {
        questLog('quest-start', { quest });
        await talkAt(ctx, 3045, 3257, /^bartender$/i, [/not very busy in here today/i]);
    }
    const count = (name: string) => sdk.countInventoryItems(itemNamed(name));
    const prepare = (slots: number, coins = 0) => prepareQuestStep(ctx, {
        slots: slots + Number(coins > 0 && !count('Coins')),
        keep: /^(?:coins|adamant longsword|(?:orange |blue )?goblin mail|(?:red|yellow|blue|orange) dye|redberries|onion|woad leaf)$/i,
        withdraw: coins ? [{ name: 'Coins', count: coins }] : [],
    });
    const dye = async (color: string, input: string, amount: number, gather: () => Promise<void>, extraCoins = 0) => {
        if (count(color + ' dye')) return;
        const missing = Math.max(0, amount - count(input));
        await prepare(missing || 1, 5 + (missing ? extraCoins : 0));
        if (missing) await gather();
        await talkAt(ctx, 3086, 3259, /^aggie$/i, [/can you make dyes/i, new RegExp('what do you need to make ' + color, 'i'),
            new RegExp('make me some ' + color + ' dye', 'i')]);
        if (!count(color + ' dye')) throw new Error(`Aggie did not provide ${color} dye`);
    };
    for (let attempt = 0; attempt < 8 && readQuest(ctx, journal) !== 'complete'; attempt++) {
        const text = await journalText(ctx, journal, /^goblin diplomacy$/i);
        const requested = /i should see if they liked/i.test(text) ? undefined
            : /i gave some blue/i.test(text) ? armor
            : /i gave some orange/i.test(text) ? blue
            : /bring the goblins some orange/i.test(text) ? orange : undefined;
        if (requested && !count(requested)) {
            questPhase('goblin-gather-dyes');
            if (requested === orange && !count('Orange dye')) {
                await dye('Red', 'Redberries', 3, () => groundItem(ctx, /^redberries$/i, 3271, 3369, 3));
                await dye('Yellow', 'Onion', 2, async () => {
                    await walk(ctx, 3188, 3267);
                    for (let n = 0; n < 8 && count('Onion') < 2; n++) {
                        const onion = await questLoc(ctx, /^onion$/i, /^pick$/i);
                        await bot.interactLoc(onion, /^pick$/i);
                        await sdk.waitForTicks(3);
                    }
                });
                await useTogether(ctx, /^red dye$/i, /^yellow dye$/i);
                await sdk.waitForCondition(() => count('Orange dye') > 0, 8000);
            }
            if (requested === blue) await dye('Blue', 'Woad leaf', 2, () => talkAt(ctx, 3027, 3379, /^wyson the gardener$/i,
                [/looking for woad leaves/i, /20 coins/i]), 20);
            if (!count(armor)) {
                questPhase('goblin-gather-armour');
                await prepare(1);
                await equipQuestSword(ctx);
                await lootFromNpc(ctx, itemNamed(armor), /^goblin$/i, 2958, 3507);
            }
            if (requested !== armor) {
                questPhase('goblin-dye-armour');
                await useTogether(ctx, requested === orange ? /^orange dye$/i : /^blue dye$/i, itemNamed(armor));
                await sdk.waitForCondition(() => count(requested) > 0, 8000);
            }
        }
        questPhase('goblin-deliver');
        await talkAt(ctx, 2957, 3510, /^general wartface$/i, [/pick an armour colour/i]);
    }
    await waitForQuestJournal(ctx, journal, 'complete', 12_000);
    questLog('quest-complete', { quest, evidence: 'journal', questPoints: sdk.getState()?.questPoints });
}, { printState: false, timeout: 1_200_000 });

if (!result.success) {
    questLog('quest-failed', { quest, error: result.error?.message });
    process.exitCode = 1;
}

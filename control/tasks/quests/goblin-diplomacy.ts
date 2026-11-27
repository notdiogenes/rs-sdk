import { runScript } from '../../../sdk/runner';
import { bankForQuest, equipQuestSword, groundItem, itemNamed, journalText, lootFromNpc, questLoc, questLog, readQuest, talkAt, useTogether, walk } from './shared';

const quest = 'Goblin Diplomacy';
const journal = 7338;
const armor = 'Goblin mail';
const orange = 'Orange goblin mail';
const blue = 'Blue goblin mail';

const result = await runScript(async ctx => {
    const { bot, sdk } = ctx;
    await sdk.waitForReady();
    await sdk.waitForCondition(s => !!s.questJournal?.[journal], 15_000);
    if (readQuest(ctx, journal) === 'complete') { questLog('quest-already-complete', { quest }); return; }
    await bankForQuest(ctx, [
        {name:'Coins',count:40}, {name:'Adamant longsword',count:1}, {name:armor,count:3}, {name:orange,count:1}, {name:blue,count:1},
        {name:'Redberries',count:3}, {name:'Onion',count:2}, {name:'Woad leaf',count:2},
        ...['Red dye', 'Yellow dye', 'Blue dye', 'Orange dye'].map(name => ({ name, count: 1 })),
    ]);
    if (readQuest(ctx, journal) === 'not-started') {
        questLog('quest-start', { quest });
        await talkAt(ctx, 3045, 3257, /^bartender$/i, [/not very busy in here today/i]);
    }
    const text = await journalText(ctx, journal, /^goblin diplomacy$/i);
    const count = (name: string) => sdk.countInventoryItems(itemNamed(name));
    const finishedHandoff = /i should see if they liked/i.test(text);
    const needOrange = !finishedHandoff && !/i gave some orange/i.test(text);
    const needBlue = !finishedHandoff && !/i gave some blue/i.test(text);
    const makeOrange = needOrange && !count(orange);
    const makeBlue = needBlue && !count(blue);
    const dye = async (color: string, input: string, amount: number, gather: () => Promise<void>) => {
        if (count(color + ' dye')) return;
        if (count(input) < amount) await gather();
        await talkAt(ctx, 3086, 3259, /^aggie$/i, [/can you make dyes/i, new RegExp('what do you need to make ' + color, 'i'),
            new RegExp('make me some ' + color + ' dye', 'i')]);
        if (!count(color + ' dye')) throw new Error(`Aggie did not provide ${color} dye`);
    };
    if (makeOrange && !count('Orange dye')) {
        await dye('Red', 'Redberries', 3, () => groundItem(ctx, /^redberries$/i, 3271, 3369, 3));
        await dye('Yellow', 'Onion', 2, async () => {
            await walk(ctx, 3188, 3267);
            for (let n=0; n<8 && count('Onion')<2; n++) {
                const onion = await questLoc(ctx, /^onion$/i, /^pick$/i);
                await bot.interactLoc(onion, /^pick$/i);
                await sdk.waitForTicks(3);
            }
        });
        await useTogether(ctx, /^red dye$/i, /^yellow dye$/i);
        await sdk.waitForCondition(() => count('Orange dye') > 0, 8000);
    }
    if (makeBlue) await dye('Blue', 'Woad leaf', 2, () => talkAt(ctx, 3027, 3379, /^wyson the gardener$/i,
        [/looking for woad leaves/i, /20 coins/i]));
    const needed = finishedHandoff ? 0 : 1 + Number(makeOrange) + Number(makeBlue);
    await equipQuestSword(ctx);
    if (count(armor) < needed) await lootFromNpc(ctx, itemNamed(armor), /^goblin$/i, 2958, 3507, needed);
    if (makeOrange) {
        await useTogether(ctx, /^orange dye$/i, itemNamed(armor));
        await sdk.waitForCondition(() => count(orange) > 0, 8000);
    }
    if (makeBlue) {
        await useTogether(ctx, /^blue dye$/i, itemNamed(armor));
        await sdk.waitForCondition(() => count(blue) > 0, 8000);
    }
    for (let attempt = 0; attempt < 5 && readQuest(ctx, journal) !== 'complete'; attempt++) {
        await talkAt(ctx, 2957, 3510, /^general wartface$/i, [/pick an armour colour/i]);
    }
    await sdk.waitForCondition(s => s.questJournal?.[journal] === 'complete', 12_000);
    questLog('quest-complete', { quest, evidence: 'journal', questPoints: sdk.getState()?.questPoints });
}, { printState: false, timeout: 1_200_000 });

if (!result.success) {
    questLog('quest-failed', { quest, error: result.error?.message });
    process.exitCode = 1;
}

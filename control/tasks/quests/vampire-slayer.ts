import { runScript } from '../../../sdk/runner';
import { bankForQuest, buyQuestSupply, changeFloor, equipQuestSword, questLoc, questLog, readQuest, talkAt, walk } from './shared';

const quest = 'Vampire Slayer';
const journal = 7347;
const stake = /^stake$/i;
const hammer = /^hammer$/i;
const beer = /^beer$/i;

const result = await runScript(async ctx => {
    const { sdk, bot } = ctx;
    await sdk.waitForReady();
    await sdk.waitForCondition(s => !!s.questJournal?.[journal], 15_000);
    if (readQuest(ctx, journal) === 'complete') { questLog('quest-already-complete', { quest }); return; }
    const leaveCrypt = async () => {
        if ((sdk.getState()?.player?.worldZ ?? 0) >= 9700) {
            await walk(ctx, 3077, 9768, 2);
            await changeFloor(ctx, 'up', 3077, 9768);
        }
    };
    const has = (item: RegExp) => !!sdk.findInventoryItem(item);
    const crypt = (sdk.getState()?.player?.worldZ ?? 0) >= 9700;
    const safePack = sdk.getInventory().every(i => /^(stake|hammer|coins|adamant longsword)$/i.test(i.name));
    if (!crypt || !has(stake) || !has(hammer) || !safePack) {
        await leaveCrypt();
        await bankForQuest(ctx, [
            { name: 'Stake', count: 1 }, { name: 'Hammer', count: 1 }, { name: 'Beer', count: 1 },
            { name: 'Coins', count: 10 }, { name: 'Adamant longsword', count: 1 },
        ]);
        if (readQuest(ctx, journal) === 'not-started') {
            questLog('quest-start', { quest });
            await talkAt(ctx, 3098, 3268, /^morgan$/i, [/up for an adventure/i]);
        }
        if (!has(hammer)) {
            await walk(ctx, 3218, 3415, 3);
            await buyQuestSupply(ctx, /^shop (?:keeper|assistant)$/i, 'Hammer', 8);
        }
        if (!has(stake)) {
            await walk(ctx, 3277, 3490, 3);
            if (!has(beer)) await talkAt(ctx, 3277, 3490, /^bartender$/i, [/i.ll have a beer please/i]);
            if (!has(beer)) throw new Error('The Jolly Boar bartender did not provide beer');
            for (let attempt = 0; attempt < 2 && !has(stake); attempt++) {
                await talkAt(ctx, 3277, 3492, /^dr\.? harlow$/i, [/morgan needs your help/i, /^ok mate/i]);
            }
            if (!has(stake)) throw new Error('Dr Harlow did not provide a stake');
            questLog('quest-ingredient', { quest, item: 'Stake' });
        }
        await equipQuestSword(ctx);
        await walk(ctx, 3115, 3357, 2);
        await changeFloor(ctx, 'down', 3115, 3357);
        await walk(ctx, 3077, 9774, 2);
    }
    for (let attempt = 0; attempt < 10 && readQuest(ctx, journal) !== 'complete'; attempt++) {
        const count = sdk.findNearbyNpc(/^count draynor$/i);
        const player = sdk.getState()?.player;
        if (player?.isDead || (player?.hp ?? 0) < 20) throw new Error('A Pirate became too low on Hitpoints in the crypt');
        if (count) {
            // A combat flag can mean the vampire is hitting us while
            // auto-retaliation is off. Explicitly attack the quest target.
            const attack = await bot.attack(count);
            if (!attack.success && attempt % 3 === 0) questLog('quest-retry', { quest, reason: attack.message });
        }
        else if (!count) {
            const closed = await questLoc(ctx, /coffin/i, /^open$/i).catch(() => null);
            if (closed) await bot.interactLoc(closed, /^open$/i);
        }
        await sdk.waitForCondition(s => s.questJournal?.[journal] === 'complete', 8000).catch(() => null);
    }
    await sdk.waitForCondition(s => s.questJournal?.[journal] === 'complete', 6000);
    await leaveCrypt();
    questLog('quest-complete', { quest, evidence: 'journal', questPoints: sdk.getState()?.questPoints });
}, { printState: false, timeout: 1_200_000 });

if (!result.success) {
    questLog('quest-failed', { quest, error: result.error?.message });
    process.exitCode = 1;
}

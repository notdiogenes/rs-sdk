import { auditEvent, auditOperation } from '../../../sdk/audit-trace';
import { runScript } from '../../../sdk/runner';
import {
    buyQuestSupply, changeFloor, journalText, prepareQuestStep, questLoc, questLog, questPhase,
    readQuest, talkAt, waitForQuestJournal, walk,
} from './shared';

const quest = 'Sheep Shearer';
const journal = 7344;
const fred = /^fred the farmer$/i;
const wool = /^wool$/i;
const ball = /^ball of wool$/i;
const shears = /^shears$/i;

const result = await runScript(async ctx => {
    const { bot, sdk } = ctx;
    const balls = () => sdk.countInventoryItems(ball);
    const raw = () => sdk.countInventoryItems(wool);
    await sdk.waitForReady();
    await waitForQuestJournal(ctx, journal, 'available', 15000);
    if (readQuest(ctx, journal) === 'complete') return;
    if (readQuest(ctx, journal) === 'not-started') {
        questPhase('sheep-shearer-start');
        await talkAt(ctx, 3189, 3273, fred, [/looking for a quest/i, /yes okay.*can do that/i], 10000);
    }
    const page = await journalText(ctx, journal, /^sheep shearer$/i);
    const remaining = Number(/collect (\d+) more balls of wool/i.exec(page)?.[1]);
    if (!Number.isInteger(remaining) || remaining < 1 || remaining > 20) throw new Error('Could not read the remaining wool from Fred’s journal');
    questPhase('sheep-shearer-supplies', { remaining });
    await prepareQuestStep(ctx, {
        slots: Math.max(0, remaining - raw() - balls()) + 1, keep: /^(?:wool|ball of wool|shears|coins)$/i,
        withdraw: [{ name: 'Ball of wool', count: remaining }, { name: 'Shears', count: 1 }, { name: 'Coins', count: 10 }],
    });
    if (raw() + balls() < remaining) {
        if (!sdk.findInventoryItem(shears)) {
            await walk(ctx, 3211, 3246);
            await buyQuestSupply(ctx, /^shop (?:keeper|assistant)$/i, 'Shears', 6);
        }
        questPhase('sheep-shearer-collect-wool', { remaining });
        await walk(ctx, 3198, 3265, 6);
        let misses = 0;
        while (raw() + balls() < remaining) {
            const sheep = sdk.getNearbyNpcs().filter(n => n.id === 43 && n.reachable !== false)
                .sort((a, b) => a.distance - b.distance)[0];
            const tool = sdk.findInventoryItem(shears);
            if (!tool) throw new Error('No shears in inventory');
            const before = raw();
            if (sheep) await auditOperation('sheep-shearer-shear', 'Gather wool needed for the remaining balls',
                { sheep: sheep.index, before, remaining }, () => sdk.getState(), async () => {
                    const sent = await sdk.sendUseItemOnNpc(tool.slot, sheep.index);
                    if (!sent.success) return false;
                    return !!(await sdk.waitForCondition(() => raw() > before, 5500).catch(() => null));
                }, received => ({ outcome: received ? 'complete' : 'unconfirmed', wool: raw() }));
            if (raw() > before) misses = 0;
            else if (++misses >= 10) throw new Error('Could not collect wool from the nearby sheep');
            else await sdk.waitForTicks(2);
        }
    }
    if (balls() < remaining) {
        questPhase('sheep-shearer-spin-wool');
        await walk(ctx, 3204, 3207, 2);
        await changeFloor(ctx, 'up', 3204, 3207, 1);
        await walk(ctx, 3209, 3212, 2);
        const wheel = await questLoc(ctx, /^spinning wheel$/i);
        while (balls() < remaining) {
            const item = sdk.findInventoryItem(wool);
            if (!item) throw new Error('Ran out of raw wool before spinning enough for Fred');
            const before = balls();
            const spun = await bot.useItemOnLoc(item, wheel);
            await sdk.waitForCondition(() => balls() > before, 6500).catch(() => null);
            auditEvent('check', 'sheep-shearer-spun-wool', { outcome: balls() > before ? 'complete' : 'failed', before, after: balls(), message: spun.message });
            if (balls() <= before) throw new Error(`The spinning wheel did not produce wool: ${spun.message}`);
        }
        await walk(ctx, 3204, 3207, 2);
        await changeFloor(ctx, 'down', 3204, 3207, 1);
    }
    questPhase('sheep-shearer-return-to-fred', { held: balls(), remaining });
    await talkAt(ctx, 3189, 3273, fred, [], 10000);
    await waitForQuestJournal(ctx, journal, 'complete', 30000);
    questLog('quest-complete', { quest, evidence: 'journal', questPoints: sdk.getState()?.questPoints });
}, { printState: false, timeout: 1_800_000 });

if (!result.success) {
    questLog('quest-failed', { quest, error: result.error?.message });
    process.exitCode = 1;
}

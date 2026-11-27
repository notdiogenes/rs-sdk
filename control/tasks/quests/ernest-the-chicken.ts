import { runScript } from '../../../sdk/runner';
import { bankForQuest, changeFloor, continueDialog, groundItem, itemNamed, journalText, questLoc, questLog, readQuest, talkAt, useTogether, walk, type QuestContext } from './shared';

const quest = 'Ernest the Chicken';
const journal = 7339;
const supplies = ['Spade', 'Poison', 'Fish food', 'Poisoned fish food', 'Key', 'Rubber tube', 'Pressure gauge', 'Oil can'];
const levers = { A: [3108, 9745], B: [3118, 9752], C: [3112, 9760], D: [3108, 9767], E: [3097, 9767], F: [3096, 9765] } as const;
type Tile = readonly [number, number];
type Move = { lever: keyof typeof levers; down: boolean } | { from: Tile; to: Tile };
const lever = (name: keyof typeof levers, down: boolean): Move => ({ lever: name, down });
const door = (from: Tile, to: Tile): Move => ({ from, to });

// Door boundaries and lever sequence were checked against the manor's door
// conditions and the rs2b0t Ernest basement reference. The exit resets levers.
const path: Move[] = [
    lever('B', true), lever('A', true), door([3108,9757],[3108,9758]),
    lever('D', true), door([3105,9760],[3104,9760]), door([3102,9758],[3102,9757]),
    lever('B', false), lever('A', false), door([3102,9757],[3102,9758]),
    door([3100,9760],[3099,9760]), door([3097,9762],[3097,9763]),
    lever('F', true), lever('E', true),
    door([3099,9765],[3100,9765]), door([3104,9765],[3105,9765]),
    lever('C', true),
    door([3105,9765],[3104,9765]), door([3100,9765],[3099,9765]),
    lever('E', false), door([3099,9765],[3100,9765]), door([3102,9763],[3102,9762]),
    door([3102,9758],[3102,9757]), door([3100,9755],[3099,9755]),
];

async function move(ctx: QuestContext, step: Move) {
    const { bot, sdk } = ctx;
    if ('lever' in step) {
        const [x, z] = levers[step.lever];
        await walk(ctx, x, z, 2);
        const handle = await questLoc(ctx, itemNamed('Lever ' + step.lever), /^pull$/i);
        for (let n = 0; n < 2; n++) {
            const mark = sdk.getState()?.tick ?? 0;
            await bot.interactLoc(handle, /^pull$/i);
            const text = await sdk.waitForCondition(s => s.gameMessages.some(m => m.tick >= mark &&
                new RegExp('you pull lever ' + step.lever + ' (up|down)', 'i').test(m.text)), 5000);
            if (text.gameMessages.some(m => m.tick >= mark && new RegExp('you pull lever ' + step.lever +
                (step.down ? ' down' : ' up'), 'i').test(m.text))) return;
        }
        throw new Error('Could not set lever ' + step.lever);
    }
    await walk(ctx, step.from[0], step.from[1], 0);
    const [x, z] = step.to;
    const boundary = (await sdk.scanNearbyLocs(4)).find(loc => /^door$/i.test(loc.name) &&
        loc.optionsWithIndex.some(o => /^open$/i.test(o.text)) &&
        ((loc.x === x && loc.z === z) || (loc.x === step.from[0] && loc.z === step.from[1])));
    if (boundary) await bot.interactLoc(boundary, /^open$/i);
    await walk(ctx, x, z, 0);
}

const result = await runScript(async ctx => {
    const { bot, sdk } = ctx;
    await sdk.waitForReady();
    await sdk.waitForCondition(s => !!s.questJournal?.[journal], 15_000);
    if (readQuest(ctx, journal) === 'complete') { questLog('quest-already-complete', { quest }); return; }
    const has = (name: string) => !!sdk.findInventoryItem(itemNamed(name));
    const top = () => sdk.getState()?.player?.level ?? 0;
    const leaveFloors = async () => {
        if (top() === 2) await changeFloor(ctx, 'down', 3105, 3363);
        if (top() === 1) {
            await walk(ctx, 3108, 3364, 2);
            await changeFloor(ctx, 'down', 3108, 3364);
        }
    };
    const enterMidFloor = async () => {
        await walk(ctx, 3108, 3363, 2);
        await changeFloor(ctx, 'up', 3108, 3363);
    };
    const professor = async () => {
        if (top() === 0) await enterMidFloor();
        if (top() === 1) {
            await walk(ctx, 3104, 3362, 2);
            await changeFloor(ctx, 'up', 3104, 3362, 1);
        }
        await talkAt(ctx, 3110, 3367, /^professor oddenstein$/i, [/looking for a guy called ernest/i, /change him back this instant/i]);
        await leaveFloors();
    };
    const player = sdk.getState()?.player;
    const inManor = player && Math.abs(player.worldX - 3110) < 17 && Math.abs(player.worldZ - 3363) < 16;
    const loadoutReady = inManor && readQuest(ctx, journal) === 'in-progress' && !sdk.getEquipment().length &&
        sdk.getInventory().every(item => item.count === 1 && supplies.some(name => itemNamed(name).test(item.name)));
    if (!loadoutReady) {
        await leaveFloors();
        await bankForQuest(ctx, supplies.map(name => ({name,count:1})));
    }
    if (readQuest(ctx, journal) === 'not-started') {
        questLog('quest-start', { quest });
        await talkAt(ctx, 3110, 3330, /^veronica$/i, [/sounds like a quest/i]);
    }
    const text = await journalText(ctx, journal, /^ernest the chicken$/i);
    if (!/oil can|pressure gauge/i.test(text)) await professor();
    else if (top() > 0) await leaveFloors();
    if (!has('Pressure gauge')) {
        await walk(ctx, 3087, 3336, 3);
        const search = async () => {
            await bot.interactLoc(await questLoc(ctx, /^fountain$/i, /^search$/i), /^search$/i);
            await continueDialog(ctx);
        };
        await search();
        if (!has('Pressure gauge')) {
            if (!has('Poisoned fish food')) {
                if (!has('Poison')) await groundItem(ctx, /^poison$/i, 3097, 3366);
                if (!has('Fish food')) {
                    await enterMidFloor();
                    await groundItem(ctx, /^fish food$/i, 3108, 3356);
                    await leaveFloors();
                }
                await useTogether(ctx, /^poison$/i, /^fish food$/i);
                await sdk.waitForCondition(() => has('Poisoned fish food'), 8000);
            }
            await walk(ctx, 3087, 3336, 3);
            await bot.useItemOnLoc(/^poisoned fish food$/i, await questLoc(ctx, /^fountain$/i));
            await sdk.waitForTicks(5);
            await search();
            if (!has('Pressure gauge')) throw new Error('The fountain did not yield the pressure gauge');
        }
        questLog('quest-ingredient', { quest, item: 'Pressure gauge' });
    }
    if (!has('Rubber tube')) {
        if (!has('Key')) {
            await groundItem(ctx, /^spade$/i, 3120, 3359);
            await walk(ctx, 3085, 3360, 3);
            await bot.useItemOnLoc(/^spade$/i, await questLoc(ctx, /^compost heap$/i));
            await sdk.waitForCondition(() => has('Key'), 8000);
        }
        await walk(ctx, 3107, 3367, 2);
        const closet = (await sdk.scanNearbyLocs(7)).find(loc => loc.id === 131);
        if (!closet) throw new Error('Could not find the manor closet door');
        await bot.useItemOnLoc(/^key$/i, closet);
        await groundItem(ctx, /^rubber tube$/i, 3111, 3367);
        await walk(ctx, 3108, 3367, 0);
        const inside = (await sdk.scanNearbyLocs(5)).find(loc => loc.id === 131);
        if (inside) await bot.useItemOnLoc(/^key$/i, inside);
        questLog('quest-ingredient', { quest, item: 'Rubber tube' });
    }
    if (!has('Oil can')) {
        await walk(ctx, 3098, 3358, 0);
        const bookcase = (await sdk.scanNearbyLocs(5)).find(loc => loc.id === 155);
        if (!bookcase) throw new Error('Could not find the secret bookcase');
        await bot.interactLoc(bookcase, /^search$/i);
        await sdk.waitForCondition(s => (s.player?.worldX ?? 9999) < 3097, 9000);
        await walk(ctx, 3092, 3363, 2);
        await changeFloor(ctx, 'down', 3092, 3363);
        const reached: Move[] = [];
        try {
            for (const step of path) {
                await move(ctx, step);
                reached.push(step);
            }
            await groundItem(ctx, /^oil can$/i, 3092, 9755);
            questLog('quest-ingredient', { quest, item: 'Oil can' });
        } finally {
            for (const step of reached.reverse()) {
                await move(ctx, 'lever' in step ? {...step,down:!step.down} : door(step.to,step.from));
            }
        }
        await walk(ctx, 3117, 9755, 2);
        await changeFloor(ctx, 'up', 3117, 9755);
        await walk(ctx, 3096, 3357, 1);
        await bot.interactLoc(await questLoc(ctx, /^lever$/i, /^pull$/i), /^pull$/i);
        await sdk.waitForCondition(s => (s.player?.worldX ?? 0) >= 3098, 9000);
    }
    await professor();
    await sdk.waitForCondition(s => s.questJournal?.[journal] === 'complete', 12_000);
    const exit = (await sdk.scanNearbyLocs(20)).find(loc => loc.id === 136);
    if (exit) await bot.interactLoc(exit, /^open$/i);
    questLog('quest-complete', { quest, evidence: 'journal', questPoints: sdk.getState()?.questPoints });
}, { printState: false, timeout: 1_200_000 });

if (!result.success) {
    questLog('quest-failed', { quest, error: result.error?.message });
    process.exitCode = 1;
}

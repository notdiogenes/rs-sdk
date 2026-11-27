import { auditOperation } from '../../../sdk/audit-trace';
import { continueDialog, questPhase, talkAt, walk, type QuestContext } from './shared';

const fare = 30;
const coins = /^coins$/i;
const banana = /^banana$/i;
const luthas = /^luthas$/i;
const crate = { id: 2072, x: 2943, z: 3151 };
const arrival = { x: 3070, z: 3514 };

function onPortSarimFerry({ worldX, worldZ, level }: { worldX: number; worldZ: number; level: number }) {
    return level === 1 && Math.abs(worldX - 3032) <= 4 && Math.abs(worldZ - 3217) <= 3;
}

function inCrandorCaves({ worldX, worldZ }: { worldX: number; worldZ: number }) {
    return worldX >= 2825 && worldX <= 2890 && worldZ >= 9550 && worldZ <= 9680;
}

async function travelThrough(
    ctx: QuestContext, name: string, intent: string, loc: { id: number; x: number; z: number },
    arrived: (player: NonNullable<ReturnType<QuestContext['sdk']['getState']>>['player']) => boolean,
) {
    const { sdk } = ctx;
    await auditOperation(name, intent, loc, () => sdk.getState(), async () => {
        const action = await sdk.sendInteractLoc(loc.x, loc.z, loc.id, 1);
        if (!action.success) throw new Error(action.message);
        const state = await sdk.waitForCondition(state => !!state.player && arrived(state.player), 12000);
        return state.player;
    }, player => ({ outcome: 'complete', player }));
}

async function earnFare(ctx: QuestContext) {
    const { sdk } = ctx;
    const funds = () => sdk.countInventoryItems(coins);
    if (funds() >= fare) return;

    questPhase('dragon-slayer-return-fare', { fare, held: funds() });
    const employment = /^could you offer me employment/i;
    const alreadyWorking = /^no, the crate isn.t full yet/i;
    const done = /^thank you, i.ll be on my way/i;
    await talkAt(ctx, 2939, 3154, luthas, [employment, alreadyWorking, done], 10000);
    if (funds() >= fare) return;

    await walk(ctx, 2931, 3157, 2);
    const spentTrees = new Set<string>();
    while (sdk.countInventoryItems(banana) < 10) {
        const tree = (await sdk.scanNearbyLocs(12))
            .filter(loc => /^banana tree$/i.test(loc.name) && loc.reachable && !spentTrees.has(`${loc.x},${loc.z}`))
            .sort((a, b) => a.distance - b.distance)[0];
        if (!tree) throw new Error('Could not find a reachable banana tree for the Karamja fare');
        const before = sdk.countInventoryItems(banana);
        const picked = await auditOperation('dragon-slayer-return-pick-banana', 'Collect fruit for Luthas’s fare payment',
            { id: tree.id, x: tree.x, z: tree.z, before }, () => sdk.getState(), async () => {
                const action = await sdk.sendInteractLoc(tree.x, tree.z, tree.id, 1);
                if (!action.success) return false;
                return !!(await sdk.waitForCondition(() => sdk.countInventoryItems(banana) > before, 6500).catch(() => null));
            }, received => ({ outcome: received ? 'complete' : 'unconfirmed', held: sdk.countInventoryItems(banana) }));
        if (!picked) spentTrees.add(`${tree.x},${tree.z}`);
    }

    await walk(ctx, crate.x, crate.z, 2);
    for (let packed = 0; packed < 10; packed++) {
        const fruit = sdk.findInventoryItem(banana);
        if (!fruit) throw new Error('Ran out of bananas before filling Luthas’s crate');
        const before = sdk.countInventoryItems(banana);
        const outcome = await auditOperation('dragon-slayer-return-pack-banana', 'Fill Luthas’s crate to earn the boat fare',
            { ...crate, before }, () => sdk.getState(), async () => {
                const chat = { types: [0] };
                sdk.getNewChat(chat);
                const action = await sdk.sendUseItemOnLoc(fruit.slot, crate.x, crate.z, crate.id);
                if (!action.success) throw new Error(action.message);
                let full = false;
                await sdk.waitForCondition(() => {
                    full ||= sdk.getNewChat(chat).some(message => /crate is already full/i.test(message.text));
                    return full || sdk.countInventoryItems(banana) < before;
                }, 8000);
                if (!full) await continueDialog(ctx);
                return full ? 'already full' : 'packed';
            }, result => ({ outcome: 'complete', result, held: sdk.countInventoryItems(banana) }));
        if (outcome === 'already full') break;
    }

    await auditOperation('dragon-slayer-return-collect-fare', 'Collect the 30 coins owed for the banana crate',
        { fare }, () => sdk.getState(), async () => {
            await talkAt(ctx, 2939, 3154, luthas, [done], 10000);
            await sdk.waitForCondition(() => funds() >= fare, 8000);
            return funds();
        }, held => ({ outcome: 'complete', held }));
}

export async function returnToOziach(ctx: QuestContext) {
    const { bot, sdk } = ctx;
    const position = () => {
        const player = sdk.getState()?.player;
        if (!player) throw new Error('No live position for the return from Crandor');
        return player;
    };
    await bot.closeInterface();
    await continueDialog(ctx);
    const start = position();
    if (start.worldX >= 2820 && start.worldX <= 2870 && start.worldZ >= 3210 && start.worldZ <= 3270) {
        questPhase('dragon-slayer-return-crandor-entrance');
        await walk(ctx, 2833, 3255, 2);
        await travelThrough(ctx, 'dragon-slayer-return-rock-opening', 'Descend into Crandor’s passage',
            { id: 2609, x: 2833, z: 3255 }, player => !!player && inCrandorCaves(player));
    }
    if (inCrandorCaves(position())) {
        questPhase('dragon-slayer-return-crandor-passage');
        if (position().worldZ >= 9600) {
            await walk(ctx, 2836, 9600, 0);
            await travelThrough(ctx, 'dragon-slayer-return-secret-door', 'Pass through the secret door toward Karamja',
                { id: 2606, x: 2836, z: 9600 }, player => !!player && player.worldZ < 9600);
        }
        await walk(ctx, 2856, 9570, 0);
        await travelThrough(ctx, 'dragon-slayer-return-volcano-rope', 'Climb the rope to the Karamja volcano rim',
            { id: 1764, x: 2856, z: 9569 }, player => !!player && player.worldZ < 3200);
    }
    const surface = position();
    if (surface.worldX >= 2825 && surface.worldX <= 2960 && surface.worldZ >= 3125 && surface.worldZ <= 3200) {
        await earnFare(ctx);
        questPhase('dragon-slayer-return-to-port-sarim', { fare });
        await auditOperation('dragon-slayer-return-ferry', 'Pay the Customs officer to reach the mainland',
            { fare, destination: 'Port Sarim' }, () => sdk.getState(), async () => {
                await talkAt(ctx, 2954, 3147, /^customs officer$/i,
                    [/^can i journey on this ship/i, /^search away/i, /^ok\.$/i], 10000);
                const state = await sdk.waitForCondition(s => !!s.player && onPortSarimFerry(s.player), 45000);
                return state.player;
            }, player => ({ outcome: 'complete', player }));
    }
    if (onPortSarimFerry(position())) {
        questPhase('dragon-slayer-return-disembark');
        await travelThrough(ctx, 'dragon-slayer-return-disembark', 'Cross the gangplank onto the Port Sarim dock',
            { id: 2084, x: 3031, z: 3217 }, player => !!player && player.level === 0);
    }
    questPhase('dragon-slayer-return-oziach-house', arrival);
    await auditOperation('dragon-slayer-return-oziach-house', 'Reach Oziach’s front door for the final conversation', arrival,
        () => sdk.getState(), async () => {
            await walk(ctx, arrival.x, arrival.z, 0);
            return position();
        }, player => ({ outcome: 'complete', x: player.worldX, z: player.worldZ, plane: player.level }));

    questPhase('dragon-slayer-final-oziach-dialogue');
    await auditOperation('dragon-slayer-final-oziach-dialogue', 'Tell Oziach that Elvarg was slain and verify that he opens his armour shop',
        { npc: 'Oziach' }, () => sdk.getState(), async () => {
            await talkAt(ctx, arrival.x, arrival.z, /^oziach$/i, [/^can i buy a rune plate mail body now please/i], 10000);
            const { shop } = await sdk.waitForCondition(s => s.shop.isOpen && /oziach/i.test(s.shop.title), 10000);
            const closed = await bot.closeShop();
            if (!closed.success) throw new Error(closed.message);
            return shop.title;
        }, shop => ({ outcome: 'complete', shop }));
}

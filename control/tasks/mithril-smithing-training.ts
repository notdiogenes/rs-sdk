import { auditEvent } from '../../sdk/audit-trace';
import type { ScriptContext } from '../../sdk/runner';
import { bankLocations, place, type NamedTile } from '../bank-locations';
import { reportTaskActivity } from '../dashboard-task-activity';
import { miningResources } from '../mining-routes';

type TrainingOps = {
    openBank(place: NamedTile): Promise<void>;
    closeBank(): Promise<void>;
    depositAll(): Promise<void>;
    withdraw(id: number, amount: number): Promise<void>;
    walk(place: NamedTile, tolerance: number): Promise<void>;
};

const ironOre = 440;
const ironBar = 2351;
const hammer = 2347;
const runePickaxe = 1275;
const smithingGoal = 50;
const smithingGoalXp = 32_619; // Matches the engine's levelExperience table for this revision.
const furnace = place('the Falador furnace', 2975, 3368);
const ironMine = place('the Falador west surface mine', 2903, 3353);
const doricAnvil = place("Doric's anvil", 2951, 3451);
const varrockAnvil = place('the Varrock west anvil', 3187, 3424);
const oreCount = (items: readonly { id: number; count: number }[], id: number) =>
    items.reduce((sum, item) => sum + (item.id === id ? item.count : 0), 0);

export async function trainSmithingWithIron({ bot, sdk }: ScriptContext, ops: TrainingOps): Promise<void> {
    const bank = bankLocations.falador;
    const inventory = (id: number) => oreCount(sdk.getInventory(), id);
    const banked = (id: number) => {
        const state = sdk.getState();
        if (!state?.bank.isOpen) throw new Error('The bank must be open to check Smithing supplies.');
        return oreCount(state.bank.items, id);
    };
    const smithing = () => {
        const skill = sdk.getSkill('Smithing');
        if (!skill) throw new Error('Smithing level is unavailable.');
        return skill;
    };

    async function smeltIron(needsMoreBars: () => boolean) {
        await ops.walk(furnace, 2);
        const loc = (await sdk.scanNearbyLocs(8)).find(loc => loc.id === 2781 && loc.x === furnace.x && loc.z === furnace.z);
        if (!loc) throw new Error('The Falador furnace was not visible while training Smithing.');
        let misses = 0;
        while (inventory(ironOre) && needsMoreBars()) {
            const before = inventory(ironOre);
            await bot.dismissBlockingUI();
            const ore = sdk.getInventory().find(item => item.id === ironOre);
            if (!ore) break;
            reportTaskActivity('Smelting iron at the Falador furnace');
            const action = await sdk.sendUseItemOnLoc(ore.slot, loc.x, loc.z, loc.id);
            if (action.success) {
                try {
                    await sdk.waitForCondition(state => oreCount(state.inventory, ironOre) < before, 8_000);
                } catch (error) {
                    if (!(error instanceof Error && error.message === 'waitForCondition timed out')) throw error;
                }
            }
            // Iron may burn. Confirm the ore was consumed even when no bar was produced.
            if (inventory(ironOre) < before) misses = 0;
            else if (++misses >= 3) throw new Error(`The Falador furnace did not consume the iron ore. ${action.message}`);
        }
    }

    async function mineIron(amount: number) {
        if ((sdk.getSkill('Mining')?.level ?? 0) < 41 || banked(runePickaxe) === 0) {
            throw new Error('More iron ore is needed for Smithing 50. Mining it requires a banked rune pickaxe and Mining 41.');
        }
        await ops.withdraw(runePickaxe, 1);
        await ops.closeBank();
        await ops.walk(ironMine, 3);
        reportTaskActivity('Mining iron ore west of Falador');
        let misses = 0;
        while (inventory(ironOre) < amount) {
            const nearby = (await sdk.scanNearbyLocs(12)).filter(loc =>
                miningResources.iron.rocks.some(id => id === loc.id) && loc.reachable !== false);
            const rock = nearby[misses % nearby.length];
            const before = inventory(ironOre);
            const action = rock ? await bot.mineRock(rock, { timeout: 12_000 }) : undefined;
            if (inventory(ironOre) > before) misses = 0;
            else if (++misses >= 12) throw new Error(`Could not mine extra iron west of Falador. ${action?.message ?? 'No reachable iron rock.'}`);
            else await sdk.waitForTicks(3);
        }
    }

    async function smithIron(destinationBank: NamedTile, anvil: NamedTile, amount: number) {
        await ops.withdraw(hammer, 1);
        await ops.withdraw(ironBar, amount);
        await ops.closeBank();
        await ops.walk(anvil, 1);
        let misses = 0;
        while (inventory(ironBar) && smithing().level < smithingGoal) {
            const before = inventory(ironBar);
            const platebody = before >= 5 && smithing().level >= 33;
            const product = platebody ? 'iron platebody' : 'iron dagger';
            reportTaskActivity(`Smithing iron ${platebody ? 'platebodies' : 'daggers'} at ${anvil.name}`);
            const action = await bot.smithAtAnvil(product, { barPattern: /^iron bar$/i });
            if (inventory(ironBar) < before) misses = 0;
            else if (++misses >= 3) throw new Error(`Could not smith an ${product}. ${action.message}`);
        }
        await ops.openBank(destinationBank);
        await ops.depositAll();
    }

    if (smithing().level >= smithingGoal) return;
    auditEvent('phase', 'smithing-training', { metal: 'iron', targetLevel: smithingGoal });
    await ops.openBank(bank);
    if (banked(hammer) === 0) throw new Error('A banked hammer is needed to train Smithing with iron.');

    // At the server's default 25x rate, an iron bar grants 312.5 XP on smelting
    // and 625 XP when worked at an anvil. Recompute from observed smelting XP.
    let smeltXpPerBar = 312.5;
    const smithXpStillNeeded = () => Math.max(0, smithingGoalXp - smithing().experience);
    const hasDoricAnvil = sdk.getState()?.questJournal?.[7336] === 'complete';
    const trainingBank = hasDoricAnvil ? bank : bankLocations.west;
    const anvil = hasDoricAnvil ? doricAnvil : varrockAnvil;
    while (smithing().level < smithingGoal) {
        const storedBars = banked(ironBar);
        const projectedXp = storedBars * smeltXpPerBar * 2;
        if (storedBars > 0 && projectedXp >= smithXpStillNeeded()) {
            await smithIron(trainingBank, anvil, Math.min(27, storedBars));
            continue;
        }
        if (trainingBank !== bank && (sdk.getState()?.player?.worldX ?? 0) > 3100) {
            await ops.closeBank();
            await ops.openBank(bank);
        }
        // Unenchanted iron succeeds half the time. Carry enough for those
        // losses, and stop feeding ore once the anvil can finish the goal.
        const oreNeeded = Math.max(5, Math.ceil((smithXpStillNeeded() - projectedXp) / (smeltXpPerBar * 3)) * 2);
        const storedOre = banked(ironOre);
        if (storedOre) {
            await ops.withdraw(ironOre, Math.min(28, storedOre, oreNeeded));
            await ops.closeBank();
        } else {
            await mineIron(Math.min(27, oreNeeded));
        }
        const before = smithing().experience;
        await smeltIron(() => smithing().level < smithingGoal
            && (storedBars + inventory(ironBar)) * smeltXpPerBar * 2 < smithXpStillNeeded());
        const produced = inventory(ironBar);
        const gained = smithing().experience - before;
        if (produced && gained > 0) smeltXpPerBar = gained / produced;
        await ops.openBank(bank);
        await ops.depositAll();
    }
    await ops.closeBank();
    await ops.openBank(bank);
    auditEvent('milestone', 'smithing-trained', { level: smithing().level });
}

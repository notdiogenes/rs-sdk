import { auditEvent } from '../../../sdk/audit-trace';
import { runScript } from '../../../sdk/runner';
import { checkDragonMazeBasement } from './dragon-slayer';
import { questLog, questPhase, type QuestContext } from './shared';

// Inspect only item types recorded in the loadout near the lesser demon room.
const previousLoadout = new Set([772, 946, 1540, 1542, 1351, 556, 554, 563, 557, 562, 558, 379]);

async function inspectDrops({ sdk, bot }: QuestContext) {
    questPhase('dragon-maze-recovery-ground');
    const recovered: { id: number; name: string; count: number }[] = [];
    for (let attempt = 0; attempt < 25; attempt++) {
        const seen = (await sdk.scanGroundItems(16)).filter(item => previousLoadout.has(item.id) &&
            Math.abs(item.x - 2936) <= 5 && Math.abs(item.z - 9650) <= 5);
        auditEvent('check', 'dragon-maze-recovery-ground-items', {
            outcome: seen.length ? 'found' : 'none', items: seen.map(item => ({
                id: item.id, name: item.name, x: item.x, z: item.z, reachable: item.reachable, count: item.count,
            })),
        });
        const target = seen.find(item => item.reachable !== false);
        if (!target) {
            if (seen.length) throw new Error('Matching drops are visible but access is blocked from this side of the maze');
            break;
        }
        const held = () => sdk.getInventory().filter(item => item.id === target.id).reduce((sum, item) => sum + item.count, 0);
        const before = held();
        const picked = await bot.pickupItem(target);
        const count = held() - before;
        if (!picked.success || count <= 0) throw new Error(`Could not recover ${target.name}: ${picked.message}`);
        recovered.push({ id: target.id, name: target.name, count });
    }
    auditEvent('milestone', 'dragon-maze-recovery-result', { recovered });
    questLog('dragon-maze-recovery-result', { recovered });
}

const result = await runScript(async ctx => {
    const { sdk } = ctx;
    await sdk.waitForReady();
    questPhase('dragon-maze-recovery-start');
    auditEvent('check', 'dragon-maze-recovery-carried', {
        player: sdk.getState()?.player, inventory: sdk.getInventory(), equipment: sdk.getEquipment(),
    });
    // The north wall blocked the direct ladder approach. Use the quest's normal room route.
    await checkDragonMazeBasement(ctx, inspectDrops);
}, { printState: false, timeout: 900_000 });

if (!result.success) {
    questLog('dragon-maze-recovery-failed', { error: result.error?.message });
    process.exitCode = 1;
}

import { auditEvent } from '../../../sdk/audit-trace';
import { runScript } from '../../../sdk/runner';
import { changeFloor, questLog, questPhase, walk } from './shared';

// The eastern cellar ladder is the closest approach to the lesser demon room.
const previousLoadout = new Set([772, 946, 1540, 1542, 1351, 556, 554, 563, 557, 562, 558, 379]);

const result = await runScript(async ctx => {
    const { sdk, bot } = ctx;
    await sdk.waitForReady();
    questPhase('dragon-maze-recovery-start');
    const player = sdk.getState()?.player;
    auditEvent('check', 'dragon-maze-recovery-carried', { player, inventory: sdk.getInventory(), equipment: sdk.getEquipment() });
    if (!player || player.isDead) throw new Error('A living character is required to check the maze floor');
    if (player.worldZ < 4000) {
        await walk(ctx, 2939, 3258, 0);
        await changeFloor(ctx, 'down', 2939, 3257, 0, { requireReachable: true });
    }
    const inCellar = sdk.getState()?.player;
    if (!inCellar || inCellar.worldZ < 9630 || inCellar.worldZ > 9680) throw new Error('The recovery route did not reach the maze cellar');
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
    if (sdk.getState()?.player && sdk.getState()!.player!.worldZ > 9600) {
        await walk(ctx, 2939, 9657, 2);
        await changeFloor(ctx, 'up', 2939, 9657, 0);
    }
}, { printState: false, timeout: 320_000 });

if (!result.success) {
    questLog('dragon-maze-recovery-failed', { error: result.error?.message });
    process.exitCode = 1;
}

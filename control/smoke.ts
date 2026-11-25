import { findLongPath } from '../sdk/pathfinding';
import type { ScriptFunction } from '../sdk/runner';

/** Move one cardinal tile and verify its coordinates, without a gameplay loop. */
export const moveOneTile: ScriptFunction = async ({ bot, sdk }) => {
    const { player } = await sdk.waitForReady();
    if (!player || player.isDead || player.combat.inCombat) {
        throw new Error('Movement test requires a live character out of combat');
    }
    const { worldX: x, worldZ: z, level } = player;
    for (const [nextX, nextZ] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]] as const) {
        if (sdk.getState()?.nearbyPlayers.some(other => other.worldX === nextX && other.worldZ === nextZ)) continue;
        const route = findLongPath(level, x, z, nextX, nextZ);
        if (route.length !== 1 || route[0]?.x !== nextX || route[0]?.z !== nextZ) continue;
        const moved = await bot.walkTo(nextX, nextZ, 0, { timeout: 5000 });
        if (!moved.success) throw new Error(moved.message);
        const state = await sdk.waitForCondition(s =>
            s.player?.worldX === nextX && s.player.worldZ === nextZ && s.player.level === level, 5000);
        console.log(JSON.stringify({ from: { x, z, level }, to: { x: nextX, z: nextZ, level }, tick: state.tick }));
        return;
    }
    throw new Error('No directly reachable neighboring tile');
};

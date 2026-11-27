import type { ScriptContext } from '../../sdk/runner';
import { inTutorialDestination, onTutorial } from '../dashboard-task-catalog';

export async function leaveTutorial({ sdk, bot }: ScriptContext) {
    const state = await sdk.waitForReady();
    if (!state.player) throw new Error('No player state.');
    if (!onTutorial(state.player.worldX, state.player.worldZ)) return;
    const arrived = () => {
        const p = sdk.getState()?.player;
        return !!p && inTutorialDestination(p.worldX, p.worldZ, p.level);
    };
    for (let attempt = 0; attempt < 4 && !arrived(); attempt++) {
        await bot.skipTutorial();
        await sdk.waitForCondition(arrived, 5000).catch(() => null);
    }
    if (!arrived()) throw new Error('Could not verify departure from Tutorial Island.');
}

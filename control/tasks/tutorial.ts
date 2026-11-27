import { auditEvent, auditFrame } from '../../sdk/audit-trace';
import type { ScriptContext } from '../../sdk/runner';
import { inTutorialDestination, onTutorial } from '../dashboard-task-catalog';

export async function leaveTutorial({ sdk, bot }: ScriptContext) {
    auditEvent('phase', 'tutorial-preflight');
    const state = await sdk.waitForReady();
    if (!state.player) throw new Error('No player state.');
    if (!onTutorial(state.player.worldX, state.player.worldZ)) {
        auditEvent('milestone', 'tutorial-already-outside', { state: auditFrame(state) });
        return;
    }
    auditEvent('phase', 'tutorial-exit', { before: auditFrame(state) });
    const arrived = () => {
        const p = sdk.getState()?.player;
        return !!p && inTutorialDestination(p.worldX, p.worldZ, p.level);
    };
    for (let attempt = 0; attempt < 4 && !arrived(); attempt++) {
        const before = auditFrame(sdk.getState());
        await bot.skipTutorial();
        await sdk.waitForCondition(arrived, 5000).catch(() => null);
        const verified = arrived();
        auditEvent('check', 'tutorial-arrival', { outcome: verified ? 'complete' : 'unconfirmed', attempt: attempt + 1,
            expected: 'Lumbridge surface', before, after: auditFrame(sdk.getState()) });
        auditEvent(verified ? 'milestone' : 'setback', verified ? 'tutorial-departed' : 'tutorial-exit-retry', { attempt: attempt + 1 });
    }
    if (!arrived()) throw new Error('Could not verify departure from Tutorial Island.');
}

import { runScript } from '../../sdk/runner';
import { adventure } from './adventure';
import { withTaskUpdateCheckpoints } from './update-checkpoint';

const result = await runScript(withTaskUpdateCheckpoints(async (ctx, checkpoint) => {
    await ctx.sdk.waitForReady();
    const { trainHitpoints, pickpocket } = adventure(ctx, checkpoint);
    await trainHitpoints(60, true);
    await pickpocket('adaptive');
}), { printState: false });

if (!result.success) process.exitCode = 1;

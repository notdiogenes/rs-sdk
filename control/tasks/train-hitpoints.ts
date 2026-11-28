import { runScript } from '../../sdk/runner';
import { adventure } from './adventure';
import { withTaskUpdateCheckpoints } from './update-checkpoint';

const result = await runScript(withTaskUpdateCheckpoints(async (ctx, checkpoint) => {
    await ctx.sdk.waitForReady();
    await adventure(ctx, checkpoint).trainHitpoints(Infinity);
}), { printState: false });

if (!result.success) process.exitCode = 1;

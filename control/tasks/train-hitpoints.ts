import { runScript } from '../../sdk/runner';
import { adventure } from './adventure';

const result = await runScript(async ctx => {
    await ctx.sdk.waitForReady();
    await adventure(ctx).trainHitpoints(Infinity);
}, { printState: false });

if (!result.success) process.exitCode = 1;

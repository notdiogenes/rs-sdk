import { runScript } from '../../sdk/runner';
import { adventure } from './adventure';

const result = await runScript(async ctx => {
    await ctx.sdk.waitForReady();
    const { trainHitpoints, pickpocket } = adventure(ctx);
    await trainHitpoints(60, true);
    await pickpocket('adaptive');
}, { printState: false });

if (!result.success) process.exitCode = 1;

import { runScript } from '../../sdk/runner';
import { adventure } from './adventure';
import { leaveTutorial } from './tutorial';

const result = await runScript(async ctx => {
    await leaveTutorial(ctx);
    await adventure(ctx).pickpocket('men');
}, { printState: false });

if (!result.success) process.exitCode = 1;

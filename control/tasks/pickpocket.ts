import { runScript } from '../../sdk/runner';
import { adventure, type PickpocketTarget } from './adventure';
import { leaveTutorial } from './tutorial';

const targets: Record<string, PickpocketTarget> = {
    'pickpocket-men': 'men', 'pickpocket-guards': 'guards',
    'pickpocket-knights': 'knights', 'pickpocket-paladins': 'paladins',
    'pickpocket-heroes': 'heroes',
};
const target = targets[process.env.RS_ACTIVITY ?? ''];

const result = await runScript(async ctx => {
    if (!target) throw new Error('Choose a supported pickpocket target.');
    if (target === 'men') await leaveTutorial(ctx);
    else await ctx.sdk.waitForReady();
    await adventure(ctx).pickpocket(target);
}, { printState: false });

if (!result.success) process.exitCode = 1;

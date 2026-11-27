import { runScript } from '../../sdk/runner';
import { leaveTutorial } from './tutorial';

const result = await runScript(leaveTutorial, { printState: false, timeout: 90_000 });

if (!result.success) process.exitCode = 1;

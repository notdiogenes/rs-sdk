import { createDashboardSupervisor } from './dashboard-supervisor';
import { startDashboardWeb } from './dashboard-web';

export type { Bot, ControlActivity, Snapshot } from './dashboard-supervisor';

const [botsDir, configDir] = process.argv.slice(2);
if (!botsDir || !configDir) throw new Error('Expected the bot directory and control config directory');

// Compatibility entry point for installations that have not yet split the services.
const supervisor = await createDashboardSupervisor(botsDir, configDir);
await startDashboardWeb(supervisor.runtimeDir, supervisor.handle);

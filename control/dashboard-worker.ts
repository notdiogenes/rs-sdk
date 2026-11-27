import { createDashboardSupervisor } from './dashboard-supervisor';

const [botsDir, configDir, socket] = process.argv.slice(2);
if (!botsDir || !configDir || !socket) throw new Error('Expected the bot directory, control config directory, and private socket');
const supervisor = await createDashboardSupervisor(botsDir, configDir);
Bun.serve({
    unix: socket,
    maxRequestBodySize: 16_384,
    fetch: supervisor.handle,
});

import { lstatSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDashboardSupervisor } from './dashboard-supervisor';
import { dashboardRevisions } from './dashboard-revisions';
import * as builtInPolicy from './dashboard-worker-policy';
import type { DashboardWorkerPolicy, DashboardWorkerUpdates } from './dashboard-worker-policy';
import type { MonitorProcess } from './dashboard-monitor';

const [botsDir, configDir, socket] = process.argv.slice(2);
if (!botsDir || !configDir || !socket) throw new Error('Expected the bot directory, control config directory, and private socket');
const pathfindingSocket = join(dirname(socket), 'pathfinding.sock');
const pathfindingServer = join(import.meta.dir, '../sdk/pathfinding-server.ts');
const PATHFINDING_START_TIMEOUT = 60_000;
let pathfindingReady = false;
let monitoredPathfinder: MonitorProcess | null = null;
const revisions = dashboardRevisions(import.meta.dir, dirname(socket));
const reload = revisions.load<DashboardWorkerPolicy>('dashboard-worker-policy.ts', builtInPolicy.isWorkerPolicy, 'worker policy', builtInPolicy);
let policy: DashboardWorkerPolicy = builtInPolicy;
const updates: DashboardWorkerUpdates = {
    async load() {
        const release = await reload();
        policy = release.value;
        return release;
    },
    current: () => policy,
    pinTask: revisions.pinTask,
    changedPaths: revisions.changedPaths,
};

async function supervisePathfinding() {
    for (;;) {
        try {
            // A worker that was stopped abruptly may leave its socket behind.
            const staleSocket = lstatSync(pathfindingSocket, { throwIfNoEntry: false });
            if (staleSocket) {
                if (!staleSocket.isSocket()) throw new Error('The pathfinder socket path is already in use.');
                unlinkSync(pathfindingSocket);
            }
            const child = Bun.spawn([process.execPath, '--no-env-file', pathfindingServer, pathfindingSocket], {
                stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
                ipc(message: unknown) {
                    if (message && typeof message === 'object' && 'type' in message && message.type === 'ready') {
                        pathfindingReady = true;
                        clearTimeout(startup);
                    }
                },
            });
            monitoredPathfinder = {
                kind: 'pathfinder', bot: null, pid: child.pid, startedAt: new Date().toISOString(),
            };
            const startup = setTimeout(() => {
                console.error('[fleet-pathfinding] The pathfinder did not become ready. Restarting it.');
                child.kill('SIGKILL');
            }, PATHFINDING_START_TIMEOUT);
            try {
                const code = await child.exited;
                console.error(`[fleet-pathfinding] The pathfinder exited (${code}). Restarting it.`);
            } finally {
                clearTimeout(startup);
                pathfindingReady = false;
                monitoredPathfinder = null;
            }
        } catch (error) {
            console.error('[fleet-pathfinding] Could not start the pathfinder.', error);
        }
        await Bun.sleep(1000);
    }
}

async function waitForPathfinding() {
    const deadline = performance.now() + PATHFINDING_START_TIMEOUT;
    while (!pathfindingReady) {
        if (performance.now() >= deadline) throw new Error('The shared pathfinder is unavailable.');
        await Bun.sleep(100);
    }
}

await updates.load();
const supervisor = await createDashboardSupervisor(botsDir, configDir, {
    socket: pathfindingSocket,
    ensureReady: waitForPathfinding,
    monitoredProcess: () => monitoredPathfinder,
}, updates);
Bun.serve({
    unix: socket,
    maxRequestBodySize: 16_384,
    fetch: supervisor.handle,
});
void supervisePathfinding();

import { lstatSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDashboardSupervisor } from './dashboard-supervisor';
import { dashboardRevisions } from './dashboard-revisions';
import * as builtInPolicy from './dashboard-worker-policy';
import type { DashboardWorkerPolicy, DashboardWorkerUpdates } from './dashboard-worker-policy';
import type { MonitorProcess } from './dashboard-monitor';
import { bunPathfinder, pathfinderHealthy, selectPathfinder } from './dashboard-pathfinder';

const [botsDir, configDir, socket] = process.argv.slice(2);
if (!botsDir || !configDir || !socket) throw new Error('Expected the bot directory, control config directory, and private socket');
const pathfindingSocket = join(dirname(socket), 'pathfinding.sock');
const repo = dirname(import.meta.dir);
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
    let useRollback = false;
    for (;;) {
        try {
            // A worker that was stopped abruptly may leave its socket behind.
            const staleSocket = lstatSync(pathfindingSocket, { throwIfNoEntry: false });
            if (staleSocket) {
                if (!staleSocket.isSocket()) throw new Error('The pathfinder socket path is already in use.');
                unlinkSync(pathfindingSocket);
            }
            const launch = useRollback ? bunPathfinder(repo, pathfindingSocket)
                : await selectPathfinder(repo, configDir!, pathfindingSocket);
            console.log(`[fleet-pathfinding] Starting ${launch.implementation} pathfinder.`);
            let child;
            try {
                child = Bun.spawn(launch.command, {
                    stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
                    ...(launch.implementation === 'native' && { env: { ...process.env, RS_PATHFINDING_PARENT_PID: String(process.pid) } }),
                    // The legacy Bun child exits on IPC disconnect if its parent dies.
                    ...(launch.implementation === 'bun' && { ipc() {} }),
                });
            } catch (error) {
                if (launch.implementation === 'native') {
                    useRollback = true;
                    console.error('[fleet-pathfinding] Native release failed to launch. Falling back to Bun.', error);
                }
                throw error;
            }
            monitoredPathfinder = {
                kind: 'pathfinder', implementation: launch.implementation, bot: null, pid: child.pid, startedAt: new Date().toISOString(),
            };
            try {
                let running = true;
                const exited = child.exited.then(code => { running = false; return code; });
                const deadline = performance.now() + PATHFINDING_START_TIMEOUT;
                while (running && performance.now() < deadline) {
                    if (await pathfinderHealthy(pathfindingSocket) && running) {
                        pathfindingReady = true;
                        break;
                    }
                    await Bun.sleep(100);
                }
                if (!pathfindingReady) {
                    if (launch.implementation === 'native') {
                        useRollback = true;
                        console.error('[fleet-pathfinding] Native release failed its startup health check. Falling back to Bun.');
                    }
                    if (running) child.kill('SIGKILL');
                }
                const code = await exited;
                console.error(`[fleet-pathfinding] The ${launch.implementation} pathfinder exited (${code}). Restarting it.`);
            } finally {
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

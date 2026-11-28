import { lstatSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDashboardSupervisor } from './dashboard-supervisor';

const [botsDir, configDir, socket] = process.argv.slice(2);
if (!botsDir || !configDir || !socket) throw new Error('Expected the bot directory, control config directory, and private socket');
const pathfindingSocket = join(dirname(socket), 'pathfinding.sock');
const pathfindingServer = join(import.meta.dir, '../sdk/pathfinding-server.ts');
const PATHFINDING_START_TIMEOUT = 60_000;
let pathfindingReady = false;

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

const supervisor = await createDashboardSupervisor(botsDir, configDir, {
    socket: pathfindingSocket,
    ensureReady: waitForPathfinding,
});
Bun.serve({
    unix: socket,
    maxRequestBodySize: 16_384,
    fetch: supervisor.handle,
});
void supervisePathfinding();

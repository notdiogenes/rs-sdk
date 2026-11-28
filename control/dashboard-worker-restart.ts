import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';

const path = '/run/rs-sdk-fleet-maintenance.sock';
const cooldownMs = 30_000;

const maintenanceSocket = {
    available: () => lstat(path).then(info => info.isSocket(), () => false),
    restart: () => new Promise<boolean>(resolve => {
        let reply = '';
        const socket = createConnection(path);
        socket.setEncoding('utf8');
        socket.setTimeout(190_000, () => socket.destroy());
        socket.on('data', chunk => {
            reply += chunk;
            if (reply.length > 10) socket.destroy();
        });
        socket.on('error', () => socket.destroy());
        socket.on('close', hadError => resolve(!hadError && reply === 'restarted\n'));
    }),
};

export function dashboardWorkerRestart(authenticate: (request: Request) => Promise<string | undefined>,
    transport = maintenanceSocket) {
    let state: 'idle' | 'restarting' | 'restarted' | 'failed' = 'idle';
    let retryAt = 0;
    const headers = { 'Cache-Control': 'no-store' };
    const error = (message: string, status: number) => Response.json({ error: message }, { status, headers });

    return async (request: Request) => {
        if (request.method !== 'GET' && request.method !== 'POST') {
            return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
        }
        if (!await authenticate(request).catch(() => undefined)) {
            return error('Sign in to the HTTPS dashboard to restart the worker.', 401);
        }
        const available = await transport.available();
        if (request.method === 'GET') return Response.json({ available, state }, { headers });

        if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
            return error('Send an application/json restart request.', 415);
        }
        const body = await request.json().catch(() => null);
        if (body?.action !== 'restart' || Object.keys(body).length !== 1) {
            return error('Expected a worker restart request.', 400);
        }
        if (!available) return error('Worker restarts from Fleet Desk have not been enabled on this host.', 503);
        if (state === 'restarting' || Date.now() < retryAt) {
            return error('Wait for the current worker restart to settle before trying again.', 409);
        }
        state = 'restarting';
        void transport.restart().catch(() => false).then(restarted => {
            state = restarted ? 'restarted' : 'failed';
            retryAt = Date.now() + cooldownMs;
        });
        return Response.json({ available, state }, { status: 202, headers });
    };
}

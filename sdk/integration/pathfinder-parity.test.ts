import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RouteRequest } from '../pathfinding-protocol';
import { requestPathfinding } from '../pathfinding-transport';

// Include collision-map initialization time on cold CI runners.
setDefaultTimeout(45_000);

const root = resolve(import.meta.dir, '../..');
const temp = mkdtempSync(join(tmpdir(), 'rs-pf-'));
const legacy = join(temp, 'bun.sock');
const native = join(temp, 'native.sock');
const nativeBinary = process.env.RS_PATHFINDER_TEST_BINARY ?? 'sdk/native-pathfinder/target/release/pathfinder-native';
const children: Bun.Subprocess[] = [];

async function start(args: string[], socket: string): Promise<void> {
    const proc = Bun.spawn(args, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
    children.push(proc);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (proc.exitCode !== null || proc.signalCode !== null) {
            throw new Error(`Pathfinder exited before accepting requests on ${socket}`);
        }
        try {
            const response = await fetch('http://pathfinding/health', {
                unix: socket, signal: AbortSignal.timeout(500),
            });
            if (response.ok && (await response.json() as { status?: string }).status === 'ok') return;
        } catch {
            // The listener appears after the collision map has been initialized.
        }
        await Bun.sleep(50);
    }
    throw new Error(`Timed out waiting for ${socket}`);
}

beforeAll(async () => {
    await Promise.all([
        start([process.execPath, 'sdk/pathfinding-server.ts', legacy], legacy),
        start([resolve(root, nativeBinary), native, 'sdk/collision-data.json'], native),
    ]);
});

afterAll(async () => {
    try {
        for (const child of children) child.kill();
        await Promise.all(children.map(child => child.exited));
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
});

const door = { level: 0, x: 3107, z: 3162 };
const room = { level: 0, x: 3106, z: 3161 };
const route: RouteRequest = {
    type: 'route', level: 0, srcX: 3109, srcZ: 3172, destX: room.x, destZ: room.z, maxWaypoints: 500,
};

test('the SDK gets identical routes, doors and tiles from native and legacy sockets', async () => {
    const doorQuery = { type: 'door', ...door } as const;
    const original = await requestPathfinding(legacy, doorQuery);
    expect(original.door).toMatchObject({ ...door, shape: 9 });
    expect(await requestPathfinding(native, doorQuery)).toEqual(original);

    for (const tile of [door, room, { level: 0, x: 3106, z: 3162 }, { level: 3, x: 12_000, z: 12_000 }]) {
        const query = { type: 'tile', ...tile } as const;
        expect(await requestPathfinding(native, query)).toEqual(await requestPathfinding(legacy, query));
    }
    for (const query of [
        route,
        { ...route, srcX: 3222, srcZ: 3218, destX: 2662, destZ: 3305 },
        { ...route, level: 3, srcX: 12_000, srcZ: 12_000, destX: 12_008, destZ: 12_008 },
    ]) {
        expect(await requestPathfinding(native, query)).toEqual(await requestPathfinding(legacy, query));
    }
});

test('simultaneous clients keep temporary door exclusions isolated', async () => {
    const blocked = { ...route, blockedDoors: [door, door] };
    const openReply = await requestPathfinding(legacy, route);
    const blockedReply = await requestPathfinding(legacy, blocked);
    expect(openReply.waypoints.at(-1)).toEqual(room);
    expect(blockedReply.waypoints.at(-1)).not.toEqual(room);

    const queries = [blocked, route, blocked, route];
    const replies = await Promise.all(queries.map(query => requestPathfinding(native, query)));
    expect(replies).toEqual([blockedReply, openReply, blockedReply, openReply]);
    expect(await requestPathfinding(native, route)).toEqual(openReply);
});

async function raw(socket: string, path: string, method: string, body?: string) {
    const response = await fetch(`http://pathfinding${path}`, {
        unix: socket, method, body, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, allow: response.headers.get('allow'), json: await response.json() };
}

test('health and protocol errors match the retained Bun server', async () => {
    const cases = [
        { path: '/health?probe=1', method: 'GET', status: 200 },
        { path: '/missing', method: 'GET', status: 404 },
        { path: '/query', method: 'GET', status: 405 },
        { path: '/query', method: 'POST', body: '{', status: 400 },
        { path: '/query', method: 'POST', body: JSON.stringify({ type: 'tile', ...door, x: -1 }), status: 400 },
        { path: '/query', method: 'POST', body: JSON.stringify({ ...route, blockedDoors: [{}] }), status: 400 },
    ];
    for (const { path, method, body, status } of cases) {
        const expected = await raw(legacy, path, method, body);
        expect(expected.status).toBe(status);
        expect(await raw(native, path, method, body)).toEqual(expected);
    }
});

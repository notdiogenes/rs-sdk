import { findDoorsAlongPath, findLongPath, getDoorAt, initPathfinding, isTileWalkable, isZoneAllocated } from './pathfinding';
import type { DoorInfo } from './pathfinding-doors';
import type { PathfindingReply, PathfindingRequest, PathfindingTile, RouteReply, RouteRequest } from './pathfinding-protocol';

const maxCoordinate = 0x3fff;
const searchAreaTiles = 2048 * 2048;

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerInRange(value: unknown, max: number): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function validTile(value: unknown): value is PathfindingTile {
    return record(value) && integerInRange(value.level, 3) &&
        integerInRange(value.x, maxCoordinate) && integerInRange(value.z, maxCoordinate);
}

function parseQuery(value: unknown): PathfindingRequest | undefined {
    if (!record(value)) return;
    const { type, level, srcX, srcZ, destX, destZ, maxWaypoints, blockedDoors } = value;
    if ((type === 'door' || type === 'tile') && validTile(value)) {
        return { type, level: value.level, x: value.x, z: value.z };
    }
    if (type === 'route' && integerInRange(level, 3) && integerInRange(srcX, maxCoordinate) &&
        integerInRange(srcZ, maxCoordinate) && integerInRange(destX, maxCoordinate) && integerInRange(destZ, maxCoordinate) &&
        integerInRange(maxWaypoints, 0xffffffff) &&
        (blockedDoors === undefined || (Array.isArray(blockedDoors) && blockedDoors.every(validTile)))) {
        return { type, level, srcX, srcZ, destX, destZ, maxWaypoints, blockedDoors };
    }
}

function route(query: RouteRequest): RouteReply {
    const { level, srcX, srcZ, destX, destZ, maxWaypoints } = query;
    const blockedDoors = new Set<DoorInfo>();
    for (const tile of query.blockedDoors ?? []) {
        const door = getDoorAt(tile.level, tile.x, tile.z);
        if (door) blockedDoors.add(door);
    }
    const sourceAllocated = isZoneAllocated(level, srcX, srcZ);
    const destinationAllocated = isZoneAllocated(level, destX, destZ);
    const destinationWalkable = isTileWalkable(level, destX, destZ);
    const waypoints = findLongPath(level, srcX, srcZ, destX, destZ, Math.min(maxWaypoints, searchAreaTiles), blockedDoors);
    return { waypoints, doors: findDoorsAlongPath(waypoints), sourceAllocated, destinationAllocated, destinationWalkable };
}

function execute(query: PathfindingRequest): PathfindingReply {
    switch (query.type) {
        case 'route': return route(query);
        case 'tile': return { walkable: isTileWalkable(query.level, query.x, query.z) };
        case 'door': return { door: getDoorAt(query.level, query.x, query.z) ?? null };
    }
}

export async function handlePathfindingRequest(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/health' && request.method === 'GET') return Response.json({ status: 'ok' });
    if (pathname !== '/query') return Response.json({ error: 'Unknown pathfinding endpoint' }, { status: 404 });
    if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } });
    }
    const query = parseQuery(await request.json().catch(() => undefined));
    if (!query) return Response.json({ error: 'Invalid pathfinding query' }, { status: 400 });
    if (request.signal.aborted) return Response.json({ error: 'Pathfinding query cancelled' }, { status: 408 });
    try {
        return Response.json(execute(query));
    } catch (error) {
        console.error('[pathfinding] query failed', error);
        return Response.json({ error: 'Pathfinding query failed' }, { status: 500 });
    }
}

if (import.meta.main) {
    const socket = process.argv[2] ?? process.env.RS_PATHFINDING_SOCKET;
    if (!socket) throw new Error('Expected the pathfinding socket as an argument or RS_PATHFINDING_SOCKET');
    if (process.connected) process.once('disconnect', () => process.exit(0));
    initPathfinding();
    Bun.serve({ unix: socket, fetch: handlePathfindingRequest });
    if (process.connected) process.send?.({ type: 'ready' });
    console.log('[pathfinding] service ready');
}

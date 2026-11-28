import { expect, test } from 'bun:test';
import { executionContext } from '../execution-context';
import type { DoorReply, PathfindingRequest, RouteReply, RouteRequest } from '../pathfinding-protocol';
import { handlePathfindingRequest } from '../pathfinding-server';
import { PathfindingServiceError, requestPathfinding } from '../pathfinding-transport';

function query(body: PathfindingRequest): Promise<Response> {
    return handlePathfindingRequest(new Request('http://pathfinding/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
}

test('serves route, door and tile queries and restores door collision between requests', async () => {
    const health = await handlePathfindingRequest(new Request('http://pathfinding/health'));
    expect(await health.json()).toEqual({ status: 'ok' });

    const doorTile = { level: 0, x: 3107, z: 3162 };
    const room = { level: 0, x: 3106, z: 3161 };
    const route: RouteRequest = {
        type: 'route', level: 0, srcX: 3109, srcZ: 3172, destX: room.x, destZ: room.z, maxWaypoints: 500,
    };
    const { door } = await (await query({ type: 'door', ...doorTile })).json() as DoorReply;
    expect(door).toMatchObject({ ...doorTile, shape: 9 });
    const blocked = await (await query({ ...route, blockedDoors: [doorTile] })).json() as RouteReply;
    expect(blocked.waypoints.at(-1)).not.toEqual(room);

    const open = await (await query(route)).json() as RouteReply;
    expect(open).toMatchObject({ sourceAllocated: true, destinationAllocated: true });
    expect(open.waypoints.at(-1)).toEqual(room);
    expect(open.doors).toContainEqual(door!);
    expect(await (await query({ type: 'tile', ...doorTile })).json()).toEqual({ walkable: true });
});

test('reports a missing service and preserves the task cancellation reason', async () => {
    const query = { type: 'tile', level: 0, x: 3107, z: 3162 } as const;
    const socket = `/tmp/rs-sdk-missing-${crypto.randomUUID()}.sock`;
    await expect(requestPathfinding(socket, query)).rejects.toBeInstanceOf(PathfindingServiceError);

    const reason = new Error('Task stopped');
    await expect(executionContext.run({ signal: AbortSignal.abort(reason) }, () => requestPathfinding(socket, query)))
        .rejects.toBe(reason);
});

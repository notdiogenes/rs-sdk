import { executionContext } from './execution-context';
import type {
    DoorReply, DoorRequest, PathfindingReply, PathfindingRequest, RouteReply, RouteRequest, TileReply, TileRequest,
} from './pathfinding-protocol';

export class PathfindingServiceError extends Error {
    override name = 'PathfindingServiceError';
}

export function requestPathfinding(socket: string, request: RouteRequest): Promise<RouteReply>;
export function requestPathfinding(socket: string, request: TileRequest): Promise<TileReply>;
export function requestPathfinding(socket: string, request: DoorRequest): Promise<DoorReply>;
export async function requestPathfinding(socket: string, request: PathfindingRequest): Promise<PathfindingReply> {
    const executionSignal = executionContext.getStore()?.signal;
    const deadline = AbortSignal.timeout(10_000);
    const signal = executionSignal ? AbortSignal.any([executionSignal, deadline]) : deadline;
    try {
        signal.throwIfAborted();
        const response = await fetch('http://pathfinding/query', {
            unix: socket,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            signal,
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new PathfindingServiceError(`Pathfinding service rejected the query (HTTP ${response.status})`);
        }
        return await response.json() as PathfindingReply;
    } catch (error) {
        executionSignal?.throwIfAborted();
        if (error instanceof PathfindingServiceError) throw error;
        const message = deadline.aborted ? 'Pathfinding service request timed out' : 'Pathfinding service is unavailable';
        throw new PathfindingServiceError(message, { cause: error });
    }
}

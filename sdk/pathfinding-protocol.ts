import type { DoorInfo } from './pathfinding-doors';

export interface PathfindingTile {
    level: number;
    x: number;
    z: number;
}

export interface RouteRequest {
    type: 'route';
    level: number;
    srcX: number;
    srcZ: number;
    destX: number;
    destZ: number;
    maxWaypoints: number;
    blockedDoors?: PathfindingTile[];
}

export interface RouteReply {
    waypoints: PathfindingTile[];
    doors: DoorInfo[];
    sourceAllocated: boolean;
    destinationAllocated: boolean;
    destinationWalkable: boolean;
}

export interface TileRequest extends PathfindingTile {
    type: 'tile';
}

export interface TileReply {
    walkable: boolean;
}

export interface DoorRequest extends PathfindingTile {
    type: 'door';
}

export interface DoorReply {
    door: DoorInfo | null;
}

export type PathfindingRequest = RouteRequest | TileRequest | DoorRequest;
export type PathfindingReply = RouteReply | TileReply | DoorReply;

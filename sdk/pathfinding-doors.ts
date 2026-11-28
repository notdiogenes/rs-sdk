export interface DoorInfo {
    level: number;
    x: number;
    z: number;
    shape: number;
    angle: number;
    blockrange: boolean;
}

interface TemporaryDoorBlock {
    door: DoorInfo;
    expiresAt: number;
}

/**
 * Session-owned evidence that a door is temporarily impassable.
 *
 * Entries expire automatically so a transient route failure cannot poison the
 * process-wide collision map for every bot until restart.
 */
export class TemporaryDoorBlocklist {
    private entries = new Map<string, TemporaryDoorBlock>();

    constructor(private readonly now: () => number = Date.now) {}

    block(door: DoorInfo, ttlMs: number = 30_000): void {
        this.entries.set(doorKey(door.level, door.x, door.z), {
            door,
            expiresAt: this.now() + Math.max(0, ttlMs)
        });
    }

    active(): DoorInfo[] {
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) this.entries.delete(key);
        }
        return [...this.entries.values()].map(entry => entry.door);
    }

    has(level: number, x: number, z: number): boolean {
        this.active();
        return this.entries.has(doorKey(level, x, z));
    }

    clear(): void {
        this.entries.clear();
    }
}

export function doorKey(level: number, x: number, z: number): string {
    return `${level},${x},${z}`;
}

import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export type RuntimeGroup = { id: string; name: string; mode: 'client' | 'client-and-task' };
export type ConfiguredGroup = RuntimeGroup & { members: string[]; revision: string };
type GroupRow = Omit<ConfiguredGroup, 'members'>;

export class RuntimeGroupConflict extends Error {
    constructor() {
        super('The runtime group changed. Reload it before saving your edits.');
        this.name = 'RuntimeGroupConflict';
    }
}

function groupSettings(input: unknown, mode: unknown): Pick<RuntimeGroup, 'name' | 'mode'> {
    const name = typeof input === 'string' ? input.trim() : '';
    if (!/^[a-z0-9][a-z0-9 _-]{0,39}$/i.test(name) || name.toLowerCase() === 'dedicated') {
        throw new Error('Use a group name of 1–40 letters, numbers, spaces, hyphens or underscores. Dedicated is reserved.');
    }
    if (mode !== 'client' && mode !== 'client-and-task') throw new Error('Choose a supported sharing mode.');
    return { name, mode };
}

function memberNames(canonicalNames: readonly string[]) {
    const names = new Map<string, string>();
    for (const name of canonicalNames) {
        const key = name.toLowerCase();
        if (!names.has(key)) names.set(key, name);
    }
    return names;
}

export function dashboardRuntimeGroups(directory: string) {
    const db = new Database(join(directory, 'runtime-groups.sqlite'), { create: true });
    const renewRevision = (...ids: Array<'NEW.id' | 'OLD.group_id' | 'NEW.group_id'>) => `
        INSERT INTO runtime_group_revision (group_id, token)
        VALUES ${ids.map(id => `(${id}, lower(hex(randomblob(16))))`).join(', ')}
        ON CONFLICT(group_id) DO UPDATE SET token = excluded.token;
    `;
    db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 2000;
        CREATE TABLE IF NOT EXISTS runtime_group (
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            mode TEXT NOT NULL CHECK(mode IN ('client', 'client-and-task'))
        );
        CREATE TABLE IF NOT EXISTS runtime_assignment (
            bot TEXT PRIMARY KEY COLLATE NOCASE, group_id TEXT NOT NULL REFERENCES runtime_group(id)
        );
        CREATE TABLE IF NOT EXISTS runtime_group_revision (
            group_id TEXT PRIMARY KEY REFERENCES runtime_group(id) ON DELETE CASCADE,
            token TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS runtime_group_changed AFTER UPDATE OF name, mode ON runtime_group
        WHEN OLD.name COLLATE BINARY <> NEW.name OR OLD.mode <> NEW.mode
        BEGIN ${renewRevision('NEW.id')} END;
        CREATE TRIGGER IF NOT EXISTS runtime_assignment_added AFTER INSERT ON runtime_assignment
        BEGIN ${renewRevision('NEW.group_id')} END;
        CREATE TRIGGER IF NOT EXISTS runtime_assignment_removed AFTER DELETE ON runtime_assignment
        BEGIN ${renewRevision('OLD.group_id')} END;
        CREATE TRIGGER IF NOT EXISTS runtime_assignment_moved AFTER UPDATE OF group_id ON runtime_assignment
        WHEN OLD.group_id <> NEW.group_id
        BEGIN ${renewRevision('OLD.group_id', 'NEW.group_id')} END;
    `);

    // Bun forwards the callback result, but its SQLite types declare `immediate` as void.
    function write<Args extends unknown[], Result>(operation: (...args: Args) => Result) {
        return db.transaction(operation).immediate as (...args: Args) => Result;
    }

    const all = db.query<RuntimeGroup, []>('SELECT id, name, mode FROM runtime_group ORDER BY name COLLATE NOCASE');
    // A group's existing UUID is its starting revision until its first change.
    const configuredRows = `SELECT g.id, g.name, g.mode, COALESCE(r.token, g.id) AS revision FROM runtime_group g
        LEFT JOIN runtime_group_revision r ON r.group_id = g.id`;
    const configured = db.query<GroupRow, []>(`${configuredRows} ORDER BY g.name COLLATE NOCASE`);
    const groupById = db.query<GroupRow, [string]>(`${configuredRows} WHERE g.id = ?`);
    const assigned = db.query<RuntimeGroup, [string]>(`SELECT g.id, g.name, g.mode FROM runtime_group g
        JOIN runtime_assignment a ON a.group_id = g.id WHERE a.bot = ?`);
    const membersByGroup = db.query<{ bot: string }, [string]>('SELECT bot FROM runtime_assignment WHERE group_id = ? ORDER BY bot COLLATE NOCASE');
    const writeAssignment = db.query(`INSERT INTO runtime_assignment (bot, group_id) VALUES (?, ?)
        ON CONFLICT(bot) DO UPDATE SET group_id = excluded.group_id WHERE runtime_assignment.group_id <> excluded.group_id`);
    const clearAssignment = db.query('DELETE FROM runtime_assignment WHERE bot = ?');
    const members = (id: string) => membersByGroup.all(id).map(row => row.bot);
    const setAssignment = (bot: string, id: string | null) =>
        (id === null ? clearAssignment.run(bot) : writeAssignment.run(bot, id)).changes > 0;

    const listConfigured = db.transaction((): ConfiguredGroup[] =>
        configured.all().map(group => ({ ...group, members: members(group.id) }))).deferred as () => ConfiguredGroup[];

    const createWithMembers = write((input: unknown, mode: unknown, canonicalNames: readonly string[]): RuntimeGroup => {
        const group = { id: randomUUID(), ...groupSettings(input, mode) };
        const result = db.query('INSERT INTO runtime_group (id, name, mode) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING')
            .run(group.id, group.name, group.mode);
        if (!result.changes) throw new Error('A runtime group already has that name.');
        for (const bot of memberNames(canonicalNames).values()) setAssignment(bot, group.id);
        return group;
    });

    function create(input: unknown, mode: unknown): RuntimeGroup {
        return createWithMembers(input, mode, []);
    }

    const editWithMembers = write((id: string, expectedRevision: string, input: unknown, mode: unknown,
        canonicalNames: readonly string[]): { group: RuntimeGroup; affected: Array<{ bot: string; group: RuntimeGroup | null }> } => {
        const current = groupById.get(id);
        if (!current) throw new Error('Choose an existing runtime group.');
        if (current.revision !== expectedRevision) throw new RuntimeGroupConflict();

        const group = { id, ...groupSettings(input, mode) };
        const modeChanged = current.mode !== group.mode;
        if (current.name !== group.name || modeChanged) {
            const result = db.query('UPDATE OR IGNORE runtime_group SET name = ?, mode = ? WHERE id = ?')
                .run(group.name, group.mode, id);
            if (!result.changes) throw new Error('A runtime group already has that name.');
        }

        const nextMembers = memberNames(canonicalNames);
        const affected: Array<{ bot: string; group: RuntimeGroup | null }> = [];
        for (const bot of members(id)) {
            if (!nextMembers.has(bot.toLowerCase())) {
                setAssignment(bot, null);
                affected.push({ bot, group: null });
            }
        }
        for (const bot of nextMembers.values()) {
            if (setAssignment(bot, id) || modeChanged) affected.push({ bot, group });
        }
        return { group, affected };
    });

    const assign = write((bot: string, id: unknown) => {
        if (id !== null && (typeof id !== 'string' || !groupById.get(id))) {
            throw new Error('Choose an existing runtime group.');
        }
        setAssignment(bot, id);
    });

    return { list: () => all.all(), listConfigured, assignment: (bot: string) => assigned.get(bot), create, createWithMembers,
        editWithMembers, assign, close: () => db.close() };
}

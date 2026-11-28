import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export type RuntimeGroup = { id: string; name: string; mode: 'client' | 'client-and-task' };

export function dashboardRuntimeGroups(directory: string) {
    const db = new Database(join(directory, 'runtime-groups.sqlite'), { create: true });
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
    `);
    const all = db.query<RuntimeGroup, []>('SELECT id, name, mode FROM runtime_group ORDER BY name COLLATE NOCASE');
    const assigned = db.query<RuntimeGroup, [string]>(`SELECT g.id, g.name, g.mode FROM runtime_group g
        JOIN runtime_assignment a ON a.group_id = g.id WHERE a.bot = ?`);
    function create(input: unknown, mode: unknown): RuntimeGroup {
        const name = typeof input === 'string' ? input.trim() : '';
        if (!/^[a-z0-9][a-z0-9 _-]{0,39}$/i.test(name) || name.toLowerCase() === 'dedicated') {
            throw new Error('Use a group name of 1–40 letters, numbers, spaces, hyphens or underscores. Dedicated is reserved.');
        }
        if (mode !== 'client' && mode !== 'client-and-task') throw new Error('Choose a supported sharing mode.');
        const group = { id: randomUUID(), name, mode } satisfies RuntimeGroup;
        const result = db.query('INSERT INTO runtime_group VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING')
            .run(group.id, group.name, group.mode);
        if (!result.changes) throw new Error('A runtime group already has that name.');
        return group;
    }
    function assign(bot: string, id: unknown) {
        if (id === null) {
            db.query('DELETE FROM runtime_assignment WHERE bot = ?').run(bot);
            return;
        }
        if (typeof id !== 'string' || !db.query('SELECT 1 FROM runtime_group WHERE id = ?').get(id)) {
            throw new Error('Choose an existing runtime group.');
        }
        db.query(`INSERT INTO runtime_assignment VALUES (?, ?)
            ON CONFLICT(bot) DO UPDATE SET group_id = excluded.group_id`).run(bot, id);
    }
    return { list: () => all.all(), assignment: (bot: string) => assigned.get(bot), create, assign, close: () => db.close() };
}

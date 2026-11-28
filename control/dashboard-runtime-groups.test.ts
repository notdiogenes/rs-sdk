import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardRuntimeGroups, RuntimeGroupConflict } from './dashboard-runtime-groups';

test('named runtime assignments survive restart and dedicated clears only the selected bot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-groups-'));
    let store = dashboardRuntimeGroups(dir);
    try {
        const questers = store.create('Questing', 'client');
        const pickpockets = store.create('Pickpocketing', 'client-and-task');
        expect(store.assignment('Boss')).toBeNull();
        store.assign('First', questers.id);
        store.assign('Second', pickpockets.id);
        expect(() => store.assign('First', 'removed-group')).toThrow();
        store.close();
        store = dashboardRuntimeGroups(dir);
        expect(store.assignment('first')).toEqual(questers);
        expect(store.assignment('SECOND')).toEqual(pickpockets);
        expect(store.list()).toEqual([pickpockets, questers]);
        store.assign('second', null);
        expect(store.assignment('SECOND')).toBeNull();
        expect(store.assignment('first')).toEqual(questers);
        expect(() => store.create('Dedicated', 'client')).toThrow();
        expect(() => store.create('questing', 'client-and-task')).toThrow();
        expect(() => store.create('New group', 'unsupported')).toThrow();
    } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('edits canonical membership and mode while returning only affected assignments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-group-edits-'));
    const store = dashboardRuntimeGroups(dir);
    try {
        const first = store.createWithMembers('Questing', 'client', ['Atlas', 'Birch', 'ATLAS']);
        const second = store.createWithMembers('Mining', 'client-and-task', ['Cedar', 'Dune']);
        const configured = (id: string) => store.listConfigured().find(group => group.id === id)!;
        const original = configured(first.id);
        expect(original).toMatchObject({ ...first, members: ['Atlas', 'Birch'] });
        expect(store.editWithMembers(first.id, original.revision, 'Questing', 'client', ['BIRCH', 'atlas'])).toEqual({
            group: first, affected: [],
        });
        expect(configured(first.id)).toEqual(original);

        const renamed = { ...first, name: 'Questers' };
        expect(store.editWithMembers(first.id, original.revision, ' Questers ', 'client', ['Atlas', 'Birch'])).toEqual({
            group: renamed, affected: [],
        });
        const current = configured(first.id);
        expect(current).toMatchObject({ ...renamed, members: original.members });
        expect(current.revision).not.toBe(original.revision);
        expect(() => store.editWithMembers(first.id, original.revision, 'Changed', 'client', [])).toThrow(RuntimeGroupConflict);

        const previousSecond = configured(second.id);
        const updated = { ...renamed, mode: 'client-and-task' as const };
        expect(store.editWithMembers(first.id, current.revision, 'Questers', 'client-and-task', ['Atlas', 'CEDAR', 'Elder'])).toEqual({
            group: updated,
            affected: [{ bot: 'Birch', group: null }, { bot: 'Atlas', group: updated }, { bot: 'CEDAR', group: updated }, { bot: 'Elder', group: updated }],
        });
        expect(configured(first.id).members).toEqual(['Atlas', 'Cedar', 'Elder']);
        expect(configured(second.id).members).toEqual(['Dune']);
        expect(configured(second.id).revision).not.toBe(previousSecond.revision);
        expect(() => store.editWithMembers(second.id, previousSecond.revision, 'Mining', 'client', ['Dune'])).toThrow(RuntimeGroupConflict);
        expect(store.assignment('birch')).toBeNull();
        expect(store.assignment('cedar')).toEqual(updated);
        expect(store.assignment('dune')).toEqual(second);
    } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('group revisions detect concurrent assignment changes and conflicting names leave all assignments intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-group-revisions-'));
    const store = dashboardRuntimeGroups(dir);
    const other = dashboardRuntimeGroups(dir);
    try {
        const group = store.createWithMembers('Questing', 'client', ['Atlas']);
        const mining = store.createWithMembers('Mining', 'client-and-task', ['Birch']);
        const configured = () => store.listConfigured().find(entry => entry.id === group.id)!;
        const original = configured();
        other.assign('ATLAS', mining.id);
        other.assign('atlas', group.id);
        expect(configured().members).toEqual(original.members);
        expect(configured().revision).not.toBe(original.revision);
        expect(() => store.editWithMembers(group.id, original.revision, 'Questing', 'client', [])).toThrow(RuntimeGroupConflict);

        const before = store.listConfigured();
        expect(() => store.editWithMembers(group.id, configured().revision, 'mining', 'client-and-task', ['Birch'])).toThrow('already has that name');
        expect(() => store.createWithMembers('QUESTING', 'client-and-task', ['Birch'])).toThrow('already has that name');
        expect(store.listConfigured()).toEqual(before);
        expect(store.assignment('atlas')).toEqual(group);
        expect(store.assignment('birch')).toEqual(mining);

        const moved = store.createWithMembers('Fishing', 'client-and-task', ['ATLAS']);
        expect(configured().members).toEqual([]);
        expect(configured().revision).not.toBe(before.find(entry => entry.id === group.id)?.revision);
        expect(store.assignment('Atlas')).toEqual(moved);
    } finally {
        other.close();
        store.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('existing databases can acquire revisions while keeping the original group table shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-group-legacy-'));
    const path = join(dir, 'runtime-groups.sqlite');
    const original = new Database(path, { create: true });
    original.exec(`
        CREATE TABLE runtime_group (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, mode TEXT NOT NULL);
        CREATE TABLE runtime_assignment (bot TEXT PRIMARY KEY COLLATE NOCASE, group_id TEXT NOT NULL REFERENCES runtime_group(id));
        INSERT INTO runtime_group VALUES ('legacy', 'Questing', 'client');
        INSERT INTO runtime_assignment VALUES ('Atlas', 'legacy');
    `);
    original.close();
    let store = dashboardRuntimeGroups(dir);
    try {
        const originalGroup = store.listConfigured()[0]!;
        expect(originalGroup).toMatchObject({ id: 'legacy', name: 'Questing', mode: 'client', members: ['Atlas'] });
        expect(originalGroup.revision).toBeTruthy();
        store.editWithMembers('legacy', originalGroup.revision, 'Questing', 'client-and-task', ['Atlas']);
        const updated = store.listConfigured()[0]!;
        expect(updated.revision).not.toBe(originalGroup.revision);
        store.close();

        const previousWorker = new Database(path);
        previousWorker.exec(`
            INSERT INTO runtime_group VALUES ('legacy-created', 'Fishing', 'client');
            UPDATE runtime_assignment SET group_id = 'legacy-created' WHERE bot = 'Atlas';
        `);
        previousWorker.close();
        store = dashboardRuntimeGroups(dir);
        expect(store.listConfigured()).toEqual([
            expect.objectContaining({ id: 'legacy-created', members: ['Atlas'], revision: expect.any(String) }),
            expect.objectContaining({ id: 'legacy', name: updated.name, mode: updated.mode, members: [] }),
        ]);
        expect(store.listConfigured()[1]?.revision).not.toBe(updated.revision);
        expect(() => store.editWithMembers('legacy', updated.revision, 'Questing', 'client-and-task', ['Atlas'])).toThrow(RuntimeGroupConflict);
    } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
    }
});

import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardRuntimeGroups } from './dashboard-runtime-groups';

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

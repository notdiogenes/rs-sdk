import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dashboardDemo } from './dashboard-demo';
import { dashboardRuntimeGroups } from './dashboard-runtime-groups';
import { dashboardSessions } from './dashboard-session';
import { handleWorkerRequest, type DashboardWorkerApiRuntime } from './dashboard-worker-api';

test('runtime group commands authenticate and affect only the selected account', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.runtime-api-test-'));
    const origin = 'https://127-0-0-1.sslip.io';
    const sessions = dashboardSessions(directory, async () => origin, join(directory, 'enrollment.json'));
    const store = dashboardRuntimeGroups(directory);
    const online = new Set(['First', 'Second']);
    const profiles = ['First', 'Second'].map(name => ({ name, directory: join(directory, name) }));
    const token = '1'.repeat(64);
    const runtime = {
        sessions, demo: dashboardDemo(directory, directory, directory, token, () => {}),
        botProfile: async (name: string) => profiles.find(profile => profile.name === name) ?? null,
        invalidateSnapshot() {},
        runtimeGroups: {
            store,
            state: async ({ name }: { name: string }) => ({ online: online.has(name), activeGroupId: null }),
            offline: async ({ name }: { name: string }) => { online.delete(name); },
        },
    } as unknown as DashboardWorkerApiRuntime;

    function call(bot: string, headers: Record<string, string>, command?: object) {
        return handleWorkerRequest(new Request(origin + '/bots/activity?view=runtime-groups&bot=' + bot, {
            method: command ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers },
            body: command ? JSON.stringify(command) : undefined,
        }), runtime);
    }
    try {
        const password = 'runtime-fixture-password';
        await Bun.write(join(directory, 'password.json'), JSON.stringify({ origin, hash: await Bun.password.hash(password) }));
        const login = await sessions.handle(new Request(origin, {
            method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
        }), 'login');
        expect(login.status).toBe(200);
        const signedIn = { Cookie: login.headers.get('Set-Cookie')!.split(';')[0]!, Origin: origin };
        const bearer = { Authorization: 'Bearer ' + token };
        const create = { action: 'create', name: 'Thieving', mode: 'client-and-task' };

        expect((await call('First', {})).status).toBe(401);
        expect((await call('First', { ...signedIn, Origin: 'https://other.example' }, create)).status).toBe(401);
        expect((await call('Missing', bearer, create)).status).toBe(404);
        expect(await (await call('First', signedIn)).json()).toMatchObject({ groups: [], groupId: null, pending: false });
        const created = await call('First', signedIn, create);
        expect(created.status).toBe(201);
        const { created: group } = await created.json();
        expect(group).toMatchObject({ name: 'Thieving', mode: 'client-and-task' });
        expect((await call('First', bearer, { ...create, name: 'thieving' })).status).toBe(400);
        expect((await call('First', bearer, { action: 'assign', groupId: 'unknown' })).status).toBe(400);

        const assigned = await call('First', bearer, { action: 'assign', groupId: group.id });
        expect(await assigned.json()).toMatchObject({ groupId: group.id, activeGroupId: null, online: true, pending: true });
        expect(await (await call('Second', bearer)).json()).toMatchObject({ groupId: null, online: true, pending: false });
        expect(await (await call('First', signedIn, { action: 'offline' })).json()).toMatchObject({
            groupId: group.id, online: false, pending: false,
        });
        expect(online.has('Second')).toBe(true);
        expect(await (await call('First', bearer, { action: 'assign', groupId: null })).json()).toMatchObject({ groupId: null });

        delete runtime.runtimeGroups;
        expect((await call('First', signedIn)).status).toBe(503);
        expect((await call('First', {})).status).toBe(401);
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
});

async function groupApi() {
    const directory = await mkdtemp(join(process.cwd(), '.pool-edit-test-'));
    const store = dashboardRuntimeGroups(directory);
    const profiles = ['First', 'Second', 'Third'].map(name => ({ name, directory: join(directory, name) }));
    const calls: { bot: string; mode: string; groupId: string | null }[] = [];
    const token = '2'.repeat(64);
    const runtime = {
        sessions: { authenticate: async () => undefined },
        demo: dashboardDemo(directory, directory, directory, token, () => {}),
        botProfile: async (name: string) => profiles.find(profile => profile.name.toLowerCase() === name.toLowerCase()) ?? null,
        invalidateSnapshot() {},
        runtimeGroups: {
            store,
            members: async () => profiles,
            state: async () => ({ online: false, activeGroupId: null }),
            offline: async () => {},
            relaunch: async ({ name }: { name: string }, group: { id: string } | null, mode: string) => {
                calls.push({ bot: name, mode, groupId: group?.id ?? null });
                return { bot: name, status: name === 'First' ? 'queued' : 'assigned' };
            },
        },
    } as unknown as DashboardWorkerApiRuntime;
    function request(command?: object) {
        return handleWorkerRequest(new Request('https://fleet.example/bots/activity?view=runtime-groups&bot=First', {
            method: command ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: command ? JSON.stringify(command) : undefined,
        }), runtime);
    }
    return { store, calls, runtime, request, close: async () => {
        store.close();
        await rm(directory, { recursive: true, force: true });
    } };
}

test('pool creation validates the whole selection before assigning and relaunching accounts', async () => {
    const fixture = await groupApi();
    const { calls, request, runtime, store } = fixture;
    const create = (extra: object) => request({ action: 'create', name: 'Questing', mode: 'client', ...extra });
    try {
        const { members, canConfigureGroups } = await (await request()).json();
        expect(canConfigureGroups).toBe(true);
        expect(members).toEqual([{ name: 'First' }, { name: 'Second' }, { name: 'Third' }]);
        for (const input of [
            { bots: null }, { bots: 'First' }, { bots: ['First', 42] }, { bots: ['First', 'Missing'] },
            { bots: ['First', 'FIRST'] }, { bots: ['First'], relaunch: 'invalid' },
        ]) {
            expect((await create(input)).ok).toBe(false);
            expect(store.list()).toEqual([]);
            expect(store.assignment('First')).toBeNull();
            expect(calls).toHaveLength(0);
        }
        const result = await create({ bots: ['FIRST', 'second'] });
        expect(result.status).toBe(201);
        const { created, relaunches } = await result.json();
        expect(store.assignment('First')?.id).toBe(created.id);
        expect(store.assignment('Second')?.id).toBe(created.id);
        expect(store.assignment('Third')).toBeNull();
        expect(relaunches).toEqual([{ bot: 'First', status: 'queued' }, { bot: 'Second', status: 'assigned' }]);
        expect(calls.map(call => call.mode)).toEqual(['safe', 'safe']);
        expect((await create({ bots: ['Third'], relaunch: 'immediate' })).ok).toBe(false);
        expect(store.assignment('Third')).toBeNull();
        expect(calls).toHaveLength(2);
        const empty = await create({ name: 'Reserve', bots: [] });
        expect(empty.status).toBe(201);
        expect(await empty.json()).toMatchObject({ created: { name: 'Reserve' }, relaunches: [] });
        expect(calls).toHaveLength(2);

        const legacy = runtime.runtimeGroups!;
        runtime.runtimeGroups = { store, state: legacy.state, offline: legacy.offline };
        expect((await (await request()).json()).canConfigureGroups).toBe(false);
        expect((await create({ name: 'Legacy', bots: ['Third'] })).status).toBe(503);
        expect((await request({ action: 'edit', groupId: created.id, bots: [] })).status).toBe(503);
        expect(store.list()).toHaveLength(2);
        expect((await create({ name: 'Legacy' })).status).toBe(201);
    } finally { await fixture.close(); }
});

test('a failed handoff reports that bot while its peers keep their assignment and relaunch request', async () => {
    const fixture = await groupApi();
    const { runtime, store, request } = fixture;
    try {
        const handler = runtime.runtimeGroups!;
        const relaunch = handler.relaunch!;
        handler.relaunch = async (profile, group, mode) => {
            if (profile.name === 'First') throw new Error('The run is busy.');
            return relaunch(profile, group, mode);
        };
        const result = await request({
            action: 'create', name: 'Thieving', mode: 'client-and-task', bots: ['First', 'Second'], relaunch: 'immediate',
        });
        expect(result.status).toBe(201);
        const { created, relaunches } = await result.json();
        expect(relaunches).toEqual([
            { bot: 'First', status: 'failed', message: 'The run is busy.' }, { bot: 'Second', status: 'assigned' },
        ]);
        expect(store.assignment('First')?.id).toBe(created.id);
        expect(store.assignment('Second')?.id).toBe(created.id);
    } finally { await fixture.close(); }
});

test('pool edits preserve group identity, reject stale revisions and only relaunch affected members', async () => {
    const fixture = await groupApi();
    const { calls, request, store } = fixture;
    try {
        const { created } = await (await request({ action: 'create', name: 'Questing', mode: 'client', bots: ['First', 'Second'] })).json();
        const readGroup = async () => (await (await request()).json()).groups.find((group: { id: string }) => group.id === created.id);
        let group = await readGroup();
        const edit = (extra: object) => request({ action: 'edit', groupId: created.id, expectedRevision: group.revision,
            name: group.name, mode: group.mode, bots: group.members, relaunch: 'immediate', ...extra });
        expect(group.members).toEqual(['First', 'Second']);
        calls.length = 0;
        const rename = await edit({ name: 'Adventures' });
        expect(rename.status).toBe(200);
        expect(await rename.json()).toMatchObject({ edited: { id: created.id, name: 'Adventures' }, relaunches: [] });
        expect(calls).toEqual([]);
        expect((await edit({ bots: ['Third'] })).status).toBe(409);
        group = await readGroup();
        expect(group.members).toEqual(['First', 'Second']);
        expect((await edit({ bots: ['Third', 'Missing'] })).ok).toBe(false);
        expect(await readGroup()).toEqual(group);
        expect(calls).toEqual([]);

        const change = await edit({ mode: 'client-and-task', bots: ['Second', 'Third'] });
        expect(change.status).toBe(200);
        expect(calls.slice().sort((a, b) => a.bot.localeCompare(b.bot))).toEqual([
            { bot: 'First', mode: 'immediate', groupId: null },
            { bot: 'Second', mode: 'immediate', groupId: group.id },
            { bot: 'Third', mode: 'immediate', groupId: group.id },
        ]);
        expect(store.assignment('First')).toBeNull();
        expect(store.assignment('Second')?.mode).toBe('client-and-task');
        group = await readGroup();
        expect(group.members).toEqual(['Second', 'Third']);
        expect((await edit({ bots: [] })).ok).toBe(true);
        expect((await readGroup()).members).toEqual([]);
        expect(store.assignment('Third')).toBeNull();
    } finally { await fixture.close(); }
});

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

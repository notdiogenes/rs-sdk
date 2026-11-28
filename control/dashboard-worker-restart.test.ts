import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dashboardSessions } from './dashboard-session';
import { dashboardWebHandler } from './dashboard-web';
import { dashboardWorkerRestart } from './dashboard-worker-restart';

test('the web restart route requires a same-origin dashboard session and reports the service result', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.restart-test-'));
    const origin = 'https://127-0-0-1.sslip.io';
    const endpoint = `${origin}/bots/activity?view=worker-restart`;
    const password = 'local-restart-fixture';
    const sessions = dashboardSessions(directory, async () => origin, join(directory, 'enrollment.json'));
    let available = false;
    let starts = 0;
    let finish!: (value: boolean) => void;
    const restart = dashboardWorkerRestart(sessions.authenticate, {
        available: async () => available,
        restart: () => { starts++; return new Promise(resolve => { finish = resolve; }); },
    });
    const notNeeded = () => { throw new Error('This route runs independently of the worker'); };
    const handle = dashboardWebHandler(notNeeded, notNeeded, notNeeded, [], undefined, restart);
    try {
        const hash = await Bun.password.hash(password, { algorithm: 'argon2id' });
        await Bun.write(join(directory, 'password.json'), JSON.stringify({ hash, origin }));
        const login = await sessions.handle(new Request(origin, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password }),
        }), 'login');
        expect(login.status).toBe(200);
        const cookie = login.headers.get('Set-Cookie')!.split(';')[0]!;
        const read = () => handle(new Request(endpoint, { headers: { Cookie: cookie } }));
        const post = (headers: Record<string, string>, body: object = { action: 'restart' }) => handle(new Request(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
        }));
        const signedIn = { Cookie: cookie, Origin: origin };
        expect((await handle(new Request(endpoint))).status).toBe(401);
        expect((await post({ Authorization: 'Bearer delegated-token', Origin: origin })).status).toBe(401);
        expect((await post({ Cookie: cookie })).status).toBe(401);
        expect((await post({ Cookie: cookie, Origin: 'https://other.example' })).status).toBe(401);
        expect(await (await read()).json()).toEqual({ available: false, state: 'idle' });
        expect((await post(signedIn)).status).toBe(503);
        available = true;
        expect((await post(signedIn, { action: 'restart', unit: 'other.service' })).status).toBe(400);
        expect(await (await read()).json()).toEqual({ available: true, state: 'idle' });
        expect(starts).toBe(0);

        const responses = await Promise.all([post(signedIn), post(signedIn)]);
        expect(responses.map(response => response.status).sort()).toEqual([202, 409]);
        expect(await responses.find(response => response.status === 202)!.json()).toEqual({ available: true, state: 'restarting' });
        expect(await (await read()).json()).toEqual({ available: true, state: 'restarting' });
        finish(true);
        expect(await (await read()).json()).toEqual({ available: true, state: 'restarted' });
        expect((await post(signedIn)).status).toBe(409);
        expect(starts).toBe(1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

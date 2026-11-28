import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ScriptContext } from '../sdk/runner';
import type { BotWorldState } from '../sdk/types';
import { checkStepCompatibility, nextWork, parseSteps, type Finish } from './dashboard-plan';
import { createPlanManager, PlanEditConflict, type PlanBackend } from './dashboard-plan-runner';
import { dashboardRoster } from './dashboard-roster';
import { dashboardSessions } from './dashboard-session';
import { planCatalog } from './dashboard-task-catalog';
import { handleWorkerRequest, type DashboardWorkerApiRuntime } from './dashboard-worker-api';
import * as builtInPolicy from './dashboard-worker-policy';
import { botCredentials } from './hosted-bot';
import { craftBodyRunes } from './tasks/craft-body-runes';
import { selectFishingStage } from './tasks/fish-sharks';

function world(thieving: number, hp: number, cook = false, tutorial = false) {
    return {
        tick: 1,
        inGame: true,
        player: { worldX: tutorial ? 3090 : 3222, worldZ: tutorial ? 3100 : 3222, level: 0 },
        questJournal: { 7333: cook ? 'complete' : 'not-started', 7337: 'not-started' },
        skills: [
            { name: 'Thieving', baseLevel: thieving },
            { name: 'Hitpoints', baseLevel: hp },
            { name: 'Attack', baseLevel: 1 },
        ],
    } as unknown as BotWorldState;
}

test('meets requirements through eligible trainers, and skips training at qualifying levels', () => {
    const [step] = parseSteps([{ task: 'pickpocket-heroes', finish: { type: 'forever' } }]);
    const actions = [[1, 10], [40, 10], [55, 10], [70, 10], [80, 10], [80, 80]].map(([thieving, hp]) =>
        nextWork(step!, world(thieving!, hp!)));
    expect(actions.map(x => x?.task)).toEqual([
        'pickpocket-men', 'pickpocket-guards', 'pickpocket-knights', 'pickpocket-paladins', 'train-hitpoints', 'pickpocket-heroes',
    ]);
    expect(actions.slice(0, 5).map(x => x?.finish)).toEqual([
        { type: 'level', skill: 'Thieving', level: 40 }, { type: 'level', skill: 'Thieving', level: 55 },
        { type: 'level', skill: 'Thieving', level: 70 }, { type: 'level', skill: 'Thieving', level: 80 },
        { type: 'level', skill: 'Hitpoints', level: 80 },
    ]);
    expect(actions[5]?.inserted).toBe(false);
});

test('a Paladin activity uses Knights up to 70 Thieving and then targets Paladins', () => {
    const [step] = parseSteps([{ task: 'pickpocket-paladins', finish: { type: 'minutes', minutes: 45 } }]);
    expect(nextWork(step!, world(69, 50))?.task).toBe('pickpocket-knights');
    expect(nextWork(step!, world(70, 50))?.task).toBe('pickpocket-paladins');
});

test('trains at Catherby until a Fishing Guild activity is available', () => {
    const finish = { type: 'forever' };
    const [fish] = parseSteps([{ task: 'fish-sharks-guild', finish }]);
    const [cook] = parseSteps([{ task: 'fish-sharks-guild-cook', finish }]);
    const state = (fishing: number, cooking: number) => ({
        ...world(1, 10),
        skills: [
            { name: 'Fishing', baseLevel: fishing, level: fishing },
            { name: 'Cooking', baseLevel: cooking, level: cooking },
        ] as BotWorldState['skills'],
    });
    expect(nextWork(fish!, state(67, 1))).toMatchObject({
        task: 'fish-sharks', finish: { type: 'level', skill: 'Fishing', level: 68 },
    });
    expect(nextWork(cook!, state(68, 9))).toMatchObject({
        task: 'fish-sharks-cook', finish: { type: 'level', skill: 'Cooking', level: 10 },
    });
    expect(nextWork(fish!, state(68, 1))).toMatchObject({ task: 'fish-sharks-guild', inserted: false });
    expect(nextWork(cook!, state(68, 10))).toMatchObject({ task: 'fish-sharks-guild-cook', inserted: false });

    expect(() => selectFishingStage(state(67, 99), false, 'guild')).toThrow('Fishing Guild');
    expect(selectFishingStage(state(68, 10), true, 'guild')).toMatchObject({ label: 'mackerel and cod', spot: 313 });
    expect(selectFishingStage(state(68, 30), true, 'guild')).toMatchObject({ label: 'tuna', spot: 312 });
    expect(selectFishingStage(state(75, 80), true, 'guild')).toMatchObject({ label: 'lobsters', spot: 312 });
    expect(selectFishingStage(state(76, 79), true, 'guild')).toMatchObject({ label: 'lobsters', spot: 312 });
    expect(selectFishingStage(state(76, 80), true, 'guild')).toMatchObject({ label: 'sharks', spot: 313 });
    expect(selectFishingStage(state(76, 1), false)).toMatchObject({ label: 'sharks', spot: 322 });
});

test('checks tutorial, quest prerequisites, and timed completion in order', () => {
    const [step] = parseSteps([{ task: 'pickpocket-men', finish: { type: 'minutes', minutes: 1 },
        requirements: [{ type: 'quest', task: 'cooks-assistant' }] }]);
    expect(nextWork(step!, world(1, 10, false, true))?.task).toBe('skip-tutorial');
    expect(nextWork(step!, world(1, 10))?.task).toBe('cooks-assistant');
    expect(nextWork(step!, world(1, 10, true), 59_999)?.task).toBe('pickpocket-men');
    expect(nextWork(step!, world(1, 10, true), 60_000)).toBeNull();
});

test('rejects invalid plans and respects the game finish condition of one-time quests', () => {
    const cook = { task: 'cooks-assistant', finish: { type: 'complete' } };
    expect(() => parseSteps([{ task: 'pickpocket-men', finish: { type: 'forever' } }, cook])).toThrow('final activity');
    expect(() => parseSteps([{ ...cook, finish: { type: 'minutes', minutes: 1 } }])).toThrow('valid finish condition');
    expect(() => parseSteps([{ ...cook, requirements: [{ type: 'quest', task: 'cooks-assistant' }] }])).toThrow('itself');
    expect(nextWork(parseSteps([cook])[0]!, world(1, 10, true))).toBeNull();
});

test('accepts bank totals for mining in banking mode and requires a bar target for mithril smelting', () => {
    const finish = { type: 'bank-stock', quantity: 6000 } as const;
    expect(parseSteps([{ task: 'mine-coal-bank', finish }])[0]?.finish).toEqual(finish);
    expect(() => parseSteps([{ task: 'mine-coal-power', finish }])).toThrow('valid finish condition');
    expect(() => parseSteps([{ task: 'mine-iron-bank', finish: { ...finish, quantity: 0 } }])).toThrow('valid finish condition');
    const task = 'smelt-mithril-falador';
    expect(planCatalog.find(entry => entry.id === task)?.stockTargetItem).toBe('mithril bars');
    const [step] = parseSteps([{ task, finish }]);
    expect(nextWork(step!, world(1, 10))).toMatchObject({ task, finish, inserted: false });
    expect(() => parseSteps([{ task, finish: { type: 'forever' } }])).toThrow('target of 1–100,000 mithril bars');
    expect(() => parseSteps([{ task, finish: { ...finish, quantity: 0 } }])).toThrow('target of 1–100,000 mithril bars');
});

test('the public catalog offers exactly the finish conditions accepted for each activity', () => {
    for (const entry of planCatalog) {
        const finishes: Record<Finish['type'], Finish> = {
            'melee-levels': { type: 'melee-levels', levels: { Attack: 50, Hitpoints: 60 }, style: 'Balanced' },
            complete: { type: 'complete' }, minutes: { type: 'minutes', minutes: 30 },
            level: { type: 'level', skill: entry.trains?.[0] ?? 'Fishing', level: 40 },
            'bank-stock': { type: 'bank-stock', quantity: 250 },
            'essence-exhausted': { type: 'essence-exhausted' }, forever: { type: 'forever' },
        };
        for (const finish of Object.values(finishes)) {
            const parse = () => parseSteps([{ task: entry.id, finish }]);
            if (entry.finishModes.includes(finish.type)) expect(parse()[0]?.finish).toEqual(finish);
            else expect(parse).toThrow();
        }
        expect(entry.finishModes.includes('bank-stock')).toBe(Boolean(entry.bankStockItem));
    }
});

test('both fishing locations support optional raw or cooked shark totals and keep existing plan steps compatible', () => {
    const fish = planCatalog.filter(entry => entry.category === 'Fishing');
    expect(fish.map(entry => [entry.id, entry.selectors.map(selector => selector.value), entry.bankStockItem])).toEqual([
        ['fish-sharks', ['Catherby', 'Keep raw'], 'raw sharks'],
        ['fish-sharks-cook', ['Catherby', 'Cook'], 'cooked sharks'],
        ['fish-sharks-guild', ['Fishing Guild', 'Keep raw'], 'raw sharks'],
        ['fish-sharks-guild-cook', ['Fishing Guild', 'Cook'], 'cooked sharks'],
    ]);
    for (const entry of fish) {
        expect(entry.finishModes).toEqual(['minutes', 'level', 'bank-stock', 'forever']);
        expect(entry.stockTargetItem).toBeUndefined();
        expect(checkStepCompatibility({ task: entry.id, finish: { type: 'minutes', minutes: 30 }, requirements: [] }))
            .toMatchObject({ status: 'compatible', migrated: false });
    }
});

test('accepts only declared activity options and carries pickpocket banking into eligible prerequisite work', () => {
    const finish = { type: 'forever' };
    const task = 'pickpocket-heroes';
    const options = { banking: true } as const;
    expect(planCatalog.find(entry => entry.id === task)?.options).toEqual([
        { id: 'banking', type: 'checkbox', label: 'Bank loot and restock food' },
    ]);
    const [step] = parseSteps([{ task, finish, options }]);
    expect(step?.options).toEqual(options);
    expect(nextWork(step!, world(70, 99))).toMatchObject({ task: 'pickpocket-paladins', inserted: true, options });
    expect(nextWork(step!, world(80, 99))).toMatchObject({ task, inserted: false, options });
    expect(nextWork(step!, world(80, 10))?.options).toBeUndefined();
    expect(nextWork(step!, world(80, 99, true, true))?.options).toBeUndefined();
    expect(parseSteps([{ task, finish, options: { banking: false } }])[0]?.options).toBeUndefined();
    expect(() => parseSteps([{ task, finish, options: { banking: 'true' } }])).toThrow('valid option');
    expect(() => parseSteps([{ task, finish, options: { unknown: true } }])).toThrow('valid option');
    expect(() => parseSteps([{ task: 'fish-sharks', finish, options }])).toThrow('valid option');
});

test('offers an opt-in essence exhaustion checkbox without changing the Runecraft goal', () => {
    const task = 'craft-body-runes';
    const finish = { type: 'level', skill: 'Runecraft', level: 99 } as const;
    const options = { finishOnEssenceExhausted: true };
    expect(planCatalog.find(entry => entry.id === task)?.options).toContainEqual({
        id: 'finishOnEssenceExhausted', type: 'checkbox', label: expect.any(String),
    });
    expect(parseSteps([{ task, finish, options }])[0]).toMatchObject({ finish, options });
    expect(parseSteps([{ task, finish }])[0]?.options).toBeUndefined();
    expect(parseSteps([{ task, finish, options: { finishOnEssenceExhausted: false } }])[0]?.options).toBeUndefined();
    expect(() => parseSteps([{ task: 'pickpocket-men', finish: { type: 'forever' }, options }])).toThrow('valid option');
});

test('the plan API requires worker support before exposing or accepting the essence checkbox', async () => {
    const runtime = {
        botProfile: async () => ({ name: 'Bot' }), botRoster: {}, plans: { get: () => null },
        demo: { allowed: async () => true }, sessions: { authenticate: async () => undefined },
    } as unknown as DashboardWorkerApiRuntime;
    const request = (body?: object) => handleWorkerRequest(new Request('https://fleet.test/bots/activity?view=plan&bot=Bot',
        body && { method: 'POST', body: JSON.stringify(body) }), runtime);
    const craft = (catalog: typeof planCatalog) => catalog.find(entry => entry.id === 'craft-body-runes');
    const legacy = await (await request()).json();
    expect(legacy.canFinishOnEssenceExhausted).toBe(false);
    expect(craft(legacy.catalog)?.options ?? []).toEqual([]);
    expect((await request({ action: 'start', steps: [{
        task: 'craft-body-runes', finish: { type: 'level', skill: 'Runecraft', level: 99 },
        options: { finishOnEssenceExhausted: true },
    }] })).status).toBe(503);

    runtime.plans.supportsFinishOnEssenceExhausted = true;
    const upgraded = await (await request()).json();
    expect(upgraded.canFinishOnEssenceExhausted).toBe(true);
    expect(craft(upgraded.catalog)?.options).toContainEqual({
        id: 'finishOnEssenceExhausted', type: 'checkbox', label: expect.any(String),
    });
});

test('an empty runecrafting bank closes cleanly without needing a talisman', async () => {
    const game = world(80, 99);
    game.inventory = [];
    game.bank = { isOpen: true, items: [], noteMode: false };
    game.skills.push({ name: 'Runecraft', level: 90, baseLevel: 90, experience: 569_937 });
    const actions: string[] = [];
    const context = {
        sdk: { getState: () => game },
        bot: {
            async closeBank() {
                actions.push('close');
                game.bank.isOpen = false;
                return { success: true, message: 'Bank closed' };
            },
            async withdrawItem() { throw new Error('An empty bank must not trigger a withdrawal.'); },
        },
    } as unknown as ScriptContext;
    await craftBodyRunes(context);
    expect(actions).toEqual(['close']);
});

test('creates private profiles and rejects duplicate names case-insensitively', async () => {
    const scratch = mkdtempSync(join(process.cwd(), '.plan-test-'));
    try {
        const legacy = join(scratch, 'legacy');
        mkdirSync(legacy);
        const roster = dashboardRoster(legacy, scratch);
        const bot = await roster.create('NewTest');
        const profile = await Bun.file(join(bot.directory, 'bot.env')).text();
        expect(profile).toContain('BOT_USERNAME=NewTest');
        expect(statSync(join(bot.directory, 'bot.env')).mode & 0o777).toBe(0o600);
        expect(await roster.list()).toEqual([bot]);
        await expect(roster.create('newtest')).rejects.toThrow('already exists');
        await expect(roster.create('../newtest')).rejects.toThrow('alphanumeric');
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('registers existing credentials privately and rejects duplicates across profile creation methods', async () => {
    const scratch = mkdtempSync(join(process.cwd(), '.plan-test-'));
    try {
        const legacy = join(scratch, 'legacy');
        mkdirSync(join(legacy, 'Legacy Scout'), { recursive: true });
        await Bun.write(join(legacy, 'Legacy Scout', 'bot.env'), 'BOT_USERNAME=Legacy Scout\n');
        const roster = dashboardRoster(legacy, scratch);
        const password = 'Sh#arp =$w0rd';
        const bot = await roster.register('Manual Scout', password);
        const env = join(bot.directory, 'bot.env');
        expect(await botCredentials(bot.name, bot.directory)).toEqual({ username: 'Manual Scout', password });
        expect(statSync(bot.directory).mode & 0o777).toBe(0o700);
        expect(statSync(env).mode & 0o777).toBe(0o600);
        expect(await roster.list()).toContainEqual(bot);
        await expect(roster.register('manual scout', 'different')).rejects.toThrow('already exists');
        await expect(roster.register('legacy scout', 'different')).rejects.toThrow('already exists');
        await expect(roster.register('Demo Scout', 'different', 'demo scout')).rejects.toThrow('already exists');
        const created = await roster.create('NewScout');
        await expect(roster.register('newscout', 'different')).rejects.toThrow('already exists');
        await expect(roster.register('../Escape', password)).rejects.toThrow();
        for (const invalid of ['', ' leading', 'trailing ', 'line\nSERVER=changed', 'a\x00b', 'x'.repeat(21)]) {
            await expect(roster.register('Invalid', invalid)).rejects.toThrow();
        }
        expect((await roster.list()).map(profile => profile.name).sort()).toEqual(['Legacy Scout', 'Manual Scout', created.name].sort());
        expect(await botCredentials(bot.name, bot.directory)).toEqual({ username: 'Manual Scout', password });
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('the plan API registers an existing bot only from a same-origin dashboard session', async () => {
    const scratch = mkdtempSync(join(process.cwd(), '.plan-test-'));
    const manager = createPlanManager(scratch, async () => { throw new Error('Registration must not start a task.'); });
    try {
        const origin = 'https://127-0-0-1.sslip.io';
        const sessions = dashboardSessions(scratch, async () => origin, join(scratch, 'enrollment.json'));
        const dashboardPassword = 'local-registration-fixture';
        const hash = await Bun.password.hash(dashboardPassword, { algorithm: 'argon2id' });
        await Bun.write(join(scratch, 'password.json'), JSON.stringify({ hash, origin }));
        const login = await sessions.handle(new Request(origin, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
            body: JSON.stringify({ password: dashboardPassword }),
        }), 'login');
        expect(login.status).toBe(200);
        const cookie = login.headers.get('Set-Cookie')!.split(';')[0]!;
        const roster = dashboardRoster(join(scratch, 'legacy'), scratch);
        const { register: _register, ...legacy } = roster;
        let refreshes = 0;
        const runtime = {
            botRoster: legacy, plans: manager, sessions, invalidateSnapshot: () => { refreshes++; },
            demo: { allowed: async (request: Request) => request.headers.get('Authorization') === 'Bearer delegated', profile: async () => null },
        } as unknown as DashboardWorkerApiRuntime;
        const password = 'Manual $ecret=#pw';
        const endpoint = `${origin}/bots/activity?view=plan`;
        const read = () => handleWorkerRequest(new Request(endpoint, { headers: { Cookie: cookie } }), runtime);
        const post = (headers: Record<string, string> = {}, name = 'Manual Scout', secret = password) => handleWorkerRequest(new Request(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ action: 'register', name, password: secret }),
        }), runtime);
        const signedIn = { Cookie: cookie, Origin: origin };

        expect(await (await read()).json()).toMatchObject({ canRegisterExisting: false });
        expect((await post(signedIn)).status).toBe(503);
        runtime.botRoster = roster;
        expect(await (await read()).json()).toMatchObject({ canRegisterExisting: true });
        expect((await post()).status).toBe(401);
        expect((await post({ Cookie: cookie, Origin: 'https://other.example' })).status).toBe(401);
        expect((await post({ Authorization: 'Bearer delegated', Origin: origin })).status).toBe(401);
        expect(await roster.list()).toEqual([]);

        const saved = await post(signedIn);
        expect(saved.status).toBe(201);
        expect(saved.headers.get('Cache-Control')).toBe('no-store');
        expect(await saved.json()).toEqual({ bot: 'Manual Scout' });
        const duplicate = await post(signedIn, 'manual scout', 'replacement password');
        expect([400, 409]).toContain(duplicate.status);
        expect(await duplicate.text()).not.toContain('replacement password');
        expect(refreshes).toBe(1);
        expect(manager.list()).toEqual([]);
        const [bot] = await roster.list();
        expect(await botCredentials(bot!.name, bot!.directory)).toEqual({ username: 'Manual Scout', password });
    } finally {
        manager.close();
        rmSync(scratch, { recursive: true, force: true });
    }
});

async function until(check: () => boolean, timeout = 9_000) {
    const end = Date.now() + timeout;
    while (!check()) {
        if (Date.now() > end) throw new Error('Expected plan state did not arrive.');
        await Bun.sleep(60);
    }
}

test('holds one activity at a time, pauses, and resumes with the saved cursor', async () => {
    const scratch = mkdtempSync(join(process.cwd(), '.plan-test-'));
    let fake = world(1, 10, true);
    const started: string[] = [];
    let status: ReturnType<PlanBackend['status']> = { bot: 'Bot', tasks: [], client: null, task: null };
    const backend: PlanBackend = {
        status: () => status,
        async prepare() { status.client = { startedAt: new Date().toISOString(), stopping: false }; },
        async observe() { fake.tick++; return fake; },
        async start(name) {
            expect(status.task).toBeNull();
            started.push(name);
            status.task = { name, startedAt: new Date().toISOString(), stopping: false };
        },
        async stop() { status.task = null; },
    };
    let manager = createPlanManager(scratch, async () => backend);
    try {
        const steps = parseSteps([
            { task: 'cooks-assistant', finish: { type: 'complete' } },
            { task: 'pickpocket-men', finish: { type: 'level', skill: 'Thieving', level: 2 } },
            { task: 'pickpocket-men', finish: { type: 'forever' } },
        ]);
        manager.start('Bot', steps);
        await until(() => started.length === 1);
        expect(manager.get('Bot')?.index).toBe(1);
        expect(() => manager.start('bot', steps)).toThrow('Pause');
        await manager.pause('Bot');
        expect(status.task).toBeNull();
        expect(manager.get('Bot')?.status).toBe('paused');
        manager.close();
        manager = createPlanManager(scratch, async () => backend);
        fake = world(2, 10, true);
        manager.restore();
        expect(manager.active('Bot')).toBe(false);
        manager.resume('Bot');
        await until(() => started.length === 2);
        expect(manager.get('Bot')?.index).toBe(2);
        expect(manager.get('Bot')?.work?.finish.type).toBe('forever');
    } finally {
        await manager.pause('Bot');
        manager.close();
        rmSync(scratch, { recursive: true, force: true });
    }
}, 22_000);

test('appends mining without stopping runecrafting and starts after confirmed essence exhaustion', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.plan-test-'));
    const game = world(1, 99);
    const status: ReturnType<PlanBackend['status']> = { bot: 'Pirate', tasks: [], client: null, task: null };
    const started: string[] = [];
    const backend: PlanBackend = {
        status: () => status,
        async prepare() { status.client = { startedAt: new Date().toISOString(), stopping: false }; },
        async observe() { game.tick++; return game; },
        async start(name) {
            started.push(name);
            status.task = { name, startedAt: new Date().toISOString(), stopping: false };
        },
        async stop() { status.task = null; },
    };
    const manager = createPlanManager(directory, async () => backend);
    try {
        manager.start('Pirate', parseSteps([{ task: 'craft-body-runes', finish: { type: 'forever' } }]));
        await until(() => started.length === 1);
        const [next] = parseSteps([{ task: 'mine-iron-bank', finish: { type: 'forever' } }]);
        manager.queueMining('Pirate', next!);
        expect(manager.get('Pirate')?.work?.finish.type).toBe('essence-exhausted');
        expect(started).toEqual(['craft-body-runes']);
        expect(status.task?.name).toBe('craft-body-runes');
        status.task = null;
        status.lastTask = { name: 'craft-body-runes', finishedAt: new Date().toISOString(), exitCode: 0, completion: 'essence-exhausted' };
        await until(() => started.length === 2);
        expect(started[1]).toBe('mine-iron-bank');
        expect(manager.get('Pirate')?.index).toBe(1);
    } finally {
        await manager.pause('Pirate');
        manager.close();
        rmSync(directory, { recursive: true, force: true });
    }
}, 16_000);

test('advances opted-in Runecraft steps on verified exhaustion while preserving the target and live task', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.plan-test-'));
    const level = { type: 'level', skill: 'Runecraft', level: 99 } as const;
    const timed = { type: 'minutes', minutes: 30 } as const;
    const cases = [
        { bot: 'Level', finish: level, enabled: true, advances: true },
        { bot: 'Timed', finish: timed, enabled: false, advances: true },
        { bot: 'Strict', finish: level, enabled: false, advances: false },
        { bot: 'Prerequisite', finish: level, enabled: true, prerequisite: true, advances: false },
        { bot: 'Unverified', finish: level, enabled: true, unverified: true, advances: false },
        { bot: 'Failed', finish: level, enabled: true, failed: true, advances: false },
    ];
    const fixtures = cases.map(spec => {
        const { bot, finish, prerequisite } = spec;
        const game = world(80, 99);
        game.skills.push({ name: 'Runecraft', level: 90, baseLevel: 90, experience: 569_937 });
        const status: ReturnType<PlanBackend['status']> = { bot, tasks: [], client: null, task: null };
        const started: string[] = [];
        const backend: PlanBackend = {
            status: () => status,
            async prepare() { status.client = { startedAt: new Date().toISOString(), stopping: false }; },
            async observe() { game.tick++; return game; },
            async start(name) {
                started.push(name);
                status.task = { name, startedAt: new Date().toISOString(), stopping: false };
            },
            async stop() { status.task = null; },
        };
        const steps = (enabled: boolean) => parseSteps([
            { task: 'craft-body-runes', finish,
                ...(enabled && { options: { finishOnEssenceExhausted: true } }),
                ...(prerequisite && { requirements: [{ type: 'level', skill: 'Runecraft', level: 95 }] }) },
            { task: 'pickpocket-men', finish: { type: 'forever' } },
        ]);
        return { ...spec, status, started, backend, steps };
    });
    const manager = createPlanManager(directory, async bot => fixtures.find(fixture => fixture.bot === bot)!.backend);
    try {
        for (const { bot, steps, enabled } of fixtures) manager.start(bot, steps(enabled));
        await until(() => fixtures.every(({ started }) => started.length === 1));
        expect(manager.get('Prerequisite')?.work).toMatchObject({ task: 'craft-body-runes', inserted: true });

        const timer = fixtures.find(({ bot }) => bot === 'Timed')!;
        await until(() => (manager.get(timer.bot)?.elapsedMs ?? 0) > 0);
        const before = manager.get(timer.bot)!;
        const activeTask = timer.status.task;
        manager.update(timer.bot, timer.steps(true), before.revision);
        await until(() => manager.get(timer.bot)?.work?.options?.finishOnEssenceExhausted === true);
        expect(timer.status.task).toBe(activeTask);
        expect(timer.started).toEqual(['craft-body-runes']);
        expect(manager.get(timer.bot)?.work?.finish).toEqual(timed);
        expect(manager.get(timer.bot)!.elapsedMs).toBeGreaterThanOrEqual(before.elapsedMs);

        for (const { status, unverified, failed } of fixtures) {
            status.task = null;
            status.lastTask = { name: 'craft-body-runes', finishedAt: new Date().toISOString(), exitCode: failed ? 1 : 0,
                ...(unverified ? {} : { completion: 'essence-exhausted' }) };
        }
        await until(() => fixtures.every(({ bot, advances, started }) =>
            advances ? started.length === 2 : manager.get(bot)?.status === 'blocked'), 13_000);
        for (const { bot, finish, advances, started } of fixtures) {
            const saved = manager.get(bot)!;
            expect(saved.index).toBe(advances ? 1 : 0);
            expect(saved.steps[0]?.finish).toEqual(finish);
            expect(started).toEqual(advances ? ['craft-body-runes', 'pickpocket-men'] : ['craft-body-runes']);
        }
    } finally {
        await Promise.all(fixtures.map(({ bot }) => manager.pause(bot)));
        manager.close();
        rmSync(directory, { recursive: true, force: true });
    }
}, 26_000);

test('keeps the active child and credited time through plan edits and completed activity removal', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.plan-test-'));
    const game = world(80, 99, true);
    const status: ReturnType<PlanBackend['status']> = { bot: 'Bot', tasks: [], client: null, task: null };
    let starts = 0;
    let stops = 0;
    const backend: PlanBackend = {
        status: () => status,
        async prepare() { status.client = { startedAt: new Date().toISOString(), stopping: false }; },
        async observe() { game.tick++; return game; },
        async start(name) {
            expect(status.task).toBeNull();
            starts++;
            status.task = { name, startedAt: new Date().toISOString(), stopping: false };
        },
        async stop() { stops++; status.task = null; },
    };
    const manager = createPlanManager(directory, async () => backend);
    const planSteps = (minutes?: number, follow = 'mine-iron-bank') => parseSteps([
        { task: 'cooks-assistant', finish: { type: 'complete' } },
        { task: 'pickpocket-men', finish: minutes === undefined ? { type: 'forever' } : { type: 'minutes', minutes } },
        ...(minutes === undefined ? [] : [{ task: follow, finish: { type: 'forever' } }]),
    ]);
    try {
        const firstRevision = manager.start('Bot', planSteps()).revision;
        await until(() => starts === 1);
        const originalTask = status.task;
        const original = manager.get('Bot')!;
        expect(original.index).toBe(1);
        expect(() => manager.update('Bot', planSteps(5), firstRevision)).toThrow(PlanEditConflict);
        expect(() => manager.update('Bot', planSteps().slice(1), original.revision)).toThrow(PlanEditConflict);

        const db = new Database(join(directory, 'activity-plans.sqlite'));
        db.exec("CREATE TRIGGER reject_plan_edit BEFORE INSERT ON activity_plan WHEN json_extract(new.data, '$.steps[1].finish.minutes') = 7 BEGIN SELECT RAISE(ABORT, 'Test save failure'); END");
        db.close();
        expect(() => manager.update('Bot', planSteps(7), original.revision)).toThrow('Test save failure');
        expect(manager.get('Bot')?.steps).toEqual(planSteps());

        const edited = manager.update('Bot', planSteps(5), original.revision);
        const revision = edited.revision;
        expect(edited.status).toBe('running');
        expect(() => manager.update('Bot', planSteps(6), original.revision)).toThrow(PlanEditConflict);
        await until(() => (manager.get('Bot')?.elapsedMs ?? 0) > 0);
        const elapsed = manager.get('Bot')!.elapsedMs;
        expect(manager.get('Bot')?.revision).toBe(revision);
        expect(status.task).toBe(originalTask);
        expect(stops).toBe(0);

        const futureEdit = manager.update('Bot', planSteps(5, 'mine-coal-bank'), revision);
        const futureRevision = futureEdit.revision;
        expect(futureEdit.elapsedMs).toBe(elapsed);
        await until(() => (manager.get('Bot')?.elapsedMs ?? 0) > elapsed);
        expect(manager.get('Bot')?.revision).toBe(futureRevision);
        expect(status.task).toBe(originalTask);
        const beforeRemoval = manager.get('Bot')!;
        const remaining = beforeRemoval.steps.slice(1);
        expect(() => manager.update('Bot', remaining, futureRevision, [1])).toThrow('Choose completed activities');
        expect(() => manager.update('Bot', remaining, futureRevision, [0, 0])).toThrow('Choose completed activities');
        const cleaned = manager.update('Bot', remaining, futureRevision, [0]);
        expect(cleaned).toMatchObject({ index: 0, steps: remaining, status: 'running',
            elapsedMs: beforeRemoval.elapsedMs, work: beforeRemoval.work });
        expect(cleaned.revision).not.toBe(futureRevision);
        await until(() => (manager.get('Bot')?.elapsedMs ?? 0) > beforeRemoval.elapsedMs);
        expect(manager.get('Bot')?.index).toBe(0);
        expect(status.task).toBe(originalTask);
        expect(starts).toBe(1);
        expect(stops).toBe(0);
    } finally {
        await manager.pause('Bot');
        manager.close();
        rmSync(directory, { recursive: true, force: true });
    }
}, 20_000);

test('an edit during task launch restarts only after the old child stops when launch arguments change', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.plan-test-'));
    const game = world(80, 99, true);
    const status: ReturnType<PlanBackend['status']> = { bot: 'Bot', tasks: [], client: null, task: null };
    const entering = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    const targets: Array<number | undefined> = [];
    let stops = 0;
    const backend: PlanBackend = {
        status: () => status,
        async prepare() { status.client = { startedAt: new Date().toISOString(), stopping: false }; },
        async observe() { game.tick++; return game; },
        async start(name, _skill, target) {
            expect(status.task).toBeNull();
            targets.push(target);
            if (targets.length === 1) {
                entering.resolve();
                await ready.promise;
            }
            status.task = { name, startedAt: new Date().toISOString(), stopping: false };
        },
        async stop() { stops++; status.task = null; },
    };
    const manager = createPlanManager(directory, async () => backend);
    const steps = (quantity: number) => parseSteps([{ task: 'mine-iron-bank', finish: { type: 'bank-stock', quantity } }]);
    try {
        const plan = manager.start('Bot', steps(10));
        await entering.promise;
        manager.update('Bot', steps(20), plan.revision);
        expect(targets).toEqual([10]);
        ready.resolve();
        await until(() => targets.length === 2);
        expect(targets).toEqual([10, 20]);
        expect(stops).toBe(1);
        expect(manager.get('Bot')?.work?.finish).toEqual({ type: 'bank-stock', quantity: 20 });
    } finally {
        ready.resolve();
        await manager.pause('Bot');
        manager.close();
        rmSync(directory, { recursive: true, force: true });
    }
}, 15_000);

test.each([
    { label: 'banking option', steps: (edited: boolean) => parseSteps([{ task: 'pickpocket-heroes', finish: { type: 'forever' }, options: { banking: edited } }]) },
    { label: 'melee targets', steps: (edited: boolean) => parseSteps([{ task: 'train-cows', finish: {
        type: 'melee-levels', levels: { Attack: edited ? 50 : 40, Hitpoints: 60 }, style: edited ? 'Defensive' : 'Balanced',
    } }]) },
])('editing active $label relaunches the child and persists through resume', async ({ steps }) => {
    const directory = mkdtempSync(join(process.cwd(), '.plan-test-'));
    const game = world(80, 99);
    const status: ReturnType<PlanBackend['status']> = { bot: 'Bot', tasks: [], client: null, task: null };
    const launched: unknown[] = [];
    const backend: PlanBackend = {
        status: () => status,
        async prepare() { status.client = { startedAt: new Date().toISOString(), stopping: false }; },
        async observe() { game.tick++; return game; },
        async start(name, _skill, _target, options, _release, meleeGoal) {
            expect(status.task).toBeNull();
            launched.push(meleeGoal ?? (options?.banking === true));
            status.task = { name, startedAt: new Date().toISOString(), stopping: false };
        },
        async stop() { status.task = null; },
    };
    let manager = createPlanManager(directory, async () => backend);
    const expected = (edited: boolean) => {
        const { finish, options } = steps(edited)[0]!;
        return finish.type === 'melee-levels' ? finish : options?.banking === true;
    };
    try {
        manager.start('Bot', steps(false));
        await until(() => launched.length === 1);
        manager.update('Bot', steps(true), manager.get('Bot')!.revision);
        await until(() => launched.length === 2);
        expect(launched).toEqual([expected(false), expected(true)]);
        await manager.pause('Bot');
        manager.close();
        manager = createPlanManager(directory, async () => backend);
        expect(manager.get('Bot')?.steps).toEqual(steps(true));
        manager.resume('Bot');
        await until(() => launched.length === 3);
        expect(launched).toEqual([expected(false), expected(true), expected(true)]);
    } finally {
        await manager.pause('Bot');
        manager.close();
        rmSync(directory, { recursive: true, force: true });
    }
}, 20_000);

test('keeps a running child on its release and launches the next step from the updated policy', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.plan-test-'));
    const game = world(1, 99);
    const status: ReturnType<PlanBackend['status']> = { bot: 'Bot', tasks: [], client: null, task: null };
    const revisions: Array<string | undefined> = [];
    let stops = 0;
    let newPolicyChecks = 0;
    let release = { revision: 'a'.repeat(40), value: builtInPolicy };
    const backend: PlanBackend = {
        status: () => status,
        async prepare() { status.client = { startedAt: new Date().toISOString(), stopping: false }; },
        async observe() { game.tick++; return game; },
        async start(name, _skill, _target, _options, selected) {
            expect(status.task).toBeNull();
            revisions.push(selected?.revision);
            status.task = { name, startedAt: new Date().toISOString(), stopping: false };
        },
        async stop() { stops++; status.task = null; },
    };
    const manager = createPlanManager(directory, async () => backend, {
        async load() { return release; },
        current: () => release.value,
    });
    try {
        manager.start('Bot', parseSteps([
            { task: 'pickpocket-men', finish: { type: 'level', skill: 'Thieving', level: 2 } },
            { task: 'pickpocket-men', finish: { type: 'forever' } },
        ]));
        await until(() => revisions.length === 1);
        const client = status.client;
        const task = status.task;
        const firstRevision = release.revision;
        release = { revision: 'b'.repeat(40), value: {
            ...builtInPolicy,
            finished(...args: Parameters<typeof builtInPolicy.finished>) {
                newPolicyChecks++;
                return builtInPolicy.finished(...args);
            },
        } };
        const updatedAtTick = game.tick;
        await until(() => game.tick > updatedAtTick);
        expect(status.task).toBe(task);
        expect(stops).toBe(0);
        expect(newPolicyChecks).toBe(0);
        game.skills.find(skill => skill.name === 'Thieving')!.baseLevel = 2;
        await until(() => revisions.length === 2);
        expect(revisions).toEqual([firstRevision, release.revision]);
        expect(status.client).toBe(client);
        expect(stops).toBe(1);
    } finally {
        await manager.pause('Bot');
        manager.close();
        rmSync(directory, { recursive: true, force: true });
    }
}, 20_000);

test('edits legacy completed plans without restarting and rejects a persisted stale revision', () => {
    const directory = mkdtempSync(join(process.cwd(), '.plan-test-'));
    const manager = createPlanManager(directory, async () => { throw new Error('Editing must not start a task.'); });
    try {
        const steps = parseSteps([{ task: 'cooks-assistant', finish: { type: 'complete' } }]);
        const db = new Database(join(directory, 'activity-plans.sqlite'));
        db.run('INSERT INTO activity_plan (bot, data) VALUES (?, ?)', ['Bot', JSON.stringify({
            bot: 'Bot', steps, index: 1, elapsedMs: 0, status: 'complete',
        })]);
        db.close();

        expect(manager.get('Bot')?.revision).toBe('legacy');
        const next = parseSteps([{ task: 'pickpocket-men', finish: { type: 'forever' } }]);
        const updated = manager.update('Bot', [...steps, ...next], 'legacy');
        expect(updated).toMatchObject({ index: 1, status: 'paused', steps: [...steps, ...next] });
        expect(manager.active('Bot')).toBe(false);
        expect(manager.get('Bot')?.revision).toBe(updated.revision);
        expect(() => manager.update('Bot', steps, 'legacy')).toThrow(PlanEditConflict);
    } finally {
        manager.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('the plan API clears the last row of a completed plan only on a worker that supports removal', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.plan-test-'));
    const manager = createPlanManager(directory, async () => { throw new Error('Removing a completed activity must not start a task.'); });
    try {
        const steps = parseSteps([{ task: 'cooks-assistant', finish: { type: 'complete' } }]);
        const db = new Database(join(directory, 'activity-plans.sqlite'));
        db.run('INSERT INTO activity_plan (bot, data) VALUES (?, ?)', ['Bot', JSON.stringify({
            bot: 'Bot', steps, index: 1, elapsedMs: 0, status: 'complete',
        })]);
        db.close();

        const { supportsCompletedRemoval: _capability, ...oldPlans } = manager;
        const runtime = {
            botProfile: async () => ({ name: 'Bot' }), botRoster: {}, plans: oldPlans, invalidateSnapshot: () => {},
            demo: { allowed: async () => true }, sessions: { authenticate: async () => undefined },
            isPlanEditConflict: (error: unknown) => error instanceof PlanEditConflict,
        } as unknown as DashboardWorkerApiRuntime;
        const request = (body?: object) => handleWorkerRequest(new Request('https://fleet.test/bots/activity?view=plan&bot=Bot',
            body && { method: 'POST', body: JSON.stringify(body) }), runtime);
        const edit = { action: 'update', steps: [], expectedRevision: 'legacy', removedCompletedIndexes: [0] };
        const response = await (await request()).json();
        expect(response.canRemoveCompleted).toBe(false);
        expect(response.catalog.find((entry: { id: string }) => entry.id === 'fish-sharks-cook')).toMatchObject({
            bankStockItem: 'cooked sharks', finishModes: ['minutes', 'level', 'bank-stock', 'forever'],
        });
        expect((await request(edit)).status).toBe(503);
        expect(manager.get('Bot')?.index).toBe(1);

        runtime.plans = manager;
        expect(await (await request()).json()).toMatchObject({ canRemoveCompleted: true });
        expect((await request({ ...edit, removedCompletedIndexes: [] })).status).toBe(400);
        const result = await request(edit);
        expect(result.status).toBe(200);
        expect(await result.json()).toMatchObject({ canRemoveCompleted: true, plan: { index: 0, status: 'complete', steps: [] } });
        expect(manager.get('Bot')).toMatchObject({ index: 0, status: 'complete', steps: [] });
        expect(manager.active('Bot')).toBe(false);
    } finally {
        manager.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

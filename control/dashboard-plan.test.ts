import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BotWorldState } from '../sdk/types';
import { nextWork, parseSteps } from './dashboard-plan';
import { createPlanManager, type PlanBackend } from './dashboard-plan-runner';
import { dashboardRoster } from './dashboard-roster';

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

async function until(check: () => boolean) {
    const end = Date.now() + 9_000;
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

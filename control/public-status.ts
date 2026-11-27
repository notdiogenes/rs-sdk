import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostedBotName, hostedBotState, isFreshBotState } from './hosted-bot';
import { controllerRequest, dashboardActivity, handleActivity, type ControllerStatus } from './dashboard-activity';
import { dashboardSessions } from './dashboard-session';
import { dashboardDiagnostics } from './dashboard-diagnostics';
import { dashboardLastActivity } from './dashboard-last-activity';
import type { BotObservation, LastActivity } from './dashboard-last-activity';
import type { BotWorldState } from '../sdk/types';
import { dashboardFleetStats } from './dashboard-fleet-stats';
import { dashboardQuestPoints, loadQuestCatalog } from './dashboard-quests';
import { fleetPage } from './dashboard-fleet-page';
import { dashboardDemo, isBundledTask } from './dashboard-demo';

const [botDirectory, controlConfig] = process.argv.slice(2);
if (!botDirectory || !controlConfig) throw new Error('Expected the bot directory and control config directory');
const botsDir = botDirectory;
const configDir = controlConfig;
const token = (await Bun.file(join(configDir, 'token')).text()).trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid control API token');
const questCatalog = await loadQuestCatalog();
const fleetStyle = await Bun.file(join(import.meta.dir, 'dashboard-fleet.css')).text();
const controls = await Bun.file(join(import.meta.dir, 'public-status-controls.js')).text();
const runtimeDir = join(dirname(configDir), 'rs-sdk-public-status');
const diagnostics = dashboardDiagnostics(runtimeDir, token);
const demo = dashboardDemo(runtimeDir, botsDir, configDir, token);
const rosterControllers = new Map<string, ReturnType<typeof dashboardDemo>>();
const recordActivity = dashboardLastActivity(runtimeDir);
const recordStats = dashboardFleetStats(runtimeDir);
const sessions = dashboardSessions(runtimeDir, async () => {
    const site = await Bun.file('/etc/nginx/sites-enabled/rs-sdk-control-hostname').text();
    const host = /^\s*server_name\s+([0-9]+-[0-9]+-[0-9]+-[0-9]+\.sslip\.io);/m.exec(site)?.[1];
    if (!host) throw new Error('The managed HTTPS hostname is unavailable.');
    return `https://${host}`;
}, join(import.meta.dir, 'dashboard-enrollment.json'));

export type Bot = {
    name: string;
    status: 'Online' | 'Offline' | 'Unknown';
    activity: string;
    location?: string;
    lastActivity: LastActivity | null;
    stats?: ReturnType<typeof recordStats>;
    heartbeat?: number;
    inCombat?: boolean;
    control?: ControlActivity;
};
export type ControlActivity = {
    bot: string;
    label?: string;
    running: boolean;
    startedAt?: string;
    transitioning?: boolean;
    failed?: boolean;
    waiting?: string;
};
export type Snapshot = { bots: Bot[]; checkedAt: string };
const refreshSeconds = 15;
const displayTimeZone = 'America/New_York';
let cached: Snapshot | undefined;
let expiresAt = 0;
let refreshing: Promise<Snapshot> | undefined;

async function primaryStatus(): Promise<ControllerStatus> {
    const response = await controllerRequest('/v1/status', `Bearer ${token}`, undefined, AbortSignal.timeout(3000));
    if (!response.ok) throw new Error('The primary controller is unavailable');
    return response.json() as Promise<ControllerStatus>;
}

function controlActivity({ bot, task, starting, startError, lastTask }: ReturnType<typeof dashboardActivity>): ControlActivity | undefined {
    if (typeof bot !== 'string' || !hostedBotName.test(bot)) return;
    if (typeof task?.name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(task.name)) {
        const label = task.activity ?? task.name.replaceAll('-', ' ');
        return {
            bot, label: task.stopping ? `Stopping ${label}` : label, running: true,
            startedAt: task.startedAt, transitioning: task.stopping,
            waiting: task.recovery ? `Recovering HP · resumes at ${task.recovery.resumeAt} HP` : undefined,
        };
    }
    if (starting) return { bot, label: `Starting ${starting.replaceAll('-', ' ')}`, running: true, transitioning: true };
    if (startError) return { bot, label: 'Activity could not start', running: false, failed: true };
    if (lastTask && lastTask.exitCode !== 0) {
        return { bot, label: 'Last activity exited with an error', running: false, failed: true };
    }
    return { bot, running: false };
}

async function botProfile(name: string) {
    if (!hostedBotName.test(name)) return null;
    const demoProfile = await demo.profile().catch(() => null);
    if (demoProfile?.name.toLowerCase() === name.toLowerCase()) {
        return { name: demoProfile.name, directory: demoProfile.directory, worker: demo };
    }
    const directory = join(botsDir, name);
    if (!await Bun.file(join(directory, 'bot.env')).exists()) return null;
    return { name, directory, worker: rosterControllers.get(name.toLowerCase()) };
}

function workerStatus(name: string, worker?: ReturnType<typeof dashboardDemo>) {
    return worker?.dashboardActivity(worker.status(name));
}

function usesPrimary(name: string, primary: ControllerStatus | null, worker?: ReturnType<typeof dashboardDemo>) {
    if (primary?.bot?.toLowerCase() !== name.toLowerCase()) return false;
    const secondary = workerStatus(name, worker);
    return !!primary.client || !!dashboardActivity(primary).starting || (!secondary?.client && !secondary?.starting);
}

async function handleBotActivity(request: Request, name: string, session?: string) {
    const reply = (body: object, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    if (!session && !await demo.allowed(request)) return reply({ error: 'Unauthorized' }, 401);
    try {
        const profile = await botProfile(name);
        if (!profile) return reply({ error: 'Bot profile not found.' }, 404);
        const primary = await primaryStatus();
        const isPrimary = primary.bot?.toLowerCase() === profile.name.toLowerCase();
        const primaryActive = isPrimary && (primary.client || dashboardActivity(primary).starting);
        const body = request.method === 'POST' ? await request.clone().json().catch(() => null) : null;
        const bundled = body?.action === 'start' && isBundledTask(body.task) && !primary.tasks.includes(body.task);
        if (primaryActive && bundled) {
            return reply({ error: 'Stop the primary game client before starting this bundled activity.' }, 409);
        }
        if (isPrimary && !bundled && usesPrimary(profile.name, primary, profile.worker)) {
            const response = await handleActivity(request, token, session, primary.bot ?? undefined);
            if (!primaryActive && request.method === 'GET' && response.ok) {
                const status = await response.json();
                const tasks = profile.worker?.status(profile.name).tasks ?? demo.status(null).tasks;
                return reply({ ...status, tasks: [...new Set([...status.tasks, ...tasks])] }, 200);
            }
            return response;
        }
        let worker = profile.worker;
        if (!worker) {
            worker = dashboardDemo(runtimeDir, botsDir, configDir, token, profile);
            rosterControllers.set(profile.name.toLowerCase(), worker);
        }
        return worker.handleActivity(request, token, session, profile.name);
    } catch {
        return reply({ error: 'The bot controller is temporarily unavailable.' }, 503);
    }
}

async function inventory(name: string) {
    const profile = await botProfile(name);
    if (!profile) return null;
    const result = await hostedBotState(profile.name, profile.directory);
    const empty = { bot: profile.name, items: [] };
    if (result?.botStatus === 'stale') return { ...empty, availability: 'stale' };
    if (!result || result.botStatus === 'dead' || !result.state?.inGame) return { ...empty, availability: 'offline' };
    if (!isFreshBotState(result.stateAge)) return { ...empty, availability: 'stale' };
    return {
        bot: profile.name, availability: 'live', capturedAt: Date.now() - result.stateAge,
        items: result.state.inventory.map(({ slot, name, count }) => ({ slot, name, count })).sort((a, b) => a.slot - b.slot),
    };
}

async function botDiagnostics(name: string) {
    const profile = await botProfile(name);
    if (!profile) return null;
    const [primary, result] = await Promise.all([
        primaryStatus().catch(() => null),
        hostedBotState(profile.name, profile.directory).catch(() => undefined),
    ]);
    const worker = profile.worker;
    const isPrimary = primary && usesPrimary(profile.name, primary, worker);
    const controller = isPrimary ? dashboardActivity(primary)
        : workerStatus(profile.name, worker) ??
            { bot: profile.name, tasks: [], client: null, task: null, startError: null, starting: null };
    const historical = isPrimary ? await diagnostics().catch(() => null) : null;
    const primaryHistory = historical?.reading?.controller?.bot === primary?.bot ? historical : null;
    const { movedAt, gainedXpAt } = recordActivity(profile.name);
    const state = result?.state;
    const player = state?.player;
    const availability = result === undefined ? 'unavailable'
        : result?.botStatus === 'stale' ? 'stale'
            : !result || result.botStatus === 'dead' || !state?.inGame || !player ? 'offline'
                : isFreshBotState(result.stateAge) ? 'live' : 'stale';
    return {
        reading: {
            bot: profile.name, checkedAt: new Date().toISOString(), controller,
            game: {
                availability, stateAgeMs: Number.isFinite(result?.stateAge) ? result?.stateAge : null,
                tick: state?.tick,
                questPoints: state?.questPoints,
                player: player ? {
                    x: player.worldX, z: player.worldZ, plane: player.level,
                    hp: player.hp, maxHp: player.maxHp, inCombat: player.combat?.inCombat,
                } : undefined,
            },
            movedAt: movedAt ?? primaryHistory?.reading?.movedAt ?? null,
            gainedXpAt: gainedXpAt ?? primaryHistory?.reading?.gainedXpAt ?? null,
        },
        history: primaryHistory?.history ?? worker?.recentEvents() ?? [],
    };
}

async function listBots(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    const names = await Promise.all(entries.filter(entry => entry.isDirectory() && hostedBotName.test(entry.name))
        .map(async ({ name }) => await Bun.file(join(directory, name, 'bot.env')).exists() ? name : undefined));
    return names.filter(name => name !== undefined).sort((a, b) => a.localeCompare(b));
}

async function botStatus(name: string, directory: string, control?: ControlActivity): Promise<Bot> {
    const task = control?.label;
    const row = (fields: Omit<Bot, 'name' | 'lastActivity' | 'stats'>, observation?: BotObservation,
        state?: BotWorldState): Bot => {
        let lastActivity = null;
        let stats;
        try { lastActivity = recordActivity(name, observation).lastActivity; } catch { /* Show the other status fields. */ }
        try { stats = recordStats(name, state, fields.heartbeat); } catch { /* Show the other status fields. */ }
        return { name, ...fields, lastActivity, stats, control };
    };
    try {
        const result = await hostedBotState(name, directory);
        if (!result || result.botStatus === 'dead') return row({ status: 'Offline', activity: task ?? '—' });
        if (result.botStatus !== 'stale' && isFreshBotState(result.stateAge)) {
            const player = result.state?.player;
            if (!result.state?.inGame || !player) return row({ status: 'Offline', activity: task ?? '—' });
            const { worldX, worldZ, level } = player;
            const plane = Number.isInteger(level) && level >= 0 && level <= 3 ? level : null;
            const hasPosition = Number.isSafeInteger(worldX) && Number.isSafeInteger(worldZ);
            const location = hasPosition
                ? `X ${worldX}, Z ${worldZ}${plane === null ? '' : ` · Plane ${plane}`}` : undefined;
            return row({
                status: 'Online', location, heartbeat: Date.now() - result.stateAge,
                inCombat: player.combat?.inCombat,
                activity: task ?? (player.combat?.inCombat ? 'In combat' : 'No activity reported'),
            }, {
                position: hasPosition ? [worldX, worldZ, plane] : undefined,
                xp: Object.fromEntries((result.state.skills ?? []).map(skill => [skill.name, skill.experience])),
                inCombat: player.combat?.inCombat,
            }, result.state);
        }
    } catch {
        // Credentials and gateway errors are private. Render an unknown status.
    }
    return row({ status: 'Unknown', activity: task ?? '—' });
}

async function collect(directory: string): Promise<Snapshot> {
    const [names, primary, demoProfile] = await Promise.all([
        listBots(directory), primaryStatus().catch(() => null), demo.profile().catch(() => null),
    ]);
    const roster = new Map(names.map(name => [name.toLowerCase(), { name, directory: join(directory, name) }]));
    if (demoProfile) roster.set(demoProfile.name.toLowerCase(), demoProfile);
    const profiles = [...roster.values()].sort((a, b) => a.name.localeCompare(b.name));
    const bots = await Promise.all(profiles.map(profile => {
        const worker = demoProfile?.name === profile.name ? demo : rosterControllers.get(profile.name.toLowerCase());
        const controller = primary && usesPrimary(profile.name, primary, worker) ? dashboardActivity(primary)
            : workerStatus(profile.name, worker);
        return botStatus(profile.name, profile.directory, controller && controlActivity(controller));
    }));
    return { bots, checkedAt: new Date().toISOString() };
}

async function snapshot(directory: string) {
    if (cached && Date.now() < expiresAt) return cached;
    return refreshSnapshot(directory);
}

function refreshSnapshot(directory: string) {
    return refreshing ??= collect(directory).then(result => {
        cached = result;
        expiresAt = Date.now() + refreshSeconds * 1000;
        return result;
    }).finally(() => { refreshing = undefined; });
}

const collectInBackground = () => void refreshSnapshot(botsDir).catch(() => console.error('Dashboard bot sample failed'));
collectInBackground();
setInterval(collectInBackground, refreshSeconds * 1000).unref();

Bun.serve({
    hostname: '127.0.0.1',
    port: 3721,
    maxRequestBodySize: 1024,
    async fetch(request) {
        const { pathname, searchParams } = new URL(request.url);
        if (pathname === '/bots/activity') {
            const demoRoute = searchParams.get('demo');
            if (demoRoute !== null) {
                if (request.method === 'POST' && (demoRoute === 'task/stop' || demoRoute === 'client/stop') &&
                    await demo.allowed(request)) await demo.cancelStart();
                return demo.handle(request, demoRoute);
            }
            const action = searchParams.get('session');
            if (action) return sessions.handle(request, action);
            const session = await sessions.authenticate(request).catch(() => undefined);
            const view = searchParams.get('view');
            const bot = searchParams.get('bot');
            if (view === 'inventory') {
                const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
                if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
                if (!session) return Response.json({ error: 'Sign in to view inventory.' }, { status: 401, headers });
                headers['Set-Cookie'] = session;
                try {
                    const result = bot && await inventory(bot);
                    return result ? Response.json(result, { headers })
                        : Response.json({ error: 'Bot profile not found.' }, { status: 404, headers });
                } catch {
                    return Response.json({ error: 'Current inventory is temporarily unavailable.' }, { status: 503, headers });
                }
            }
            if (view === 'diagnostics' && bot !== null) {
                const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
                if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
                if (!session && !await demo.allowed(request)) {
                    return Response.json({ error: 'Sign in to view diagnostics.' }, { status: 401, headers });
                }
                if (session) headers['Set-Cookie'] = session;
                try {
                    const report = await botDiagnostics(bot);
                    return report ? Response.json(report, { headers })
                        : Response.json({ error: 'Bot profile not found.' }, { status: 404, headers });
                } catch {
                    return Response.json({ error: 'Diagnostics are temporarily unavailable.' }, { status: 503, headers });
                }
            }
            if (view === 'diagnostics' || view === 'fleet-data' || view === 'quests') {
                const headers = { 'Cache-Control': 'no-store' };
                if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
                if (!session) return Response.json({ error: 'Sign in to view this dashboard data.' }, { status: 401, headers });
                try {
                    const current = view === 'diagnostics' ? null : await snapshot(botsDir);
                    const payload = current === null ? await diagnostics() : view === 'quests'
                        ? {
                            scores: await dashboardQuestPoints(current.bots.map(({ name, stats }) => ({ name, score: stats?.journal?.score }))),
                            journals: Object.fromEntries(current.bots.map(({ name, stats }) => [name, stats?.journal ?? null])),
                        }
                        : current.bots.map(({ name, stats }) => ({
                            name, skills: stats?.skills, bank: stats?.bank, xpGained: stats?.xpGained,
                        }));
                    return Response.json(payload, { headers: { ...headers, 'Set-Cookie': session } });
                } catch {
                    return Response.json({ error: 'Dashboard data is temporarily unavailable.' }, { status: 503, headers });
                }
            }
            const response = bot === null ? await handleActivity(request, token, session)
                : await handleBotActivity(request, bot, session);
            if (session) response.headers.set('Set-Cookie', session);
            return response;
        }
        if (pathname !== '/bots') return new Response(null, { status: 404 });
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
        }
        let data: Snapshot | undefined;
        try { data = await snapshot(botsDir); } catch { /* display the unavailable page */ }
        const nonce = crypto.randomUUID();
        return new Response(request.method === 'HEAD' ? null : fleetPage({ nonce, data, questCatalog, fleetStyle, controls, refreshSeconds, displayTimeZone }), {
            status: data ? 200 : 503,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
                'X-Content-Type-Options': 'nosniff',
                'X-Robots-Tag': 'noindex',
            },
        });
    },
});

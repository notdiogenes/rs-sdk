import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostedBotName, hostedBotState, isFreshBotState } from './hosted-bot';
import { controllerRequest, dashboardActivity, handleActivity } from './dashboard-activity';
import { dashboardSessions } from './dashboard-session';
import { dashboardDiagnostics } from './dashboard-diagnostics';
import { dashboardLastActivity } from './dashboard-last-activity';
import type { BotObservation, LastActivity } from './dashboard-last-activity';
import type { BotWorldState } from '../sdk/types';
import { dashboardFleetStats } from './dashboard-fleet-stats';
import { dashboardQuestPoints } from './dashboard-quests';
import { fleetPage } from './dashboard-fleet-page';

const [botsDir, configDir] = process.argv.slice(2);
if (!botsDir || !configDir) throw new Error('Expected the bot directory and control config directory');
const token = (await Bun.file(join(configDir, 'token')).text()).trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid control API token');
const fleetStyle = await Bun.file(join(import.meta.dir, 'dashboard-fleet.css')).text();
const controls = await Bun.file(join(import.meta.dir, 'public-status-controls.js')).text();
const runtimeDir = join(dirname(configDir), 'rs-sdk-public-status');
const diagnostics = dashboardDiagnostics(runtimeDir, token);
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
};
export type ControlActivity = {
    bot: string;
    label?: string;
    running: boolean;
    startedAt?: string;
    transitioning?: boolean;
    failed?: boolean;
};
export type Snapshot = { bots: Bot[]; checkedAt: string; managed?: ControlActivity };
const refreshSeconds = 15;
const displayTimeZone = 'America/New_York';
let cached: Snapshot | undefined;
let expiresAt = 0;
let refreshing: Promise<Snapshot> | undefined;

async function controlActivity(): Promise<ControlActivity | undefined> {
    try {
        const response = await controllerRequest('/v1/status', `Bearer ${token}`, undefined, AbortSignal.timeout(3000));
        if (!response.ok) return;
        const { bot, task, starting, startError, lastTask } = dashboardActivity(await response.json());
        if (typeof bot !== 'string' || !hostedBotName.test(bot)) return;
        if (typeof task?.name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(task.name)) {
            const label = task.name.replaceAll('-', ' ');
            return { bot, label: task.stopping ? `Stopping ${label}` : label, running: true, startedAt: task.startedAt, transitioning: task.stopping };
        }
        if (starting) return { bot, label: `Starting ${starting.replaceAll('-', ' ')}`, running: true, transitioning: true };
        if (startError) return { bot, label: 'Activity could not start', running: false, failed: true };
        if (lastTask && lastTask.exitCode !== 0) {
            return { bot, label: 'Last activity exited with an error', running: false, failed: true };
        }
        return { bot, running: false };
    } catch {
        // Game status remains available if the control API is unavailable.
    }
}

async function listBots(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    const names = await Promise.all(entries.filter(entry => entry.isDirectory() && hostedBotName.test(entry.name))
        .map(async ({ name }) => await Bun.file(join(directory, name, 'bot.env')).exists() ? name : undefined));
    return names.filter(name => name !== undefined).sort((a, b) => a.localeCompare(b));
}

async function botStatus(name: string, directory: string, managed?: ControlActivity): Promise<Bot> {
    const task = managed?.bot === name ? managed.label : undefined;
    const row = (fields: Omit<Bot, 'name' | 'lastActivity' | 'stats'>, observation?: BotObservation,
        state?: BotWorldState): Bot => {
        let lastActivity = null;
        let stats;
        try { lastActivity = recordActivity(name, observation); } catch { /* Show the other status fields. */ }
        try { stats = recordStats(name, state, fields.heartbeat); } catch { /* Show the other status fields. */ }
        return { name, ...fields, lastActivity, stats };
    };
    try {
        const result = await hostedBotState(name, join(directory, name));
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
    const [names, activity] = await Promise.all([listBots(directory), controlActivity()]);
    const bots = await Promise.all(names.map(name => botStatus(name, directory, activity)));
    return { bots, checkedAt: new Date().toISOString(), managed: activity };
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
            const action = searchParams.get('session');
            if (action) return sessions.handle(request, action);
            const session = await sessions.authenticate(request).catch(() => undefined);
            const view = searchParams.get('view');
            if (view === 'diagnostics' || view === 'fleet-data' || view === 'quests') {
                const headers = { 'Cache-Control': 'no-store' };
                if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
                if (!session) return Response.json({ error: 'Sign in to view this dashboard data.' }, { status: 401, headers });
                try {
                    const current = view === 'diagnostics' ? null : await snapshot(botsDir);
                    const payload = current === null ? await diagnostics() : view === 'quests'
                        ? await dashboardQuestPoints(current.bots.map(bot => bot.name))
                        : current.bots.map(({ name, stats }) => ({ name, ...stats }));
                    return Response.json(payload, { headers: { ...headers, 'Set-Cookie': session } });
                } catch {
                    return Response.json({ error: 'Dashboard data is temporarily unavailable.' }, { status: 503, headers });
                }
            }
            const response = await handleActivity(request, token, session);
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
        return new Response(request.method === 'HEAD' ? null : fleetPage({ nonce, data, fleetStyle, controls, refreshSeconds, displayTimeZone }), {
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

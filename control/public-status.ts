import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostedBotName, hostedBotState, isFreshBotState } from './hosted-bot';
import { controllerRequest, dashboardActivity, handleActivity } from './dashboard-activity';
import { dashboardSessions } from './dashboard-session';

const [botsDir, configDir] = process.argv.slice(2);
if (!botsDir || !configDir) throw new Error('Expected the bot directory and control config directory');
const token = (await Bun.file(join(configDir, 'token')).text()).trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid control API token');
const controls = await Bun.file(join(import.meta.dir, 'public-status-controls.js')).text();
const sessions = dashboardSessions(join(dirname(configDir), 'rs-sdk-public-status'), async () => {
    const site = await Bun.file('/etc/nginx/sites-enabled/rs-sdk-control-hostname').text();
    const host = /^\s*server_name\s+([0-9]+-[0-9]+-[0-9]+-[0-9]+\.sslip\.io);/m.exec(site)?.[1];
    if (!host) throw new Error('The managed HTTPS hostname is unavailable.');
    return `https://${host}`;
}, join(import.meta.dir, 'dashboard-enrollment.json'));

type Bot = { name: string; status: 'Online' | 'Offline' | 'Unknown'; activity: string; location?: string };
type ControlActivity = { bot: string; label?: string; running: boolean };
type Snapshot = { bots: Bot[]; checkedAt: string; managed?: ControlActivity };
const refreshSeconds = 15;
let cached: Snapshot | undefined;
let expiresAt = 0;
let refreshing: Promise<Snapshot> | undefined;

async function controlActivity(): Promise<ControlActivity | undefined> {
    try {
        const response = await controllerRequest('/v1/status', `Bearer ${token}`, undefined, AbortSignal.timeout(3000));
        if (!response.ok) return;
        const { bot, task, starting, startError } = dashboardActivity(await response.json());
        if (typeof bot !== 'string' || !hostedBotName.test(bot)) return;
        if (typeof task?.name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(task.name)) {
            const label = task.name.replaceAll('-', ' ');
            return { bot, label: task.stopping ? `Stopping ${label}` : label, running: true };
        }
        if (starting) return { bot, label: `Starting ${starting.replaceAll('-', ' ')}`, running: true };
        if (startError) return { bot, label: 'Activity could not start', running: false };
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
    try {
        const result = await hostedBotState(name, join(directory, name));
        if (!result || result.botStatus === 'dead') return { name, status: 'Offline', activity: task ?? '—' };
        if (result.botStatus !== 'stale' && isFreshBotState(result.stateAge)) {
            const player = result.state?.player;
            if (!result.state?.inGame || !player) return { name, status: 'Offline', activity: task ?? '—' };
            const { worldX, worldZ, level } = player;
            const plane = Number.isInteger(level) && level >= 0 && level <= 3 ? ` · Plane ${level}` : '';
            const location = Number.isSafeInteger(worldX) && Number.isSafeInteger(worldZ)
                ? `X ${worldX}, Z ${worldZ}${plane}` : undefined;
            return {
                name, status: 'Online', location,
                activity: task ?? (player.combat?.inCombat ? 'In combat' : 'No activity reported'),
            };
        }
    } catch {
        // Credentials and gateway errors are private. Render an unknown status.
    }
    return { name, status: 'Unknown', activity: task ?? '—' };
}

async function collect(directory: string): Promise<Snapshot> {
    const [names, activity] = await Promise.all([listBots(directory), controlActivity()]);
    const bots = await Promise.all(names.map(name => botStatus(name, directory, activity)));
    return { bots, checkedAt: new Date().toISOString(), managed: activity };
}

async function snapshot(directory: string) {
    if (cached && Date.now() < expiresAt) return cached;
    return refreshing ??= collect(directory).then(result => {
        cached = result;
        expiresAt = Date.now() + refreshSeconds * 1000;
        return result;
    }).finally(() => { refreshing = undefined; });
}

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function render(nonce: string, data?: Snapshot) {
    const rows = data?.bots.map(({ name, status, activity, location }) => `<tr><th scope="row">${escape(name)}</th>
        <td><span class="${status.toLowerCase()}">${status}</span></td><td data-activity>${escape(activity)}</td>
        <td>${escape(location ?? '—')}</td>
        <td>${data.managed?.bot === name ? `<button type="button" data-bot="${escape(name)}" data-action="${data.managed.running ? 'stop' : 'start'}">${data.managed.running ? 'Stop activity' : 'Start activity'}</button>` : '—'}</td></tr>`).join('');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bot status</title>
<style>
  :root { color-scheme: light dark; font: 1rem/1.5 system-ui, sans-serif; }
  body { margin: 0; }
  main { max-width: 44rem; padding: 2rem 1rem; margin: 0 auto; }
  h1 { margin: 0 0 .25rem; }
  p { color: GrayText; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .7rem .4rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, Canvas); overflow-wrap: anywhere; }
  td span { display: inline-block; font-weight: 600; padding: .1rem .55rem; border-radius: 1rem; }
  .online { background: #d9f4e4; color: #164a2b; }
  .offline { background: #e9e9ea; color: #35373b; }
  .unknown { background: #fff0c8; color: #644306; }
  button, input, select { font: inherit; }
  button { padding: .35rem .55rem; cursor: pointer; }
  dialog { max-width: min(26rem, 85vw); border: 1px solid GrayText; border-radius: .5rem; }
  dialog::backdrop { background: #0008; }
  form { display: grid; gap: .75rem; }
  form label { display: grid; gap: .25rem; }
  form [hidden] { display: none; }
  form h2, form p { margin: 0; }
</style>
</head>
<body><main>
<h1>Bot status</h1>
<button type="button" id="dashboard-account">Sign in</button>
${data ? `<p>Checked <time datetime="${data.checkedAt}">${data.checkedAt.slice(11, 19)} UTC</time></p>` : ''}
${rows ? `<table aria-label="Bot status"><thead><tr><th scope="col">Bot</th><th scope="col">Status</th><th scope="col">Activity</th><th scope="col">Location</th><th scope="col">Controls</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p>${data ? 'No bots configured.' : 'Bot status is temporarily unavailable.'}</p>`}
</main>
<dialog aria-labelledby="activity-title"><form>
  <h2 id="activity-title"></h2>
  <label id="activity-task" hidden>Activity <select></select></label>
  <p role="status" aria-live="polite"></p>
  <div><button type="submit"></button> <button type="button" id="activity-close">Close</button></div>
</form></dialog>
<dialog id="dashboard-sign-in" aria-labelledby="sign-in-title"><form>
  <h2 id="sign-in-title">Dashboard sign-in</h2>
  <label>Dashboard password <input id="dashboard-password" type="password" autocomplete="current-password" required autofocus></label>
  <p role="status" aria-live="polite"></p>
  <div><button type="submit">Sign in</button> <button type="button">Close</button></div>
</form></dialog>
<script nonce="${nonce}" data-refresh="${refreshSeconds}">${controls}</script>
</body></html>`;
}

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
        return new Response(request.method === 'HEAD' ? null : render(nonce, data), {
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

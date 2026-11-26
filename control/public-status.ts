import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostedBotName, hostedBotState, isFreshBotState } from './hosted-bot';

const [botsDir, configDir] = process.argv.slice(2);
if (!botsDir || !configDir) throw new Error('Expected the bot directory and control config directory');
const token = (await Bun.file(join(configDir, 'token')).text()).trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid control API token');

type Bot = { name: string; status: 'Online' | 'Offline' | 'Unknown'; activity: string; location?: string };
type ControlActivity = { bot: string; label: string } | undefined;
type Snapshot = { bots: Bot[]; checkedAt: string };
const refreshSeconds = 15;
let cached: Snapshot | undefined;
let expiresAt = 0;
let refreshing: Promise<Snapshot> | undefined;

async function controlActivity(): Promise<ControlActivity> {
    try {
        const response = await fetch('http://127.0.0.1:3719/v1/status', {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(3000),
            redirect: 'error',
        });
        if (!response.ok) return;
        const { bot, task, client } = await response.json() as {
            bot?: unknown; task?: { name?: unknown; stopping?: boolean }; client?: { stopping?: boolean };
        };
        if (typeof bot !== 'string' || !hostedBotName.test(bot) || !client) return;
        if (typeof task?.name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(task.name)) {
            const label = task.name.replaceAll('-', ' ');
            return { bot, label: task.stopping ? `Stopping ${label}` : label };
        }
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

async function botStatus(name: string, directory: string, managed: ControlActivity): Promise<Bot> {
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
    return { bots, checkedAt: new Date().toISOString() };
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

function render(data?: Snapshot) {
    const rows = data?.bots.map(({ name, status, activity, location }) => `<tr><th scope="row">${escape(name)}</th>
        <td><span class="${status.toLowerCase()}">${status}</span></td><td>${escape(activity)}</td>
        <td>${escape(location ?? '—')}</td></tr>`).join('');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refreshSeconds}">
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
</style>
</head>
<body><main>
<h1>Bot status</h1>
${data ? `<p>Checked <time datetime="${data.checkedAt}">${data.checkedAt.slice(11, 19)} UTC</time></p>` : ''}
${rows ? `<table aria-label="Bot status"><thead><tr><th scope="col">Bot</th><th scope="col">Status</th><th scope="col">Activity</th><th scope="col">Location</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p>${data ? 'No bots configured.' : 'Bot status is temporarily unavailable.'}</p>`}
</main></body></html>`;
}

Bun.serve({
    hostname: '127.0.0.1',
    port: 3721,
    maxRequestBodySize: 1024,
    async fetch(request) {
        if (new URL(request.url).pathname !== '/bots') return new Response(null, { status: 404 });
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
        }
        let data: Snapshot | undefined;
        try { data = await snapshot(botsDir); } catch { /* display the unavailable page */ }
        return new Response(request.method === 'HEAD' ? null : render(data), {
            status: data ? 200 : 503,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
                'X-Content-Type-Options': 'nosniff',
                'X-Robots-Tag': 'noindex',
            },
        });
    },
});

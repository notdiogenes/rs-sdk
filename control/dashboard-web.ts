import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Snapshot } from './dashboard-supervisor';
import type { ControllerStatus } from './dashboard-activity';
import type { Plan } from './dashboard-plan-runner';
import type { BankSnapshot } from './dashboard-fleet-stats';
import { dashboardPresentation } from './dashboard-presentation';
import { loadQuestCatalog, type QuestColumn } from './dashboard-quests';
import { readTaskActivity } from './dashboard-task-activity';
import type { LastActivity } from './dashboard-last-activity';

type CallSupervisor = (request: Request) => Promise<Response>;
type LoadPresentation = ReturnType<typeof dashboardPresentation>;
type ReadPlan = (bot: string) => Plan | null;
type Item = { id: number; slot: number; name: string; count: number };

const itemSpriteBase = 'https://rs-sdk.maxbittker.com/sprite/item/';
const displayTimeZone = 'America/New_York';
const refreshSeconds = 15;
const noStore = { 'Cache-Control': 'no-store' };

function withItemSprites(inventory: { items: Item[] }) {
    return { ...inventory, items: inventory.items.map(item => ({
        ...item,
        spriteUrl: Number.isInteger(item.id) && item.id >= 0 && item.id <= 999_999
            ? `${itemSpriteBase}${item.id}.png` : null,
    })) };
}

function jsonError(error: string, status: number) {
    return Response.json({ error }, { status, headers: noStore });
}

function trainingActivity(label: string, bot: string, readPlan: ReadPlan) {
    const match = /^(Stopping )?(?:Train Hitpoints|Training Hitpoints(?: to 60)?)$/.exec(label);
    if (!match) return label;
    const plan = readPlan(bot);
    const work = plan?.status === 'running' ? plan.work : undefined;
    const finish = work?.task === 'train-hitpoints' ? work.finish : undefined;
    const goal = finish?.type === 'level' && finish.skill === 'Hitpoints' ? ` to ${finish.level}` : '';
    return `${match[1] ?? ''}Training Hitpoints${goal}`;
}

async function supervisorRequest(path: string, request?: Request) {
    const headers = new Headers();
    if (request) {
        for (const name of ['Authorization', 'Cookie', 'Content-Type', 'Origin']) {
            const value = request.headers.get(name);
            if (value !== null) headers.set(name, value);
        }
    }
    return new Request('http://fleet-supervisor' + path, {
        method: request?.method,
        headers,
        body: request?.body ? await request.arrayBuffer() : undefined,
        signal: request?.signal,
    });
}

export function dashboardWebHandler(worker: CallSupervisor, presentation: LoadPresentation,
    auditDatabase: () => Database, questCatalog: QuestColumn[], readPlan: ReadPlan = () => null) {
    const call = async (path: string, request?: Request) => worker(await supervisorRequest(path, request));

    async function audit(request: Request, params: URLSearchParams) {
        const headers: Record<string, string> = { ...noStore };
        if (request.method !== 'GET' && request.method !== 'POST') {
            return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
        }
        const format = params.get('format') ?? 'json';
        if (format !== 'json' && format !== 'html') return jsonError('Use format=json or format=html.', 400);
        if (params.has('password')) return jsonError('Send password in the JSON body of a POST request.', 400);
        if (request.method === 'POST' && request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
            return jsonError('Send password in an application/json body.', 415);
        }
        const access = await call('/internal/audit-access', request);
        const signInRedirect = format === 'html' && request.method === 'GET' && access.status === 401;
        if (!access.ok && !signInRedirect) return access;
        const cookie = access.headers.get('Set-Cookie');
        if (request.method === 'POST' && !cookie) return jsonError('Dashboard sign-in is unavailable.', 503);
        if (cookie) headers['Set-Cookie'] = cookie;
        const view = await presentation();
        if (format === 'html') {
            return new Response(null, { status: 303, headers: { ...headers, Location: view.auditDashboardLocation(params) } });
        }
        try {
            const report = view.readDashboardAudit(auditDatabase(), Date.now(), params);
            return report ? Response.json(report, { headers }) : Response.json({ error: 'Run not found.' }, { status: 404, headers });
        } catch (error) {
            const invalid = error instanceof Error && /^(Invalid \w+|Unknown audit mode)$/.test(error.message);
            return Response.json({ error: invalid ? error.message : 'Audit history is temporarily unavailable.' },
                { status: invalid ? 400 : 503, headers });
        }
    }

    return async function handle(request: Request) {
        const { pathname, search, searchParams } = new URL(request.url);
        if (pathname === '/bots/activity') {
            try {
                const view = searchParams.get('view');
                const dataView = !searchParams.has('demo') && !searchParams.get('session');
                if (dataView && view === 'audit') return await audit(request, searchParams);

                const response = await call('/bots/activity' + search, request);
                if (!dataView || !response.ok) return response;
                const bot = searchParams.get('bot');
                if (view === 'diagnostics' && bot && request.method === 'GET') {
                    const report = await response.json() as { reading?: { bot: string; controller?: Pick<ControllerStatus, 'task'> } };
                    const task = report.reading?.controller?.task;
                    if (task?.name === 'train-hitpoints' && task.activity) {
                        task.activity = trainingActivity(task.activity, report.reading?.bot ?? bot, readPlan);
                    }
                    const headers = new Headers(response.headers);
                    headers.delete('Content-Length');
                    return Response.json(report, { status: response.status, headers });
                }
                if (view === 'bank') {
                    const report = await response.json() as { bot: string; bank: BankSnapshot | null };
                    const bank = report.bank;
                    const headers = new Headers(response.headers);
                    headers.delete('Content-Length');
                    return Response.json({
                        ...report, bank: bank?.items ? { ...bank, ...withItemSprites({ items: bank.items }) } : bank,
                    }, { status: response.status, headers });
                }
                if (view !== 'inventory') return response;
                type Inventory = { items: Item[] };
                const data = await response.json() as Inventory | { message: string; inventory: Inventory };
                const { status } = response;
                const headers = new Headers(response.headers);
                headers.delete('Content-Length');
                const result = 'inventory' in data ? { ...data, inventory: withItemSprites(data.inventory) } : withItemSprites(data);
                return Response.json(result, { status, headers });
            } catch {
                return jsonError('Dashboard data is temporarily unavailable.', 503);
            }
        }
        if (pathname !== '/bots') return new Response(null, { status: 404 });
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
        }
        let data: Snapshot | undefined;
        const taskActivity = new Map<string, LastActivity>();
        try {
            const response = await call('/internal/fleet-snapshot');
            if (response.ok) {
                data = await response.json() as Snapshot;
                for (const bot of data.bots) {
                    const label = trainingActivity(bot.activity, bot.name, readPlan);
                    if (bot.control?.label === bot.activity) bot.control.label = label;
                    bot.activity = label;
                }
            }
        } catch { /* Render the unavailable page until the supervisor is reachable. */ }
        const nonce = crypto.randomUUID();
        const { fleetPage, fleetStyle, controls, revision } = await presentation();
        if (request.method === 'GET') {
            for (const bot of data?.bots ?? []) {
                const control = bot.control;
                if (bot.status !== 'Online' || !control?.running || control.transitioning || control.waiting || !control.startedAt) continue;
                const startedAt = Date.parse(control.startedAt);
                if (!Number.isFinite(startedAt)) continue;
                try {
                    const latest = readTaskActivity(auditDatabase(), bot.name, startedAt);
                    if (latest) taskActivity.set(bot.name, latest);
                } catch { /* Observed game activity is available without the task trace. */ }
            }
        }
        return new Response(request.method === 'HEAD' ? null : fleetPage({
            nonce, revision, data, taskActivity, questCatalog, fleetStyle, controls, refreshSeconds, displayTimeZone,
        }), {
            status: data ? 200 : 503,
            headers: {
                ...noStore,
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src ${itemSpriteBase}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
                'X-Content-Type-Options': 'nosniff',
                'X-Robots-Tag': 'noindex',
            },
        });
    };
}

export async function startDashboardWeb(runtimeDir: string, worker: CallSupervisor) {
    const presentation = dashboardPresentation(import.meta.dir, runtimeDir);
    const questCatalog = await loadQuestCatalog();
    await presentation();
    let db: Database | undefined;
    let planDb: Database | undefined;
    const readPlan: ReadPlan = bot => {
        try {
            planDb ??= new Database(join(runtimeDir, 'activity-plans.sqlite'), { readonly: true });
            const row = planDb.query<{ data: string }, [string]>('SELECT data FROM activity_plan WHERE bot = ?').get(bot);
            return row ? JSON.parse(row.data) as Plan : null;
        } catch {
            return null;
        }
    };
    const handle = dashboardWebHandler(worker, presentation, () =>
        db ??= new Database(join(runtimeDir, 'activity-audit.sqlite'), { readonly: true }), questCatalog, readPlan);
    return Bun.serve({ hostname: '127.0.0.1', port: 3721, maxRequestBodySize: 16_384, fetch: handle });
}

if (import.meta.main) {
    const [runtimeDir, socket] = process.argv.slice(2);
    if (!runtimeDir || !socket) throw new Error('Expected the dashboard runtime directory and private supervisor socket');
    await startDashboardWeb(runtimeDir, request => fetch(request, { unix: socket, redirect: 'manual' }));
}

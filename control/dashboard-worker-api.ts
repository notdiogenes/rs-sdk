import { checkStepCompatibility, parseSteps, type Step } from './dashboard-plan';
import { handleActivityUpdates, type ActivityUpdateSource, type StandaloneUpdates } from './dashboard-activity-updates';
import { planCatalog, trainingSkills } from './dashboard-task-catalog';
import type { dashboardDemo } from './dashboard-demo';
import type { dashboardDiagnostics } from './dashboard-diagnostics';
import type { dashboardFleetStats } from './dashboard-fleet-stats';
import type { createDashboardMonitor } from './dashboard-monitor';
import type { createPlanManager } from './dashboard-plan-runner';
import type { dashboardQuestPoints } from './dashboard-quests';
import type { dashboardRoster } from './dashboard-roster';
import type { dashboardSessions } from './dashboard-session';
import type { ManagedProfile, Snapshot } from './dashboard-supervisor';
import type { InventoryCommand, parseInventoryCommand } from '../sdk/inventory-command';

type BotWorker = ReturnType<typeof dashboardDemo>;

export type DashboardWorkerApiRuntime = {
    botProfile(name: string): Promise<ManagedProfile | null>;
    botRoster: Pick<ReturnType<typeof dashboardRoster>, 'create'>;
    plans: Pick<ReturnType<typeof createPlanManager>, 'get' | 'list' | 'pause' | 'resume' | 'start' | 'update' | 'queueMining' |
        'activeUpdate' | 'requestUpdate' | 'cancelUpdate'> & { supportsCompletedRemoval?: true };
    updateSource?: ActivityUpdateSource;
    standaloneUpdates?: StandaloneUpdates;
    invalidateSnapshot(): void;
    isPlanEditConflict(error: unknown): boolean;
    demo: Pick<BotWorker, 'allowed' | 'cancelStart' | 'handle' | 'profile'>;
    sessions: ReturnType<typeof dashboardSessions>;
    snapshot(after?: number, fresh?: boolean): Promise<Snapshot>;
    monitor: Pick<ReturnType<typeof createDashboardMonitor>, 'read'>;
    managedWorkers(): Pick<BotWorker, 'monitorTimeline'>[];
    inventory(profile: ManagedProfile): Promise<object>;
    inventoryController(profile: ManagedProfile): Promise<((command: InventoryCommand) => Promise<Response>) | undefined>;
    parseInventoryCommand: typeof parseInventoryCommand;
    recordStats: ReturnType<typeof dashboardFleetStats>;
    botDiagnostics(name: string): Promise<unknown>;
    diagnostics: Pick<ReturnType<typeof dashboardDiagnostics>, 'read'>;
    dashboardQuestPoints: typeof dashboardQuestPoints;
    handlePrimaryActivity(request: Request, session?: string): Promise<Response>;
    handleBotActivity(request: Request, name: string, session?: string): Promise<Response>;
};

async function handlePlan(request: Request, name: string | null, session: string | undefined,
    { demo, botProfile, botRoster, plans, invalidateSnapshot, isPlanEditConflict, updateSource }: DashboardWorkerApiRuntime) {
    const headers = { 'Cache-Control': 'no-store', ...(session ? { 'Set-Cookie': session } : {}) };
    const reply = (body: object, status = 200) => Response.json(body, { status, headers });
    const canRemoveCompleted = plans.supportsCompletedRemoval === true;
    if (!session && !await demo.allowed(request)) return reply({ error: 'Sign in to manage activity plans.' }, 401);
    if (request.method === 'GET') {
        const profile = name === null ? null : await botProfile(name);
        if (name !== null && !profile) return reply({ error: 'Bot profile not found.' }, 404);
        return reply({ catalog: planCatalog, skills: trainingSkills, plan: profile && plans.get(profile.name), canRemoveCompleted });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return reply({ error: 'Invalid activity plan.' }, 400);
    if (name === null) {
        if (body.action !== 'create') return reply({ error: 'Choose a bot to manage.' }, 400);
        try {
            const steps = parseSteps(body.steps);
            const profile = await botRoster.create(body.name, (await demo.profile())?.name);
            const plan = plans.start(profile.name, steps);
            invalidateSnapshot();
            return reply({ bot: profile.name, plan, canRemoveCompleted }, 202);
        } catch (error) {
            return reply({ error: error instanceof Error ? error.message : 'Could not create the bot.' }, 400);
        }
    }
    const profile = await botProfile(name);
    if (!profile) return reply({ error: 'Bot profile not found.' }, 404);
    try {
        let plan;
        if (body.action === 'pause') plan = await plans.pause(profile.name);
        else if (body.action === 'resume') plan = plans.resume(profile.name);
        else if (body.action === 'start') plan = plans.start(profile.name, parseSteps(body.steps));
        else if (body.action === 'update') {
            if (typeof body.expectedRevision !== 'string' || !body.expectedRevision) {
                return reply({ error: 'Reload the current plan before saving changes.' }, 400);
            }
            const saved = plans.get(profile.name);
            if (!saved || saved.revision !== body.expectedRevision) {
                return reply({ error: 'The saved plan changed. Reload it before saving your edits.' }, 409);
            }
            if (body.reviewedStep !== undefined) {
                if (body.removedCompletedIndexes !== undefined) {
                    return reply({ error: 'Save the reviewed settings before removing completed activities.' }, 400);
                }
                const index = body.reviewedStep;
                if (!Number.isSafeInteger(index) || index < saved.index || index >= saved.steps.length) {
                    return reply({ error: 'Choose an unfinished step to review.' }, 400);
                }
                const release = await updateSource?.load();
                if (body.reviewedRevision && release?.revision !== body.reviewedRevision) {
                    return reply({ error: 'The release changed. Reopen activity updates before reviewing this step.' }, 409);
                }
                const reviewed = parseSteps([body.steps?.[index]])[0]!;
                const steps = saved.steps.map((step, i) => i === index ? reviewed : step);
                checkPlanOrder(steps);
                const active = plans.activeUpdate(profile.name).running;
                if (active && index === saved.index && saved.status === 'running') {
                    if (!release) return reply({ error: 'Activity updates are unavailable on this worker.' }, 503);
                    plans.requestUpdate(profile.name, index, saved.revision, active.runId, release, 'safe', reviewed);
                    return reply({ bot: profile.name, plan: saved, canRemoveCompleted, awaitingCheckpoint: true }, 202);
                }
                plan = plans.update(profile.name, steps, saved.revision);
            } else {
                const removed = body.removedCompletedIndexes === undefined ? [] : body.removedCompletedIndexes;
                if (!Array.isArray(removed) || removed.length > saved.index) {
                    return reply({ error: 'Choose completed activities to remove from this plan.' }, 400);
                }
                if (removed.length && !canRemoveCompleted) {
                    return reply({ error: 'Restart the Fleet Desk worker to enable completed activity removal.' }, 503);
                }
                const indexes = new Set(removed);
                const retained = saved.steps.filter((_, index) => !indexes.has(index));
                const allowEmpty = saved.status === 'complete' && removed.length > 0;
                plan = plans.update(profile.name, editSteps(body.steps, retained, allowEmpty), saved.revision, removed);
            }
        } else if (body.action === 'queue-mining') plan = plans.queueMining(profile.name, parseSteps([body.step])[0]!);
        else return reply({ error: 'Choose start, update, pause, resume, or queue mining.' }, 400);
        invalidateSnapshot();
        return reply({ bot: profile.name, plan, canRemoveCompleted }, body.action === 'pause' || body.action === 'update' ? 200 : 202);
    } catch (error) {
        return reply({ error: error instanceof Error ? error.message : 'Could not update the plan.' },
            isPlanEditConflict(error) ? 409 : 400);
    }
}

function checkPlanOrder(steps: Step[]) {
    if (steps.some((step, index) => step.finish.type === 'forever' && index !== steps.length - 1)) {
        throw new Error('An indefinite grind must be the final activity.');
    }
}

function editSteps(value: unknown, saved: Step[], allowEmpty = false) {
    if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 12) throw new Error('Add between 1 and 12 activities.');
    const existing = new Map(saved.map(step => [JSON.stringify(step), step]));
    const result = value.map((entry, index) => {
        const unchanged = existing.get(JSON.stringify(entry));
        if (unchanged) return unchanged;
        const before = saved[index];
        if (before && entry?.task === before.task && checkStepCompatibility(before).status === 'review') {
            throw new Error('Open Activity updates to review the changed settings for this step.');
        }
        return parseSteps([entry])[0]!;
    });
    checkPlanOrder(result);
    return result;
}

export async function handleWorkerRequest(request: Request, runtime: DashboardWorkerApiRuntime) {
    const { botProfile, demo, sessions, snapshot, monitor, managedWorkers, inventory, inventoryController,
        botDiagnostics, diagnostics, dashboardQuestPoints, recordStats, parseInventoryCommand,
        handlePrimaryActivity, handleBotActivity } = runtime;
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === '/internal/fleet-snapshot' && request.method === 'GET') {
        const requestedAfter = searchParams.get('after');
        const after = requestedAfter && /^\d{13}$/.test(requestedAfter) ? Number(requestedAfter) : undefined;
        return Response.json(await snapshot(after, searchParams.get('fresh') === '1'));
    }
    if (pathname === '/internal/audit-access') {
        if (request.method === 'POST') return sessions.handle(request, 'login', { programmatic: true });
        if (request.method !== 'GET') return new Response(null, { status: 405 });
        const session = await sessions.authenticate(request).catch(() => undefined);
        if (!session && !await demo.allowed(request)) {
            return Response.json({ error: 'Sign in to view audit history.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
        }
        return new Response(null, { status: 204, headers: session ? { 'Set-Cookie': session } : undefined });
    }
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
        if (view === 'updates') {
            if (!session && !await demo.allowed(request)) {
                return Response.json({ error: 'Sign in to manage activity updates.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
            }
            return handleActivityUpdates(request, runtime.plans, runtime.updateSource, session, runtime.standaloneUpdates);
        }
        if (view === 'monitor') {
            const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
            if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
            if (!session && !await demo.allowed(request)) {
                return Response.json({ error: 'Sign in to view the resource monitor.' }, { status: 401, headers });
            }
            if (session) headers['Set-Cookie'] = session;
            const requestedWindow = searchParams.get('window') ?? '30';
            if (!['30', '300', '3600'].includes(requestedWindow)) {
                return Response.json({ error: 'Use a window of 30, 300, or 3600 seconds.' }, { status: 400, headers });
            }
            const seconds = Number(requestedWindow);
            const reading = monitor.read(seconds);
            const end = reading.sampledAt ?? Date.now();
            const events = managedWorkers().flatMap(worker => worker.monitorTimeline(end - seconds * 1000))
                .filter(event => event.at <= end)
                .sort((a, b) => a.at - b.at);
            return Response.json({ ...reading, events }, { headers });
        }
        if (view === 'plan') {
            try { return await handlePlan(request, bot, session, runtime); }
            catch { return Response.json({ error: 'Activity plans are temporarily unavailable.' }, { status: 503 }); }
        }
        if (view === 'inventory') {
            const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
            const reply = (data: object, status = 200) => Response.json(data, { status, headers });
            if (request.method !== 'GET' && request.method !== 'POST') {
                return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
            }
            if (!session) return reply({ error: 'Sign in to use the backpack.' }, 401);
            headers['Set-Cookie'] = session;
            try {
                const profile = bot && await botProfile(bot);
                if (!profile) return reply({ error: 'Bot profile not found.' }, 404);
                if (request.method === 'GET') return reply(await inventory(profile));
                if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
                    return reply({ error: 'Send an inventory action as JSON.' }, 415);
                }
                const command = parseInventoryCommand(await request.json().catch(() => null));
                if (!command) return reply({ error: 'Invalid inventory action.' }, 400);
                const control = await inventoryController(profile);
                if (!control) return reply({ error: 'Inventory controls are unavailable for this game client.' }, 409);
                const response = await control(command);
                response.headers.set('Set-Cookie', session);
                return response;
            } catch {
                return reply({ error: request.method === 'POST'
                    ? 'The inventory action could not be confirmed. Check the inventory before retrying.'
                    : 'Current inventory is temporarily unavailable.' }, 503);
            }
        }
        if (view === 'bank' || view === 'banks') {
            const headers = { 'Cache-Control': 'no-store' };
            if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
            if (!session) return Response.json({ error: 'Sign in to view bank snapshots.' }, { status: 401, headers });
            const authenticated = { ...headers, 'Set-Cookie': session };
            try {
                if (view === 'banks') return Response.json(recordStats.bankOverview(), { headers: authenticated });
                const profile = bot && await botProfile(bot);
                if (!profile) return Response.json({ error: 'Bot profile not found.' }, { status: 404, headers: authenticated });
                const { bank } = recordStats(profile.name);
                return Response.json({ bot: profile.name, bank }, { headers: authenticated });
            } catch {
                return Response.json({ error: 'Bank snapshots are temporarily unavailable.' }, { status: 503, headers: authenticated });
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
                const current = await snapshot();
                const payload = view === 'diagnostics' ? diagnostics.read() : view === 'quests'
                    ? {
                        scores: await dashboardQuestPoints(current.bots.map(({ name, stats }) => ({ name, score: stats?.journal?.score }))),
                        journals: Object.fromEntries(current.bots.map(({ name, stats }) => [name, stats?.journal ?? null])),
                    }
                    : current.bots.map(({ name, stats }) => {
                        const bank = stats?.bank;
                        return {
                            name, skills: stats?.skills, xpGained: stats?.xpGained,
                            bank: bank && { at: bank.at, stacks: bank.stacks, coins: bank.coins },
                        };
                    });
                return Response.json(payload, { headers: { ...headers, 'Set-Cookie': session } });
            } catch {
                return Response.json({ error: 'Dashboard data is temporarily unavailable.' }, { status: 503, headers });
            }
        }
        const response = bot === null ? await handlePrimaryActivity(request, session)
            : await handleBotActivity(request, bot, session);
        if (session) response.headers.set('Set-Cookie', session);
        return response;
    }
    return new Response(null, { status: 404 });
}

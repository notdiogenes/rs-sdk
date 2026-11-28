import { dirname, join } from 'node:path';
import { hostedBotName, hostedBotState, isFreshBotState } from './hosted-bot';
import { controllerRequest, dashboardActivity, handleActivity, type ControllerStatus } from './dashboard-activity';
import { dashboardSessions } from './dashboard-session';
import { dashboardDiagnostics } from './dashboard-diagnostics';
import { createDashboardMonitor } from './dashboard-monitor';
import { dashboardStateReader, fleetAvailability, type FleetStateReading } from './dashboard-live-state';
import { inventoryActionResponse, inventoryItems } from './dashboard-inventory';
import { parseInventoryCommand, type InventoryCommand } from '../sdk/inventory-command';
import { dashboardLastActivity } from './dashboard-last-activity';
import type { BotObservation, LastActivity } from './dashboard-last-activity';
import type { FleetStateFrame } from '../sdk/fleet-telemetry';
import { dashboardFleetStats } from './dashboard-fleet-stats';
import { dashboardQuestPoints } from './dashboard-quests';
import { dashboardAudit } from './dashboard-audit';
import { dashboardDemo, isBundledTask, type DashboardPathfinding } from './dashboard-demo';
import { activity, planCatalog, trainingSkills } from './dashboard-task-catalog';
import { parseSteps } from './dashboard-plan';
import { createPlanManager, PlanEditConflict, type Plan } from './dashboard-plan-runner';
import { dashboardRoster, type BotProfile } from './dashboard-roster';

export type Bot = {
    name: string;
    status: 'Online' | 'Offline' | 'Unknown';
    activity: string;
    location?: string;
    lastActivity: LastActivity | null;
    stats?: ReturnType<ReturnType<typeof dashboardFleetStats>>;
    heartbeat?: number;
    inCombat?: boolean;
    control?: ControlActivity;
    plan?: Pick<Plan, 'index' | 'status' | 'message'> & { length: number; label?: string };
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
type ManagedProfile = BotProfile & { worker?: ReturnType<typeof dashboardDemo> };
type PrimaryFleet = { status: ControllerStatus; frame?: FleetStateFrame };

export async function createDashboardSupervisor(botsDir: string, configDir: string, pathfinding?: DashboardPathfinding) {
    const token = (await Bun.file(join(configDir, 'token')).text()).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid control API token');
    const runtimeDir = join(dirname(configDir), 'rs-sdk-public-status');
    const diagnostics = dashboardDiagnostics(runtimeDir);
    const audit = dashboardAudit(runtimeDir);
    const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: import.meta.dir, stderr: 'ignore' });
    const revision = git.success ? git.stdout.toString().trim() : undefined;
    const recordStats = dashboardFleetStats(runtimeDir);
    const demo = dashboardDemo(runtimeDir, botsDir, configDir, token, recordStats.recordBank, undefined, audit, revision, pathfinding);
    const rosterControllers = new Map<string, ReturnType<typeof dashboardDemo>>();
    const managedWorkers = () => [demo, ...rosterControllers.values()];
    const monitor = createDashboardMonitor(() => {
        const processes = managedWorkers().flatMap(worker => worker.monitoredProcesses());
        const shared = pathfinding?.monitoredProcess?.();
        if (shared) processes.push(shared);
        return processes;
    });
    const botRoster = dashboardRoster(botsDir, runtimeDir);
    const plans = createPlanManager(runtimeDir, planBackend);
    const recordActivity = dashboardLastActivity(runtimeDir);
    const readState = dashboardStateReader();
    const sessions = dashboardSessions(runtimeDir, async () => {
        const site = await Bun.file('/etc/nginx/sites-enabled/rs-sdk-control-hostname').text();
        const host = /^\s*server_name\s+([0-9]+-[0-9]+-[0-9]+-[0-9]+\.sslip\.io);/m.exec(site)?.[1];
        if (!host) throw new Error('The managed HTTPS hostname is unavailable.');
        return `https://${host}`;
    }, join(import.meta.dir, 'dashboard-enrollment.json'));

    const refreshSeconds = 15;
    let cached: Snapshot | undefined;
    let expiresAt = 0;
    let refreshing: Promise<Snapshot> | undefined;
    let sampleTimer: ReturnType<typeof setTimeout>;
    let readingPrimary: Promise<PrimaryFleet | null> | undefined;

    async function primaryStatus(): Promise<ControllerStatus> {
        const response = await controllerRequest('/v1/status', `Bearer ${token}`, undefined, AbortSignal.timeout(3000));
        if (!response.ok) throw new Error('The primary controller is unavailable');
        return response.json() as Promise<ControllerStatus>;
    }

    function primaryFleet() {
        return readingPrimary ??= (async () => {
            const response = await controllerRequest('/v1/status?fleet=1', `Bearer ${token}`, undefined, AbortSignal.timeout(3000));
            if (!response.ok) return null;
            const { fleetState, ...status } = await response.json() as ControllerStatus & { fleetState?: FleetStateFrame };
            return { status, frame: fleetState };
        })().catch(() => null).finally(() => { readingPrimary = undefined; });
    }

    function readBotState(profile: ManagedProfile, primary: PrimaryFleet | null, local = profile.worker?.fleetState()) {
        const frame = local ?? (primary?.status.bot === profile.name ? primary.frame : undefined);
        return readState(profile.name, profile.directory, frame);
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
        const profile = (await botRoster.list()).find(entry => entry.name.toLowerCase() === name.toLowerCase());
        return profile ? { ...profile, worker: rosterControllers.get(profile.name.toLowerCase()) } : null;
    }

    function getWorker(profile: BotProfile) {
        const key = profile.name.toLowerCase();
        let worker = rosterControllers.get(key);
        if (!worker) {
            worker = dashboardDemo(runtimeDir, botsDir, configDir, token, recordStats.recordBank, profile, audit, revision, pathfinding);
            rosterControllers.set(key, worker);
        }
        return worker;
    }

    async function planBackend(name: string, signal: AbortSignal) {
        const profile = await botProfile(name);
        if (!profile) throw new Error('Bot profile not found.');
        const primary = await primaryStatus().catch(() => null);
        signal.throwIfAborted();
        if (primary?.bot?.toLowerCase() === profile.name.toLowerCase()) {
            const primaryActivity = dashboardActivity(primary);
            if (primaryActivity.task || primaryActivity.starting || primary.client?.stopping) {
                throw new Error('Stop the current activity before running a plan.');
            }
            if (primary.client) {
                const response = await controllerRequest('/v1/client/stop', `Bearer ${token}`, {});
                if (!response.ok) throw new Error('Could not release the idle primary client.');
                const deadline = Date.now() + 25_000;
                while (Date.now() < deadline) {
                    signal.throwIfAborted();
                    const sample = await hostedBotState(profile.name, profile.directory);
                    if (!sample?.state?.inGame || sample.botStatus === 'dead' || sample.botStatus === 'stale' || !isFreshBotState(sample.stateAge)) break;
                    await Bun.sleep(1000);
                }
            }
        }
        signal.throwIfAborted();
        const worker = profile.worker ?? getWorker(profile);
        if (workerStatus(profile.name, worker)?.starting) throw new Error('Wait for the existing activity to finish starting.');
        return worker.planBackend(profile.name);
    }

    async function handlePlan(request: Request, name: string | null, session?: string) {
        const headers = { 'Cache-Control': 'no-store', ...(session ? { 'Set-Cookie': session } : {}) };
        const reply = (body: object, status = 200) => Response.json(body, { status, headers });
        if (!session && !await demo.allowed(request)) return reply({ error: 'Sign in to manage activity plans.' }, 401);
        if (request.method === 'GET') {
            const profile = name === null ? null : await botProfile(name);
            if (name !== null && !profile) return reply({ error: 'Bot profile not found.' }, 404);
            return reply({ catalog: planCatalog, skills: trainingSkills, plan: profile && plans.get(profile.name) });
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
                expiresAt = 0;
                return reply({ bot: profile.name, plan }, 202);
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
                plan = plans.update(profile.name, parseSteps(body.steps), body.expectedRevision);
            } else if (body.action === 'queue-mining') plan = plans.queueMining(profile.name, parseSteps([body.step])[0]!);
            else return reply({ error: 'Choose start, update, pause, resume, or queue mining.' }, 400);
            expiresAt = 0;
            return reply({ bot: profile.name, plan }, body.action === 'pause' || body.action === 'update' ? 200 : 202);
        } catch (error) {
            return reply({ error: error instanceof Error ? error.message : 'Could not update the plan.' },
                error instanceof PlanEditConflict ? 409 : 400);
        }
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
            if (body?.action && plans.active(profile.name)) {
                if (body.action === 'stop') {
                    await plans.pause(profile.name);
                    expiresAt = 0;
                    return reply({ ok: true }, 200);
                }
                return reply({ error: 'Pause the running plan before starting another activity.' }, 409);
            }
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
            const worker = profile.worker ?? getWorker(profile);
            return worker.handleActivity(request, token, session, profile.name);
        } catch {
            return reply({ error: 'The bot controller is temporarily unavailable.' }, 503);
        }
    }

    async function inventoryController(profile: ManagedProfile, status?: ControllerStatus | null) {
        const local = profile.worker?.inventoryClient();
        if (local) return async (command: InventoryCommand) =>
            inventoryActionResponse(await local.inventory.send(local.process, command));
        const primary = status === undefined ? await primaryStatus().catch(() => null) : status;
        if (primary?.bot !== profile.name || !primary.client?.inventoryActions || primary.client.stopping) return undefined;
        return (command: InventoryCommand) =>
            controllerRequest('/v1/inventory/action', `Bearer ${token}`, { bot: profile.name, ...command });
    }

    async function inventory(profile: ManagedProfile) {
        const local = profile.worker?.fleetState();
        const primary = local ? undefined : await primaryFleet();
        const result = await readBotState(profile, primary ?? null, local);
        const empty = { bot: profile.name, items: [] };
        const availability = fleetAvailability(result);
        if (availability !== 'live' || !result?.state) return { ...empty, availability };
        return {
            bot: profile.name, availability, capturedAt: Date.now() - result.stateAge,
            controls: Boolean(await inventoryController(profile, primary === undefined ? undefined : primary?.status ?? null)),
            items: inventoryItems(result.state.inventory),
        };
    }

    async function botDiagnostics(name: string) {
        const profile = await botProfile(name);
        if (!profile) return null;
        const sampled = await primaryFleet();
        const primary = sampled?.status;
        const result = await readBotState(profile, sampled).catch(() => undefined);
        const worker = profile.worker;
        const isPrimary = primary && usesPrimary(profile.name, primary, worker);
        const controller = isPrimary ? dashboardActivity(primary)
            : workerStatus(profile.name, worker) ??
                { bot: profile.name, tasks: [], client: null, task: null, startError: null, starting: null };
        const historical = isPrimary ? diagnostics.read() : null;
        const primaryHistory = historical?.reading?.controller?.bot === primary?.bot ? historical : null;
        const { movedAt, gainedXpAt } = recordActivity(profile.name);
        const state = result?.state;
        const player = state?.player;
        const availability = fleetAvailability(result);
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

    function botStatus(name: string, result: FleetStateReading | null | undefined, control?: ControlActivity): Bot {
        const plan = plans.get(name);
        const work = plan?.work ?? plan?.steps[plan.index];
        const planLabel = work && activity(work.task).label;
        const summary = plan ? { index: plan.index, length: plan.steps.length, status: plan.status, message: plan.message, label: planLabel } : undefined;
        if (plan?.status === 'running' && !control?.running) {
            control = { bot: name, label: planLabel ?? 'Starting plan', running: true, transitioning: true };
        } else if (plan?.status === 'blocked' && !control?.running) {
            control = { bot: name, label: 'Plan blocked', running: false, failed: true };
        }
        const task = control?.label;
        const row = (fields: Omit<Bot, 'name' | 'lastActivity' | 'stats'>, observation?: BotObservation,
            state?: NonNullable<FleetStateReading['state']>): Bot => {
            let lastActivity = null;
            let stats;
            try { lastActivity = recordActivity(name, observation).lastActivity; } catch { /* Show the other status fields. */ }
            try { stats = recordStats(name, state, fields.heartbeat); } catch { /* Show the other status fields. */ }
            return { name, ...fields, lastActivity, stats, control, plan: summary };
        };
        const availability = fleetAvailability(result);
        if (availability === 'offline') return row({ status: 'Offline', activity: task ?? '—' });
        if (availability === 'live' && result?.state?.player) {
            const player = result.state.player;
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
        return row({ status: 'Unknown', activity: task ?? '—' });
    }

    async function collect(): Promise<Snapshot> {
        const [profiles, sampled, demoProfile] = await Promise.all([
            botRoster.list(), primaryFleet(), demo.profile().catch(() => null),
        ]);
        const primary = sampled?.status;
        const roster = new Map<string, BotProfile>(profiles.map(profile => [profile.name.toLowerCase(), profile]));
        if (demoProfile) roster.set(demoProfile.name.toLowerCase(), demoProfile);
        const sorted = [...roster.values()].sort((a, b) => a.name.localeCompare(b.name));
        const readings = await Promise.all(sorted.map(async profile => {
            const worker = demoProfile?.name === profile.name ? demo : rosterControllers.get(profile.name.toLowerCase());
            const controller = primary && usesPrimary(profile.name, primary, worker) ? dashboardActivity(primary)
                : workerStatus(profile.name, worker);
            const result = await readBotState({ ...profile, worker }, sampled).catch(() => undefined);
            return { bot: botStatus(profile.name, result, controller && controlActivity(controller)), result };
        }));
        const primaryReading = readings.find(({ bot }) => bot.name === primary?.bot);
        try { diagnostics.observe(primary ?? null, primaryReading?.result); }
        catch { console.error('Could not save dashboard diagnostics'); }
        return { bots: readings.map(({ bot }) => bot), checkedAt: new Date().toISOString() };
    }

    async function snapshot(after?: number) {
        const now = Date.now();
        // The dashboard clock shows whole seconds. A refresh must advance the displayed second.
        const minimum = after === undefined ? 0 : Math.floor(Math.min(now, after) / 1000) * 1000 + 1000;
        if (minimum > now) await Bun.sleep(minimum - now);
        if (cached && Date.now() < expiresAt && Date.parse(cached.checkedAt) >= minimum) return cached;
        return refreshSnapshot();
    }

    function refreshSnapshot() {
        return refreshing ??= collect().then(result => {
            cached = result;
            expiresAt = Date.now() + refreshSeconds * 1000;
            return result;
        }).finally(() => {
            refreshing = undefined;
            clearTimeout(sampleTimer);
            sampleTimer = setTimeout(collectInBackground, refreshSeconds * 1000);
            sampleTimer.unref();
        });
    }

    const collectInBackground = () => void refreshSnapshot().catch(() => console.error('Dashboard bot sample failed'));
    collectInBackground();
    monitor.start();
    plans.restore();
    setInterval(() => {
        try { audit.prune(); } catch { console.error('Activity audit retention check failed'); }
    }, 15 * 60_000).unref();

    async function handle(request: Request) {
        const { pathname, searchParams } = new URL(request.url);
        if (pathname === '/internal/fleet-snapshot' && request.method === 'GET') {
            const requestedAfter = searchParams.get('after');
            const after = requestedAfter && /^\d{13}$/.test(requestedAfter) ? Number(requestedAfter) : undefined;
            const previous = searchParams.get('fresh') === '1' ? cached : undefined;
            return Response.json(await snapshot(previous ? Date.parse(previous.checkedAt) : after));
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
                try { return await handlePlan(request, bot, session); }
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
            const response = bot === null ? await handleActivity(request, token, session)
                : await handleBotActivity(request, bot, session);
            if (session) response.headers.set('Set-Cookie', session);
            return response;
        }
        return new Response(null, { status: 404 });
    }

    return { runtimeDir, handle };
}

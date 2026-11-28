import { activityAffected } from './dashboard-activity-compatibility';
import type { Step } from './dashboard-plan';
import type { createPlanManager } from './dashboard-plan-runner';
import type { DashboardWorkerUpdates, WorkerRelease } from './dashboard-worker-policy';
import type { dashboardDemo } from './dashboard-demo';
import type { ActiveTaskUpdate } from './dashboard-task-update';

type Plans = Pick<ReturnType<typeof createPlanManager>, 'list' | 'activeUpdate' | 'requestUpdate' | 'cancelUpdate'>;
export type ActivityUpdateSource = Pick<DashboardWorkerUpdates, 'load' | 'changedPaths'>;
type StandaloneActivity = NonNullable<ReturnType<ReturnType<typeof dashboardDemo>['standaloneActivity']>>;
export type StandaloneUpdates = {
    list(): StandaloneActivity[];
    request(runId: string, release: WorkerRelease, mode: 'safe' | 'now'): Promise<void>;
    cancel(runId: string): void;
};
type Row = {
    bot: string;
    task: Step['task'];
    label: string;
    index: number;
    state: 'running' | 'queued';
    status: 'current' | 'available' | 'review';
    reason?: string;
    fromRevision?: string;
    planRevision: string;
    runId?: string;
    settings?: Omit<Step, 'task'>;
    checkpoint?: 'supported' | 'waiting' | 'unsupported';
    standalone?: true;
};

async function describeRow(row: Row, step: Step, running: ActiveTaskUpdate | undefined, waiting: boolean,
    message: string | undefined, source: ActivityUpdateSource, release: WorkerRelease) {
    const policy = release.value;
    if (running) {
        row.runId = running.runId;
        row.fromRevision = running.revision;
        row.checkpoint = waiting ? 'waiting' : running.supported ? 'supported' : 'unsupported';
    }
    const compatibility = policy.checkStepCompatibility(step);
    if (compatibility.status === 'review') {
        row.status = 'review';
        row.reason = compatibility.reason;
    } else if (running && !policy.isActivity(row.task)) {
        row.status = 'review';
        row.reason = 'The running activity is no longer in the catalog. Review this step before updating.';
    } else if (running && running.revision !== release.revision) {
        try {
            if (!running.revision || !release.revision || !source.changedPaths) throw new Error('Unknown revision');
            if (compatibility.migrated || (running.script && running.script !== policy.activity(row.task).script) ||
                activityAffected(row.task, await source.changedPaths(running.revision, release.revision))) {
                row.status = 'available';
                row.reason = message ?? (running.supported ? undefined : 'This script has no safe update checkpoint.');
            }
        } catch {
            row.status = 'review';
            row.reason = 'The running release could not be compared with the latest release.';
        }
    } else if (!running && compatibility.migrated) {
        row.status = 'available';
        row.reason = 'Saved settings will be converted when this step starts.';
    }
    return row;
}

async function describe(plans: Plans, source: ActivityUpdateSource, release: WorkerRelease, standalone?: StandaloneUpdates): Promise<Row[]> {
    const policy = release.value;
    const planRows = await Promise.all(plans.list().map(async plan => {
        const activity = plans.activeUpdate(plan.bot);
        const rows: Row[] = [];
        for (let index = plan.index; index < plan.steps.length; index++) {
            const step = plan.steps[index]!;
            const running = index === plan.index && plan.status === 'running' ? activity.running : undefined;
            const task = running && plan.work ? plan.work.task : step.task;
            const { task: _task, ...settings } = step;
            const row: Row = {
                bot: plan.bot, task, label: policy.activity(task)?.label ?? task, index,
                state: running ? 'running' : 'queued', status: 'current', planRevision: plan.revision, settings,
            };
            rows.push(await describeRow(row, step, running, activity.waiting, activity.message, source, release));
        }
        return rows;
    }));
    const standaloneRows = await Promise.all((standalone?.list() ?? []).map(({ bot, step, running, waiting }) => {
        const { task, ...settings } = step;
        return describeRow({ bot, task, label: policy.activity(task)?.label ?? task, index: 0, state: 'running', status: 'current',
            planRevision: '', settings, standalone: true }, step, running, waiting, undefined, source, release);
    }));
    return [...planRows.flat(), ...standaloneRows];
}

export async function handleActivityUpdates(request: Request, plans: Plans, source: ActivityUpdateSource | undefined, session?: string,
    standalone?: StandaloneUpdates) {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (session) headers['Set-Cookie'] = session;
    const reply = (data: object, status = 200) => Response.json(data, { status, headers });
    if (!source) return reply({ error: 'Activity updates are unavailable on this worker.' }, 503);
    if (request.method !== 'GET' && request.method !== 'POST') {
        return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
    }
    const release = await source.load();
    if (!release.revision) return reply({ error: 'The worker has no committed task release.' }, 503);
    const rows = await describe(plans, source, release, standalone);
    if (request.method === 'GET') return reply({ revision: release.revision, rows });
    const body = await request.json().catch(() => null);
    if (!body || !['compatible', 'request', 'now', 'cancel'].includes(body.action)) {
        return reply({ error: 'Choose an activity update action.' }, 400);
    }
    if (body.action !== 'cancel' && body.revision !== release.revision) {
        return reply({ error: 'A new release arrived. Reload activity updates before retrying.' }, 409);
    }
    async function schedule(row: Row & { runId: string }, mode: 'safe' | 'now') {
        if (row.standalone && standalone) await standalone.request(row.runId, release, mode);
        else plans.requestUpdate(row.bot, row.index, row.planRevision, row.runId, release, mode);
    }
    if (body.action === 'compatible') {
        let scheduled = 0;
        for (const row of rows) {
            if (row.status !== 'available' || row.checkpoint !== 'supported' || !row.runId) continue;
            try {
                await schedule({ ...row, runId: row.runId }, 'safe');
                scheduled++;
            } catch { /* This activity changed while preparing the bulk request. */ }
        }
        return reply({ revision: release.revision, rows: await describe(plans, source, release, standalone), scheduled }, 202);
    }
    const row = rows.find(row => row.bot === body.bot && row.index === body.index && row.planRevision === body.planRevision &&
        row.runId && row.runId === body.runId);
    if (!row?.runId) return reply({ error: 'The saved plan or running activity changed. Open the updates list again.' }, 409);
    try {
        if (body.action === 'cancel') {
            if (row.standalone && standalone) standalone.cancel(row.runId);
            else plans.cancelUpdate(row.bot, row.runId);
        }
        else {
            if (row.status !== 'available') return reply({ error: row.reason ?? 'There is no compatible update for this run.' }, 409);
            await schedule({ ...row, runId: row.runId }, body.action === 'now' ? 'now' : 'safe');
        }
    } catch (error) {
        return reply({ error: error instanceof Error ? error.message : 'The activity changed. Open the updates list again.' }, 409);
    }
    return reply({ revision: release.revision, rows: await describe(plans, source, release, standalone) }, 202);
}

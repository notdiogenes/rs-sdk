import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dashboardAuditInsights } from './dashboard-audit-insights';

const day = 86_400_000;
export const auditRetentionDays = 35;
const detailBudget = 240_000;
const safeName = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const kinds = new Set(['phase', 'action', 'check', 'failure', 'state', 'milestone', 'setback', 'worker', 'task-event', 'decision', 'intent', 'result']);
type AuditKind = 'phase' | 'action' | 'check' | 'failure' | 'state' | 'milestone' | 'setback' | 'worker' | 'task-event' | 'decision' | 'intent' | 'result';
type AuditEvent = { kind: AuditKind; name: string; outcome?: string; [key: string]: unknown };
type Active = { phase: string; at: number; secrets: readonly string[]; pendingCheck?: string };

export function redactAudit(value: string, secrets: readonly string[]) {
    for (const secret of secrets) if (secret.length >= 4) value = value.split(secret).join('[redacted]');
    return value.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
        .replace(/([?&](?:password|token|secret|key)=)[^&\s"')]+/gi, '$1[redacted]')
        .replace(/\b(password|token|secret|authorization)\s*[:=]\s*[^\s,]+/gi, '$1=[redacted]');
}

function encode(data: AuditEvent, secrets: readonly string[]) {
    const value = JSON.stringify(data, (key, value) =>
        /^(?:password|token|secret|authorization|chat|privateMessage)$/i.test(key) ? undefined
            : typeof value === 'string' ? redactAudit(value, secrets).slice(0, 520) : value);
    return value.length < 8500 ? value : JSON.stringify({ kind: data.kind, name: data.name, outcome: data.outcome, truncated: true });
}

export function dashboardAudit(directory: string, clock = Date.now) {
    const db = new Database(join(directory, 'activity-audit.sqlite'), { create: true });
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS audit_runs (
            id TEXT PRIMARY KEY, bot TEXT NOT NULL COLLATE NOCASE, task TEXT NOT NULL,
            revision TEXT, script_sha TEXT, started_at INTEGER NOT NULL,
            ended_at INTEGER, status TEXT NOT NULL, exit_code INTEGER,
            failure_phase TEXT, failure_step TEXT, failure_site TEXT, failure_message TEXT, failure_evidence TEXT,
            detail_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS audit_runs_bot ON audit_runs(bot, started_at DESC);
        CREATE INDEX IF NOT EXISTS audit_runs_task ON audit_runs(task, started_at DESC);
        CREATE INDEX IF NOT EXISTS audit_runs_recent ON audit_runs(started_at DESC);
        CREATE TABLE IF NOT EXISTS audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
            at INTEGER NOT NULL, phase TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audit_events_run ON audit_events(run_id, id DESC);
        CREATE TABLE IF NOT EXISTS audit_phases (
            run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE, phase TEXT NOT NULL,
            visits INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
            actions INTEGER NOT NULL DEFAULT 0, dispatch_failures INTEGER NOT NULL DEFAULT 0,
            timeouts INTEGER NOT NULL DEFAULT 0, setbacks INTEGER NOT NULL DEFAULT 0,
            strategy TEXT,
            PRIMARY KEY (run_id, phase)
        );
        CREATE TABLE IF NOT EXISTS audit_signals (
            run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
            phase TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, evidence TEXT,
            PRIMARY KEY (run_id, phase, kind, name)
        );
        CREATE TABLE IF NOT EXISTS audit_attempt_metrics (
            run_id TEXT NOT NULL, phase TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
            elapsed_ms INTEGER NOT NULL, xp_gained INTEGER NOT NULL, coins_gained INTEGER NOT NULL, hp_lost INTEGER NOT NULL,
            PRIMARY KEY (run_id, phase, kind, name),
            FOREIGN KEY (run_id, phase, kind, name) REFERENCES audit_signals(run_id, phase, kind, name) ON DELETE CASCADE
        );
    `);
    const insights = dashboardAuditInsights(db, clock());
    const active = new Map<string, Active>();
    const insert = db.query('INSERT INTO audit_events (run_id, at, phase, kind, name, data) VALUES (?, ?, ?, ?, ?, ?)');
    const count = db.query('UPDATE audit_runs SET detail_count = detail_count + 1 WHERE id = ?');
    const phase = db.query(`INSERT INTO audit_phases (run_id, phase, visits, duration_ms, actions, dispatch_failures, timeouts, setbacks)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, phase) DO UPDATE SET
        visits = visits + excluded.visits, duration_ms = duration_ms + excluded.duration_ms,
        actions = actions + excluded.actions, dispatch_failures = dispatch_failures + excluded.dispatch_failures,
        timeouts = timeouts + excluded.timeouts, setbacks = setbacks + excluded.setbacks`);
    const signal = db.query(`INSERT INTO audit_signals (run_id, phase, kind, name, count, evidence) VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(run_id, phase, kind, name) DO UPDATE SET count = count + 1, evidence = excluded.evidence`);
    const attemptMetrics = db.query(`INSERT INTO audit_attempt_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, phase, kind, name) DO UPDATE SET elapsed_ms = elapsed_ms + excluded.elapsed_ms,
        xp_gained = xp_gained + excluded.xp_gained, coins_gained = coins_gained + excluded.coins_gained, hp_lost = hp_lost + excluded.hp_lost`);
    const nonnegativeInteger = (value: unknown) =>
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
    const setbackContext = db.query<{ kind: string; name: string; data: string }, [string, string]>(`
        SELECT kind, name, data FROM audit_events WHERE run_id = ? AND phase = ?
        AND kind IN ('check', 'action', 'setback', 'decision', 'intent', 'result') ORDER BY id DESC LIMIT 8
    `);
    const recentEvidence = db.query<{ id: number; at: number; phase: string; kind: string; name: string; data: string }, [string]>(`
        SELECT id, at, phase, kind, name, data FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY id DESC) AS rank
            FROM (SELECT * FROM audit_events WHERE run_id = ? ORDER BY id DESC LIMIT 500)
        ) WHERE rank <= CASE kind WHEN 'action' THEN 12 WHEN 'check' THEN 10 WHEN 'intent' THEN 10
            WHEN 'result' THEN 10 WHEN 'state' THEN 2 ELSE 4 END ORDER BY id
    `);

    function prune() {
        const cutoff = clock() - auditRetentionDays * day;
        db.query('DELETE FROM audit_runs WHERE COALESCE(ended_at, started_at) < ? AND status <> ?').run(cutoff, 'running');
        insights.prune(cutoff);
        // Keep the time budget for reports even when high-volume activity
        // forces low-level traces out of the detail budget early.
        db.query(`DELETE FROM audit_events WHERE id <= (
            SELECT id FROM audit_events ORDER BY id DESC LIMIT 1 OFFSET ?
        )`).run(detailBudget);
    }
    db.query(`UPDATE audit_runs SET status = 'interrupted',
        ended_at = COALESCE((SELECT MAX(at) FROM audit_events WHERE run_id = audit_runs.id), started_at)
        WHERE status = 'running'`).run();
    prune();

    function begin(bot: string, task: string, revision: string | null, scriptSha: string | null, secrets: readonly string[]) {
        const id = randomUUID();
        const at = clock();
        db.query(`INSERT INTO audit_runs (id, bot, task, revision, script_sha, started_at, status)
            VALUES (?, ?, ?, ?, ?, ?, 'running')`).run(id, bot, task, revision, scriptSha, at);
        active.set(id, { phase: 'startup', at, secrets });
        phase.run(id, 'startup', 1, 0, 0, 0, 0, 0);
        return id;
    }

    const append = db.transaction((id: string, data: AuditEvent) => {
        const run = active.get(id);
        if (!run || !kinds.has(data.kind) || typeof data.name !== 'string' || !safeName.test(data.name)) return;
        const now = clock();
        if (data.kind === 'phase' && data.name !== run.phase) {
            phase.run(id, run.phase, 0, Math.max(0, now - run.at), 0, 0, 0, 0);
            insights.recordTime(id, run.phase, run.at, now);
            run.phase = data.name;
            run.at = now;
            run.pendingCheck = undefined;
            phase.run(id, run.phase, 1, 0, 0, 0, 0, 0);
        }
        if (data.kind === 'phase' && typeof data.strategy === 'string' && safeName.test(data.strategy)) {
            db.query('UPDATE audit_phases SET strategy = ? WHERE run_id = ? AND phase = ?').run(data.strategy, id, run.phase);
        }
        const action = data.kind === 'action';
        const failedDispatch = action && data.outcome === 'failed';
        const timeout = data.kind === 'check' && data.outcome === 'timeout';
        const isSetback = data.kind === 'setback';
        const checkpointMs = now - run.at >= 5000 ? now - run.at : 0;
        if (action || timeout || isSetback || checkpointMs) {
            phase.run(id, run.phase, 0, checkpointMs, +action, +failedDispatch, +timeout, +isSetback);
            if (checkpointMs) {
                insights.recordTime(id, run.phase, run.at, now);
                run.at = now;
            }
        }
        if (data.kind === 'check' && ['failed', 'timeout', 'unconfirmed'].includes(data.outcome ?? '')) {
            if (!run.pendingCheck || data.name !== 'state-observation') run.pendingCheck = data.name;
        }
        if (data.kind === 'check' && data.outcome === 'complete' && run.pendingCheck === data.name) run.pendingCheck = undefined;
        if (data.kind === 'failure') {
            const frames = Array.isArray(data.stack) ? data.stack.filter(frame => typeof frame === 'string') : [];
            const site = frames.map(frame => frame.match(/control\/tasks\/[a-z0-9_.\/-]+\.ts:\d+(?::\d+)?/i)?.[0]
                ?? frame.match(/sdk\/[a-z0-9_.-]+\.ts:\d+(?::\d+)?/i)?.[0]).filter(frame => frame !== undefined);
            const message = data.message ?? data.error;
            const described = typeof message === 'string' ? redactAudit(message, run.secrets).slice(0, 520) : null;
            db.query(`UPDATE audit_runs SET failure_phase = ?, failure_step = ?, failure_site = ?, failure_message = ?
                WHERE id = ? AND (failure_step IS NULL OR ? = 'script-finish')`).run(
                run.phase, run.pendingCheck ?? data.name, site.find(frame => frame.startsWith('control/tasks/') && !frame.includes('/shared.ts:')) ?? site[0] ?? null,
                described, id, data.name);
        }
        insert.run(id, now, run.phase, data.kind, data.name, encode(data, run.secrets));
        if (isSetback || data.kind === 'milestone') {
            const evidence = isSetback ? JSON.stringify(setbackContext.all(id, run.phase).reverse()
                .map(row => ({ ...row, data: JSON.parse(row.data) }))) : null;
            signal.run(id, run.phase, data.kind, data.name, evidence);
            const xp = nonnegativeInteger(data.xpGained);
            const coins = nonnegativeInteger(data.coinsGained);
            insights.recordSignal(id, run.phase, now, data.name, isSetback, xp, coins);
            if (data.name.startsWith('pickpocket-attempt-') || data.name.startsWith('combat-round-')) {
                attemptMetrics.run(id, run.phase, data.kind, data.name, nonnegativeInteger(data.elapsedMs),
                    xp, coins, nonnegativeInteger(data.hpLost));
            }
        }
        count.run(id);
    });

    const finish = db.transaction((id: string, exitCode: number, stopped: boolean) => {
        const run = active.get(id);
        if (!run) return;
        const now = clock();
        const status = stopped ? 'stopped' : exitCode === 0 ? 'succeeded' : 'failed';
        phase.run(id, run.phase, 0, Math.max(0, now - run.at), 0, 0, 0, 0);
        insights.recordTime(id, run.phase, run.at, now);
        const evidence = status === 'failed'
            ? JSON.stringify(recentEvidence.all(id).map(row => ({ ...row, data: JSON.parse(row.data) }))) : null;
        db.query(`UPDATE audit_runs SET ended_at = ?, status = ?, exit_code = ?,
            failure_phase = CASE WHEN ? = 'failed' THEN COALESCE(failure_phase, ?) ELSE NULL END,
            failure_step = CASE WHEN ? = 'failed' THEN COALESCE(failure_step, ?) ELSE NULL END, failure_evidence = ? WHERE id = ?`)
            .run(now, status, exitCode, status, run.phase, status, run.pendingCheck ?? 'worker-exited', evidence, id);
        active.delete(id);
    });

    function read(params: URLSearchParams) {
        const bot = params.get('bot');
        const task = params.get('task');
        const id = params.get('run');
        const through = params.get('phase');
        const revision = params.get('revision');
        const mode = params.get('mode') ?? 'runs';
        const bounded = (name: string, fallback: number, minimum: number, maximum: number) => {
            const n = params.has(name) ? Number(params.get(name)) : fallback;
            if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new Error(`Invalid ${name}`);
            return n;
        };
        const limit = bounded('limit', 50, 1, 100);
        const days = bounded('days', 7, 1, auditRetentionDays);
        const before = bounded('before', Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
        if (bot && !/^[a-z0-9][a-z0-9 ]{0,11}$/i.test(bot)) throw new Error('Invalid bot');
        if (task && !safeName.test(task)) throw new Error('Invalid task');
        if (through && !safeName.test(through)) throw new Error('Invalid phase');
        if (id) {
            if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid run');
            const row = db.query<{ failure_evidence: string | null }, [string, string | null, string | null]>(
                `SELECT *, (SELECT COUNT(*) FROM audit_events WHERE run_id = audit_runs.id) AS details_available
                FROM audit_runs WHERE id = ? AND (? IS NULL OR bot = ?)`).get(id, bot, bot);
            if (!row) return null;
            const { failure_evidence, ...run } = row;
            const detail = db.query<{ id: number; at: number; phase: string; kind: string; name: string; data: string }, [string, number, string | null, string | null, number]>(
                `SELECT id, at, phase, kind, name, data FROM audit_events
                 WHERE run_id = ? AND id < ? AND (? IS NULL OR phase = ?) ORDER BY id DESC LIMIT ?`)
                .all(id, before, through, through, limit + 1);
            return { run, phases: db.query('SELECT * FROM audit_phases WHERE run_id = ? ORDER BY phase').all(id),
                signals: db.query<{ evidence: string | null }, [string]>(`SELECT s.*, m.elapsed_ms, m.xp_gained,
                    m.coins_gained, m.hp_lost FROM audit_signals s LEFT JOIN audit_attempt_metrics m USING(run_id, phase, kind, name)
                    WHERE s.run_id = ? ORDER BY s.phase, s.kind, s.name`)
                    .all(id).map(row => ({ ...row, evidence: row.evidence && JSON.parse(row.evidence) })),
                failureEvidence: failure_evidence ? JSON.parse(failure_evidence) : [],
                nextBefore: detail.length > limit ? detail[limit - 1]?.id : null,
                events: detail.slice(0, limit).reverse().map(row => ({ ...row, data: JSON.parse(row.data) })) };
        }
        const since = clock() - days * day;
        if (mode === 'insights') {
            if (revision && !/^[0-9a-f]{7,40}$/i.test(revision)) throw new Error('Invalid revision');
            return { ...insights.read({ since, bot, task, phase: through, revision: revision || null }) };
        }
        const scope = 'r.started_at >= ? AND (? IS NULL OR r.bot = ?) AND (? IS NULL OR r.task = ?)';
        const filters = [since, bot, bot, task, task] as const;
        if (mode === 'summary') {
            const outcome = `CASE WHEN r.status = 'failed' AND r.failure_phase <> p.phase THEN 'before-failure'
                WHEN r.status = 'failed' THEN 'failure-phase' ELSE r.status END`;
            const totals = db.query(`SELECT r.task, r.revision, p.phase, p.strategy, ${outcome} AS run_outcome,
                COUNT(*) AS runs, COUNT(DISTINCT r.bot) AS bots, SUM(p.visits) AS visits,
                SUM(p.duration_ms) AS duration_ms, MAX(p.duration_ms) AS max_duration_ms,
                SUM(p.actions) AS actions, SUM(p.dispatch_failures) AS dispatch_failures,
                SUM(p.timeouts) AS timeouts, SUM(p.setbacks) AS setbacks
                FROM audit_phases p JOIN audit_runs r ON r.id = p.run_id
                WHERE ${scope} AND (? IS NULL OR p.phase = ?)
                GROUP BY r.task, r.revision, p.phase, p.strategy, run_outcome
                ORDER BY setbacks DESC, timeouts DESC, duration_ms DESC LIMIT ?`)
                .all(...filters, through, through, limit);
            const signals = db.query(`SELECT r.task, r.revision, s.phase, p.strategy, s.kind, s.name, SUM(s.count) AS count,
                COUNT(DISTINCT r.id) AS runs, COUNT(DISTINCT r.bot) AS bots,
                SUM(m.elapsed_ms) AS elapsed_ms, SUM(m.xp_gained) AS xp_gained, SUM(m.coins_gained) AS coins_gained, SUM(m.hp_lost) AS hp_lost,
                SUM(CASE WHEN r.status = 'succeeded' THEN s.count ELSE 0 END) AS in_successful_runs,
                SUM(CASE WHEN r.status = 'failed' AND r.failure_phase <> s.phase THEN s.count ELSE 0 END) AS before_later_failure
                FROM audit_signals s JOIN audit_runs r ON r.id = s.run_id
                JOIN audit_phases p ON p.run_id = s.run_id AND p.phase = s.phase
                LEFT JOIN audit_attempt_metrics m ON m.run_id = s.run_id AND m.phase = s.phase AND m.kind = s.kind AND m.name = s.name
                WHERE ${scope} AND (? IS NULL OR s.phase = ?) GROUP BY r.task, r.revision, s.phase, p.strategy, s.kind, s.name
                ORDER BY count DESC LIMIT ?`).all(...filters, through, through, limit);
            const breakpoints = db.query(`SELECT r.task, r.revision, r.failure_phase AS phase,
                r.failure_step AS step, r.failure_site AS site, MIN(r.failure_message) AS example_message,
                MAX(r.ended_at) AS last_seen, COUNT(*) AS runs, COUNT(DISTINCT r.bot) AS bots
                FROM audit_runs r WHERE ${scope} AND r.status = 'failed' AND (? IS NULL OR r.failure_phase = ?)
                GROUP BY r.task, r.revision, r.failure_phase, r.failure_step, r.failure_site
                ORDER BY runs DESC, last_seen DESC LIMIT ?`).all(...filters, through, through, limit);
            return { since, totals, signals, breakpoints, retentionDays: auditRetentionDays };
        }
        if (mode !== 'runs') throw new Error('Unknown audit mode');
        const runs = db.query<{ rowid: number; id: string }, [number, string | null, string | null, string | null, string | null, number, number]>(
            `SELECT r.rowid, r.id, r.bot, r.task, r.revision, r.script_sha, r.started_at, r.ended_at, r.status,
             r.exit_code, r.failure_phase, r.failure_step, r.failure_site, r.failure_message, r.detail_count
             FROM audit_runs r WHERE ${scope} AND r.rowid < ? ORDER BY r.rowid DESC LIMIT ?`)
            .all(...filters, before, limit + 1);
        return { since, runs: runs.slice(0, limit), nextBefore: runs.length > limit ? runs[limit - 1]?.rowid : null,
            retentionDays: auditRetentionDays };
    }

    return { begin, append, finish, prune, read, close: () => db.close() };
}

export type DashboardAudit = ReturnType<typeof dashboardAudit>;

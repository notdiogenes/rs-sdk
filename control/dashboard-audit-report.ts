import type { Database } from 'bun:sqlite';
import { auditDay, auditKinds, auditRetentionDays, safeAuditName } from './dashboard-audit-schema';
import { readDashboardAuditInsights } from './dashboard-audit-insights-report';

export function auditDashboardLocation(searchParams: URLSearchParams) {
    const dashboard = new URLSearchParams({ audit: '1' });
    for (const key of ['bot', 'task', 'run', 'phase', 'mode', 'days', 'before', 'limit', 'revision',
        'baseline', 'event', 'kind', 'operation', 'runPhase']) {
        const value = searchParams.get(key);
        if (value) dashboard.set(key, value);
    }
    return '/bots?' + dashboard;
}

export function readDashboardAudit(db: Database, now: number, params: URLSearchParams) {
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
    if (task && !safeAuditName.test(task)) throw new Error('Invalid task');
    if (through && !safeAuditName.test(through)) throw new Error('Invalid phase');
    if (id) {
        if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid run');
        const event = params.get('event');
        const kind = params.get('kind');
        const operation = params.has('operation') ? bounded('operation', 0, 1, Number.MAX_SAFE_INTEGER) : null;
        if (event && !safeAuditName.test(event)) throw new Error('Invalid event');
        if (kind && kind !== 'key' && !auditKinds.has(kind)) throw new Error('Invalid kind');
        const row = db.query<{ failure_evidence: string | null; details_available: number }, [string, string | null, string | null]>(
            `SELECT *, (SELECT COUNT(*) FROM audit_events WHERE run_id = audit_runs.id) AS details_available
            FROM audit_runs WHERE id = ? AND (? IS NULL OR bot = ?)`).get(id, bot, bot);
        if (!row) return null;
        const { failure_evidence, ...run } = row;
        const conditions = ['run_id = ?'];
        const values: Array<string | number> = [id];
        if (operation !== null) {
            conditions.push(`(json_extract(data, '$.operationId') = ? OR json_extract(data, '$.parentOperationId') = ?
                OR json_extract(data, '$.operationId') IN (
                    SELECT json_extract(data, '$.operationId') FROM audit_events
                    WHERE run_id = ? AND json_extract(data, '$.parentOperationId') = ?
                ))`);
            values.push(operation, operation, id, operation);
        } else {
            if (through) { conditions.push('phase = ?'); values.push(through); }
            if (event) { conditions.push('name = ?'); values.push(event); }
            if (kind === 'key') {
                conditions.push("kind IN ('phase', 'result', 'setback', 'failure', 'milestone')");
            } else if (kind) { conditions.push('kind = ?'); values.push(kind); }
        }
        const where = conditions.join(' AND ');
        const matchingEvents = conditions.length > 1
            ? db.query<{ count: number }, Array<string | number>>(`SELECT COUNT(*) AS count FROM audit_events WHERE ${where}`).get(...values)!.count
            : run.details_available;
        const detail = db.query<{ id: number; at: number; phase: string; kind: string; name: string; data: string }, Array<string | number>>(
            `SELECT id, at, phase, kind, name, data FROM audit_events WHERE ${where} AND id < ? ORDER BY id DESC LIMIT ?`)
            .all(...values, before, limit + 1);
        return { run, phases: db.query('SELECT * FROM audit_phases WHERE run_id = ? ORDER BY phase').all(id),
            signals: db.query<{ evidence: string | null }, [string]>(`SELECT s.*, m.elapsed_ms, m.xp_gained,
                m.coins_gained, m.hp_lost FROM audit_signals s LEFT JOIN audit_attempt_metrics m USING(run_id, phase, kind, name)
                WHERE s.run_id = ? ORDER BY s.phase, s.kind, s.name`)
                .all(id).map(row => ({ ...row, evidence: row.evidence && JSON.parse(row.evidence) })),
        matchingEvents, failureEvidence: failure_evidence ? JSON.parse(failure_evidence) : [],
            nextBefore: detail.length > limit ? detail[limit - 1]?.id : null,
            events: detail.slice(0, limit).reverse().map(row => ({ ...row, data: JSON.parse(row.data) })) };
    }
    const since = now - days * auditDay;
    if (mode === 'insights') {
        if (revision && !/^[0-9a-f]{7,40}$/i.test(revision)) throw new Error('Invalid revision');
        const baseline = params.get('baseline')?.toLowerCase();
        const current = revision?.toLowerCase();
        if (baseline && (!/^[0-9a-f]{7,40}$/.test(baseline) || !current ||
            current.startsWith(baseline) || baseline.startsWith(current))) throw new Error('Invalid baseline');
        const scope = { since, bot, task, phase: through, revision: revision || null };
        const report = readDashboardAuditInsights(db, scope);
        return baseline ? { ...report, baseline: readDashboardAuditInsights(db, { ...scope, revision: baseline }) } : report;
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

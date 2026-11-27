import type { Database } from 'bun:sqlite';

const hour = 3_600_000;
const easternDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const easternDay = (at: number) => {
    const parts = Object.fromEntries(easternDate.formatToParts(at).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
};
type Scope = { since: number; bot: string | null; task: string | null; phase: string | null; revision: string | null };
type Filters = [number, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null];

export function readDashboardAuditInsights(db: Database, { since, bot, task, phase, revision }: Scope) {
    const cohort = `WITH runs AS (
        SELECT * FROM audit_runs WHERE started_at >= ? AND (? IS NULL OR bot = ?) AND (? IS NULL OR task = ?)
        AND (? IS NULL OR revision LIKE ?)
    )`;
    const revisionPattern = revision && revision + '%';
    const phaseFilters: Filters = [since, bot, bot, task, task, revision, revisionPattern, phase, phase];
    const revisions = db.query<{ revision: string; runs: number }, Filters>(
        `${cohort} SELECT revision, COUNT(*) AS runs FROM runs r
        WHERE revision IS NOT NULL AND (? IS NULL OR EXISTS (
            SELECT 1 FROM audit_phases p WHERE p.run_id = r.id AND p.phase = ?
        )) GROUP BY revision ORDER BY MAX(r.started_at) DESC, revision LIMIT 50`)
        .all(since, bot, bot, task, task, null, null, phase, phase);
    const sample = db.query<{ runs: number; bots: number; running: number; interrupted: number; failed: number; stopped: number; succeeded: number }, Filters>(
        `${cohort} SELECT COUNT(*) AS runs, COUNT(DISTINCT bot) AS bots,
        COUNT(CASE WHEN status = 'running' THEN 1 END) AS running,
        COUNT(CASE WHEN status = 'interrupted' THEN 1 END) AS interrupted,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed,
        COUNT(CASE WHEN status = 'stopped' THEN 1 END) AS stopped,
        COUNT(CASE WHEN status = 'succeeded' THEN 1 END) AS succeeded
        FROM runs r WHERE (? IS NULL OR EXISTS (SELECT 1 FROM audit_phases p WHERE p.run_id = r.id AND p.phase = ?))`)
        .get(...phaseFilters)!;
    const phases = db.query<{ phase: string; duration_ms: number; run_id: string }, Filters>(
        `${cohort} SELECT p.phase, SUM(p.duration_ms) AS duration_ms, MAX(p.run_id) AS run_id
        FROM audit_phases p JOIN runs r ON p.run_id = r.id
        WHERE (? IS NULL OR p.phase = ?) GROUP BY p.phase ORDER BY duration_ms DESC, p.phase`)
        .all(...phaseFilters);
    const retainedTrace = `MAX(CASE WHEN EXISTS (
        SELECT 1 FROM audit_events e WHERE e.run_id = s.run_id AND e.name = s.name AND e.phase = s.phase AND e.kind = s.kind
    ) THEN s.run_id END)`;
    const attempts = db.query<{ name: string; count: number; elapsed_ms: number; xp_gain: number; coin_gain: number; run_id: string; trace_run_id: string | null }, Filters>(
        `${cohort} SELECT s.name, SUM(s.count) AS count, SUM(m.elapsed_ms) AS elapsed_ms,
        SUM(m.xp_gained) AS xp_gain, SUM(m.coins_gained) AS coin_gain, MAX(s.run_id) AS run_id,
        ${retainedTrace} AS trace_run_id
        FROM audit_signals s JOIN runs r ON r.id = s.run_id
        JOIN audit_attempt_metrics m USING (run_id, phase, kind, name)
        WHERE (? IS NULL OR s.phase = ?) GROUP BY s.name ORDER BY count DESC, s.name`).all(...phaseFilters);
    const setbacks = db.query(`${cohort} SELECT r.task, s.phase, s.name, SUM(s.count) AS count,
        SUM(CASE WHEN r.status = 'succeeded' THEN s.count ELSE 0 END) AS successful_runs,
        SUM(CASE WHEN r.status = 'failed' AND r.failure_phase <> s.phase THEN s.count ELSE 0 END) AS before_later_failure,
        COUNT(DISTINCT s.run_id) AS runs, COALESCE(MAX(CASE WHEN r.status = 'succeeded' THEN s.run_id END), MAX(s.run_id)) AS run_id,
        ${retainedTrace} AS trace_run_id
        FROM audit_signals s JOIN runs r ON r.id = s.run_id
        WHERE s.kind = 'setback' AND (? IS NULL OR s.phase = ?)
        GROUP BY r.task, s.phase, s.name ORDER BY count DESC, r.task, s.phase, s.name LIMIT 10`).all(...phaseFilters);
    const failures = db.query(`${cohort}, groups AS (
        SELECT task, revision, failure_phase AS phase, failure_step AS step,
            failure_site AS site, COUNT(*) AS count, COUNT(DISTINCT bot) AS bots,
            MAX(ended_at) AS last_seen, MAX(id) AS run_id
        FROM runs WHERE status = 'failed' AND (? IS NULL OR failure_phase = ?)
        GROUP BY task, revision, failure_phase, failure_step, failure_site ORDER BY count DESC, last_seen DESC LIMIT 10
    ) SELECT g.*, r.failure_message AS message FROM groups g JOIN runs r ON r.id = g.run_id
        ORDER BY g.count DESC, g.last_seen DESC`).all(...phaseFilters);
    const durationMs = phases.reduce((sum, row) => sum + row.duration_ms, 0);
    const pickpockets = attempts.filter(row => row.name.startsWith('pickpocket-attempt-'));
    const pickpocketCount = pickpockets.reduce((sum, row) => sum + row.count, 0);
    const pickpocketSuccesses = pickpockets.find(row => row.name === 'pickpocket-attempt-succeeded')?.count ?? 0;
    const canCompareRates = !!task && !phase && (task.startsWith('pickpocket-') || ['train-hitpoints', 'train-cows'].includes(task));
    const xp = attempts.reduce((sum, row) => sum + row.xp_gain, 0);
    const coins = pickpockets.reduce((sum, row) => sum + row.coin_gain, 0);
    const coverage = db.query<{ trend_start: number }, []>('SELECT trend_start FROM audit_insights_meta WHERE id = 1').get()!.trend_start;
    const rangeStart = Math.ceil(since / hour) * hour;
    const trends = db.query<{
        hour_start: number; duration_ms: number; attempts: number; successes: number; setbacks: number; xp: number; coins: number;
    }, Filters>(`
        SELECT b.hour_start, SUM(b.duration_ms) AS duration_ms,
            SUM(CASE WHEN b.metric LIKE 'pickpocket-attempt-%' THEN b.count ELSE 0 END) AS attempts,
            SUM(CASE WHEN b.metric = 'pickpocket-attempt-succeeded' THEN b.count ELSE 0 END) AS successes,
            SUM(CASE WHEN b.metric = 'setback' THEN b.count ELSE 0 END) AS setbacks,
            SUM(b.xp) AS xp, SUM(b.coins) AS coins
        FROM audit_hourly b JOIN audit_runs r ON r.id = b.run_id
        WHERE b.hour_start >= ? AND (? IS NULL OR r.bot = ?) AND (? IS NULL OR r.task = ?)
            AND (? IS NULL OR r.revision LIKE ?) AND (? IS NULL OR b.phase = ?)
        GROUP BY b.hour_start ORDER BY b.hour_start`).all(rangeStart, bot, bot, task, task, revision, revisionPattern, phase, phase);
    const daily = new Map<string, { date: string; duration_ms: number; attempts: number; successes: number; setbacks: number; xp: number; coins: number }>();
    for (const row of trends) {
        const date = easternDay(row.hour_start);
        const data = daily.get(date) ?? { date, duration_ms: 0, attempts: 0, successes: 0, setbacks: 0, xp: 0, coins: 0 };
        data.duration_ms += row.duration_ms;
        data.attempts += row.attempts;
        data.successes += row.successes;
        data.setbacks += row.setbacks;
        data.xp += row.xp;
        data.coins += row.coins;
        daily.set(date, data);
    }
    return {
        since, scope: { bot, task, phase, revision }, sample, revisions, durationMs,
        phases: phases.map(row => ({ ...row, share: durationMs ? row.duration_ms / durationMs : null })),
        attempts, setbacks, failures,
        pickpocket: { count: pickpocketCount, successes: pickpocketSuccesses,
            successRate: pickpocketCount ? pickpocketSuccesses / pickpocketCount : null },
        throughput: {
            xp, coins, xpPerHour: canCompareRates && durationMs && attempts.length ? xp * hour / durationMs : null,
            coinsPerHour: canCompareRates && durationMs && pickpocketCount ? coins * hour / durationMs : null,
        },
        trend: { timeZone: 'America/New_York', coverageStart: Math.max(rangeStart, coverage),
            days: [...daily.values()].map(row => ({ ...row,
                xpPerHour: canCompareRates && row.duration_ms && (row.attempts || row.xp > 0) ? row.xp * hour / row.duration_ms : null,
            })) },
    };
}

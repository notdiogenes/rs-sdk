import type { Database } from 'bun:sqlite';

const hour = 3_600_000;


export function dashboardAuditInsights(db: Database, startedAt: number) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS audit_insights_meta (
            id INTEGER PRIMARY KEY CHECK (id = 1), trend_start INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_hourly (
            hour_start INTEGER NOT NULL, run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
            phase TEXT NOT NULL, metric TEXT NOT NULL, duration_ms INTEGER NOT NULL,
            count INTEGER NOT NULL, xp INTEGER NOT NULL, coins INTEGER NOT NULL,
            PRIMARY KEY (hour_start, run_id, phase, metric)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS audit_hourly_run ON audit_hourly(run_id);
    `);
    db.query('INSERT OR IGNORE INTO audit_insights_meta VALUES (1, ?)').run(startedAt);
    const add = db.query(`INSERT INTO audit_hourly VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(hour_start, run_id, phase, metric) DO UPDATE SET
        duration_ms = duration_ms + excluded.duration_ms, count = count + excluded.count,
        xp = xp + excluded.xp, coins = coins + excluded.coins`);
    const bucket = (at: number) => Math.floor(at / hour) * hour;

    function recordTime(id: string, phase: string, from: number, until: number) {
        for (let at = from; at < until;) {
            const start = bucket(at);
            const end = Math.min(until, start + hour);
            add.run(start, id, phase, 'duration', end - at, 0, 0, 0);
            at = end;
        }
    }

    function recordSignal(id: string, phase: string, at: number, name: string, setback: boolean, xp: number, coins: number) {
        if (name.startsWith('pickpocket-attempt-') || name.startsWith('combat-round-')) {
            add.run(bucket(at), id, phase, name, 0, 1, xp, coins);
        }
        if (setback) add.run(bucket(at), id, phase, 'setback', 0, 1, 0, 0);
    }

    function prune(cutoff: number) {
        db.query('DELETE FROM audit_hourly WHERE hour_start < ?').run(bucket(cutoff));
    }

    return { recordTime, recordSignal, prune };
}

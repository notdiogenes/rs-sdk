import type { Database } from 'bun:sqlite';
import { auditEvent } from '../sdk/audit-trace';
import type { LastActivity } from './dashboard-last-activity';

const event = 'fleet-activity';

// This label is visible on the public roster. Callers use game activity
// labels and destinations from their script, never raw logs or chat.
export function reportTaskActivity(label: string) {
    auditEvent('task-event', event, { label });
}

export function readTaskActivity(db: Database, bot: string, startedAt: number): LastActivity | undefined {
    const row = db.query<{ at: number; data: string }, [string, string, number, number]>(`
        SELECT e.at, e.data FROM audit_events e
        JOIN audit_runs r ON r.id = e.run_id
        WHERE r.id = (
            SELECT id FROM audit_runs WHERE bot = ? ORDER BY started_at DESC, rowid DESC LIMIT 1
        ) AND e.name = ? AND e.kind = 'task-event'
          AND r.status = 'running' AND r.started_at <= ? AND e.at >= ?
        ORDER BY e.id DESC LIMIT 1
    `).get(bot, event, startedAt, startedAt);
    if (!row || !Number.isFinite(row.at)) return;
    const { label } = JSON.parse(row.data);
    if (typeof label !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} .’'-]{0,95}$/u.test(label)) return;
    return { at: new Date(row.at).toISOString(), reason: label };
}

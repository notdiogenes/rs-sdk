export const auditDay = 86_400_000;
export const auditRetentionDays = 35;
export const safeAuditName = /^[a-z0-9][a-z0-9-]{0,63}$/i;
export const auditKinds = new Set(['phase', 'action', 'check', 'failure', 'state', 'milestone', 'setback', 'worker', 'task-event', 'decision', 'intent', 'result']);

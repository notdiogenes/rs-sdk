import { auditEvent } from '../../sdk/audit-trace';

export function reportBankStockTarget(banked: number, target: number, details: object = {}) {
    // Existing supervisors recognize this milestone for all bank-stock activities.
    auditEvent('milestone', 'mining-bank-target-confirmed', { ...details, banked, target });
}

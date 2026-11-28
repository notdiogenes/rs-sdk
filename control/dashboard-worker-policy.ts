import { checkStepCompatibility, finished, nextWork } from './dashboard-plan';
import { activity, activityIds, isActivity, type ActivityOptions } from './dashboard-task-catalog';
import { handleWorkerRequest } from './dashboard-worker-api';
import type { MeleeGoal } from './melee-training';

// Increment when the hot-loaded module needs a different supervisor contract.
export const workerPolicyVersion = 3;
export { activity, activityIds, isActivity, checkStepCompatibility, finished, nextWork, handleWorkerRequest };

export function taskEnvironment(skill?: string, bankTarget?: number, options?: ActivityOptions, meleeGoal?: MeleeGoal): Record<`RS_ACTIVITY_${string}`, string> {
    return {
        RS_ACTIVITY_MELEE_GOAL: meleeGoal ? JSON.stringify(meleeGoal) : '',
        RS_ACTIVITY_SKILL: skill ?? '',
        RS_ACTIVITY_BANK_TARGET: bankTarget === undefined ? '' : String(bankTarget),
        RS_ACTIVITY_PICKPOCKET_BANKING: options?.banking ? '1' : '',
    };
}

export type DashboardWorkerPolicy = {
    workerPolicyVersion: typeof workerPolicyVersion;
    activity: typeof activity;
    activityIds: typeof activityIds;
    isActivity: typeof isActivity;
    finished: typeof finished;
    nextWork: typeof nextWork;
    checkStepCompatibility: typeof checkStepCompatibility;
    handleWorkerRequest: typeof handleWorkerRequest;
    taskEnvironment: typeof taskEnvironment;
};

export type WorkerRelease = { revision: string | undefined; value: DashboardWorkerPolicy };
export type TaskRelease = {
    revision: string | undefined;
    path: string;
    sha: string | null;
    release(): Promise<void>;
};
export type DashboardWorkerUpdates = {
    load(): Promise<WorkerRelease>;
    current(): DashboardWorkerPolicy;
    pinTask(revision: string | undefined, script: string): Promise<TaskRelease>;
    changedPaths?(from: string, to: string): Promise<readonly string[]>;
};

export function isWorkerPolicy(value: unknown): value is DashboardWorkerPolicy {
    if (!value || typeof value !== 'object') return false;
    const policy = value as Partial<DashboardWorkerPolicy>;
    return policy.workerPolicyVersion === workerPolicyVersion && Array.isArray(policy.activityIds) &&
        typeof policy.activity === 'function' && typeof policy.isActivity === 'function' &&
        typeof policy.finished === 'function' && typeof policy.nextWork === 'function' && typeof policy.checkStepCompatibility === 'function' &&
        typeof policy.handleWorkerRequest === 'function' && typeof policy.taskEnvironment === 'function';
}

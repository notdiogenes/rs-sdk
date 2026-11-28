import type { BotWorldState } from '../sdk/types';
import { meleeGoalMet, parseMeleeGoal } from './melee-training';
import { upgradeActivityOptions } from './dashboard-activity-compatibility';
import { activity, activityIds, activityOptionsFor, finishModesFor, initialSettingsVersion, isActivity, inTutorialDestination, onTutorial, parseActivityOptions, trainingSkills,
    type ActivityId, type ActivityOptions, type Finish, type Requirement, type TrainingSkill } from './dashboard-task-catalog';

export type { Finish } from './dashboard-task-catalog';
export type Step = { task: ActivityId; finish: Finish; requirements: Requirement[]; options?: ActivityOptions; configurationVersion?: number };
export type Work = { task: ActivityId; finish: Finish; inserted: boolean; reason?: string; options?: ActivityOptions };

export class PlanConfigurationConflict extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlanConfigurationConflict';
    }
}

const isLevel = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 99;
const isSkill = (value: unknown): value is TrainingSkill =>
    trainingSkills.some(skill => skill === value);

function fields(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a plan step or requirement.');
    return value as Record<string, unknown>;
}

function parseRequirement(value: unknown): Requirement {
    const req = fields(value);
    if (req.type === 'level' && isSkill(req.skill) && isLevel(req.level)) {
        return { type: 'level', skill: req.skill, level: req.level };
    }
    if (req.type === 'quest' && isActivity(req.task) && activity(req.task).journal) {
        return { type: 'quest', task: req.task };
    }
    throw new Error('Choose a supported quest or a skill level between 1 and 99.');
}

export function parseSteps(value: unknown): Step[] {
    if (!Array.isArray(value) || !value.length || value.length > 12) throw new Error('Add between 1 and 12 activities.');
    return value.map((entry, index) => {
        const { task, finish, requirements = [], options } = fields(entry);
        if (!isActivity(task) || ['Setup', 'Legacy'].includes(activity(task).category)) {
            throw new Error('Choose an activity from the plan catalog.');
        }
        if (!Array.isArray(requirements) || requirements.length > 4) throw new Error('Use at most four requirements per activity.');
        const parsed = requirements.map(parseRequirement);
        if (parsed.some(req => req.type === 'quest' && req.task === task)) throw new Error('A quest cannot require itself.');
        const ending = fields(finish);
        const meta = activity(task);
        const enabled = parseActivityOptions(task, options);
        const step = {
            task, requirements: parsed, configurationVersion: meta.settingsVersion ?? initialSettingsVersion,
            ...(enabled && { options: enabled }),
        };
        const modes = finishModesFor(meta);
        switch (modes.find(mode => mode === ending.type)) {
            case 'melee-levels': return { ...step, finish: parseMeleeGoal(ending) };
            case 'complete': return { ...step, finish: { type: 'complete' } };
            case 'essence-exhausted': return { ...step, finish: { type: 'essence-exhausted' } };
            case 'forever':
                if (index !== value.length - 1) throw new Error('An indefinite grind must be the final activity.');
                return { ...step, finish: { type: 'forever' } };
            case 'bank-stock':
                if (typeof ending.quantity === 'number' && Number.isSafeInteger(ending.quantity) &&
                    ending.quantity >= 1 && ending.quantity <= 100_000) {
                    return { ...step, finish: { type: 'bank-stock', quantity: ending.quantity } };
                }
                break;
            case 'minutes':
                if (typeof ending.minutes === 'number' && Number.isSafeInteger(ending.minutes) &&
                    ending.minutes >= 1 && ending.minutes <= 10_080) {
                    return { ...step, finish: { type: 'minutes', minutes: ending.minutes } };
                }
                break;
            case 'level':
                if (isSkill(ending.skill) && meta.trains?.includes(ending.skill) && isLevel(ending.level)) {
                    return { ...step, finish: { type: 'level', skill: ending.skill, level: ending.level } };
                }
                break;
        }
        if (modes.length === 1 && modes[0] === 'bank-stock') {
            throw new Error(`Choose a target of 1–100,000 ${meta.bankStockItem} in the bank.`);
        }
        throw new Error('Choose a valid finish condition for each activity. Durations must be 1–10,080 minutes.');
    });
}

export function checkStepCompatibility(saved: Step): { status: 'compatible'; step: Step; migrated: boolean } | { status: 'review'; reason: string } {
    if (!isActivity(saved.task)) return { status: 'review', reason: 'This activity is no longer available. Choose another activity.' };
    const meta = activity(saved.task);
    try {
        const options = upgradeActivityOptions(meta.label, meta, saved.configurationVersion, saved.options);
        const step = parseSteps([{ ...saved, options }])[0]!;
        return { status: 'compatible', step, migrated: (saved.configurationVersion ?? initialSettingsVersion) !== step.configurationVersion };
    } catch (error) {
        return { status: 'review', reason: error instanceof Error ? error.message : 'Review the saved activity settings before continuing.' };
    }
}

function skillLevel(state: BotWorldState, name: TrainingSkill) {
    const result = state.skills.find(skill => skill.name === name)?.baseLevel;
    if (result === undefined || result < 1) throw new Error(`Waiting for ${name} game data.`);
    return result;
}

function questComplete(state: BotWorldState, id: ActivityId) {
    const journal = activity(id).journal;
    const progress = journal && state.questJournal?.[journal];
    if (!progress) throw new Error(`Waiting for the journal entry for ${activity(id).label}.`);
    return progress === 'complete';
}

export function finished(work: Work, state: BotWorldState, elapsedMs: number) {
    const finish = work.finish;
    if (finish.type === 'melee-levels') return meleeGoalMet(finish, state.skills);
    if (finish.type === 'level') return skillLevel(state, finish.skill) >= finish.level;
    if (finish.type === 'minutes') return elapsedMs >= finish.minutes * 60_000;
    if (finish.type === 'forever' || finish.type === 'essence-exhausted' || finish.type === 'bank-stock') return false;
    return work.task === 'skip-tutorial' ? !!state.player && inTutorialDestination(state.player.worldX, state.player.worldZ, state.player.level)
        : questComplete(state, work.task);
}

function met(req: Requirement, state: BotWorldState) {
    return req.type === 'level' ? skillLevel(state, req.skill) >= req.level
        : isActivity(req.task) && questComplete(state, req.task);
}

export function nextWork(saved: Step, state: BotWorldState, elapsedMs = 0): Work | null {
    const compatibility = checkStepCompatibility(saved);
    if (compatibility.status === 'review') throw new PlanConfigurationConflict(compatibility.reason);
    const { step } = compatibility;
    const player = state.player;
    if (!player) throw new Error('Waiting for live player data.');
    if (onTutorial(player.worldX, player.worldZ)) {
        return { task: 'skip-tutorial', finish: { type: 'complete' }, inserted: true, reason: 'Leave Tutorial Island' };
    }
    const requested: Work = { task: step.task, finish: step.finish, inserted: false, ...(step.options && { options: step.options }) };
    if (finished(requested, state, elapsedMs)) return null;

    function resolve(req: Requirement, visited: Set<ActivityId>): Work {
        if (req.type === 'quest') {
            if (!isActivity(req.task) || visited.has(req.task)) throw new Error('These quest requirements cannot be resolved.');
            const meta = activity(req.task);
            const earlier = meta.requirements?.find(requirement => !met(requirement, state));
            return earlier ? resolve(earlier, new Set([...visited, req.task])) : {
                task: req.task, finish: { type: 'complete' }, inserted: true, reason: `Requires ${meta.label}`,
            };
        }
        const providers = activityIds.filter(id => !visited.has(id) && activity(id).trains?.includes(req.skill));
        const threshold = (id: ActivityId) => activity(id).requirements?.reduce((max, entry) =>
            entry.type === 'level' && entry.skill === req.skill ? Math.max(max, entry.level) : max, 1) ?? 1;
        const candidates = providers.filter(id => threshold(id) < req.level).sort((a, b) => threshold(b) - threshold(a));
        const best = candidates.find(id => (activity(id).requirements ?? []).every(entry => met(entry, state)));
        if (!best) {
            const fallback = candidates.at(-1);
            if (!fallback) throw new Error(`No activity can train ${req.skill} to ${req.level}.`);
            const earlier = activity(fallback).requirements?.find(requirement => !met(requirement, state));
            if (!earlier) throw new Error(`Cannot satisfy ${req.skill} ${req.level}.`);
            return resolve(earlier, new Set([...visited, fallback]));
        }
        const unlocks = candidates.filter(id => threshold(id) > threshold(best) &&
            (activity(id).requirements ?? []).every(entry => entry.type === 'level' && entry.skill === req.skill || met(entry, state)))
            .map(threshold);
        const level = Math.min(req.level, ...unlocks);
        return { task: best, finish: { type: 'level', skill: req.skill, level }, inserted: true, reason: `Requires ${req.skill} ${req.level}` };
    }

    // Meet fixed requirements in catalog order, then any requirements added by the user.
    const missing = [...(activity(step.task).requirements ?? []), ...step.requirements].find(req => !met(req, state));
    if (!missing) return requested;
    const prerequisite = resolve(missing, new Set());
    const options = activityOptionsFor(prerequisite.task, step.options);
    return options ? { ...prerequisite, options } : prerequisite;
}

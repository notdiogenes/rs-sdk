import type { CombatStyleState, SkillState } from '../sdk/types';

export const meleeSkills = ['Attack', 'Strength', 'Defence'] as const;
export const meleeTargetSkills = [...meleeSkills, 'Hitpoints'] as const;
export const meleeStylePreferences = ['Balanced', 'Accurate', 'Aggressive', 'Defensive', 'Controlled'] as const;
type MeleeSkill = typeof meleeSkills[number];
type TargetSkill = typeof meleeTargetSkills[number];
export type MeleeGoal = {
    type: 'melee-levels';
    levels: Partial<Record<TargetSkill, number>>;
    style: typeof meleeStylePreferences[number];
};

export function parseMeleeGoal(value: unknown): MeleeGoal {
    if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'melee-levels' ||
        !('levels' in value) || !value.levels || typeof value.levels !== 'object' || Array.isArray(value.levels)) {
        throw new Error('Choose at least one melee or Hitpoints level.');
    }
    const raw = value.levels as Record<string, unknown>;
    if (!Object.keys(raw).length || Object.keys(raw).some(key => !meleeTargetSkills.some(skill => skill === key))) {
        throw new Error('Choose targets from Attack, Strength, Defence and Hitpoints.');
    }
    const levels: MeleeGoal['levels'] = {};
    for (const skill of meleeTargetSkills) {
        if (!Object.hasOwn(raw, skill)) continue;
        const level = raw[skill];
        if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 99) {
            throw new Error('Choose a minimum ' + skill + ' level between 1 and 99.');
        }
        levels[skill] = level;
    }
    const style = 'style' in value ? meleeStylePreferences.find(option => option === value.style) : 'Balanced';
    if (!style) throw new Error('Choose a supported melee style preference.');
    return { type: 'melee-levels', levels, style };
}

function stat(skills: readonly SkillState[], name: TargetSkill) {
    const data = skills.find(skill => skill.name === name);
    if (!data || !Number.isInteger(data.baseLevel) || data.baseLevel < 1) throw new Error('Waiting for ' + name + ' game data.');
    return data;
}

function belowTarget(goal: MeleeGoal, skills: readonly SkillState[], name: TargetSkill) {
    const target = goal.levels[name];
    return target !== undefined && stat(skills, name).baseLevel < target;
}

export function meleeGoalMet(goal: MeleeGoal, skills: readonly SkillState[]) {
    return !meleeTargetSkills.some(skill => belowTarget(goal, skills, skill));
}

export function meleeTrainingStyle(goal: MeleeGoal, skills: readonly SkillState[], combat: CombatStyleState | null | undefined) {
    const styles = combat?.styles.filter(style => style.trainsSkills.length > 0 &&
        style.trainsSkills.every(name => meleeSkills.some(skill => skill === name))) ?? [];
    const pending = meleeSkills.filter(skill => belowTarget(goal, skills, skill));
    // With only Hitpoints left, any melee style can keep earning Hitpoints XP.
    const candidates = pending.length ? pending : [...meleeSkills];
    const preferred: Partial<Record<MeleeGoal['style'], MeleeSkill>> = { Accurate: 'Attack', Aggressive: 'Strength', Defensive: 'Defence' };
    const priority = preferred[goal.style];
    candidates.sort((a, b) => Number(b === priority) - Number(a === priority) || stat(skills, a).experience - stat(skills, b).experience);
    if (goal.style === 'Controlled') {
        const shared = styles.find(style => style.type === 'Controlled' && candidates.some(name => style.trainsSkills.includes(name)));
        if (shared) return shared;
    }
    for (const name of candidates) {
        const style = styles.find(option => option.trainsSkills.length === 1 && option.trainsSkills[0] === name)
            ?? styles.find(option => option.trainsSkills.includes(name));
        if (style) return style;
    }
    throw new Error('Equipped weapon has no melee style for ' + candidates.join(', ') + '.');
}

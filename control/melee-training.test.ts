import { expect, test } from 'bun:test';
import type { ScriptContext } from '../sdk/runner';
import type { BotWorldState, CombatStyleState, SkillState } from '../sdk/types';
import { nextWork, parseSteps } from './dashboard-plan';
import { taskEnvironment } from './dashboard-worker-policy';
import { meleeTargetSkills, meleeTrainingStyle, parseMeleeGoal } from './melee-training';
import { trainCows } from './tasks/train-cows';

const goal = parseMeleeGoal({ type: 'melee-levels', levels: { Attack: 50, Strength: 50, Defence: 50, Hitpoints: 60 } });
const step = parseSteps([{ task: 'train-cows', finish: goal }])[0]!;
function skills(attack: number, strength: number, defence: number, hp: number): SkillState[] {
    const levels = [attack, strength, defence, hp];
    return meleeTargetSkills.map((name, i) => ({ name, baseLevel: levels[i]!, level: levels[i]!, experience: levels[i]! * 1000 }));
}
function combat(): CombatStyleState {
    return { currentStyle: 0, weaponName: 'Sword', known: true, tabInterfaceId: 0, styles: [
        { index: 0, name: 'Lunge', type: 'Controlled', trainsSkills: ['Attack', 'Strength', 'Defence'], damageType: 'Stab' },
        { index: 1, name: 'Chop', type: 'Accurate', trainsSkills: ['Attack'], damageType: 'Slash' },
        { index: 2, name: 'Slash', type: 'Aggressive', trainsSkills: ['Strength'], damageType: 'Slash' },
        { index: 3, name: 'Block', type: 'Defensive', trainsSkills: ['Defence'], damageType: 'Slash' },
    ] };
}
function world(values: SkillState[]) {
    return { inGame: true, skills: values, equipment: [], combatStyle: combat(),
        player: { worldX: 3254, worldZ: 3258, level: 0, hp: 40, maxHp: 60, combat: { inCombat: false } },
    } as unknown as BotWorldState;
}

test('melee goals round-trip in the plan and worker, with optional levels and strict validation', () => {
    expect(step.finish).toEqual(goal);
    expect(goal.style).toBe('Balanced');
    expect(JSON.parse(taskEnvironment(undefined, undefined, undefined, goal).RS_ACTIVITY_MELEE_GOAL!)).toEqual(goal);
    expect(taskEnvironment('Attack').RS_ACTIVITY_MELEE_GOAL).toBe('');
    const custom = { type: 'melee-levels', levels: { Hitpoints: 99, Attack: 1 }, style: 'Defensive' } as const;
    expect(parseMeleeGoal(custom)).toEqual(custom);
    expect(Object.keys(parseMeleeGoal(custom).levels)).toEqual(['Attack', 'Hitpoints']);
    for (const levels of [{}, { Prayer: 50 }, { Attack: 0 }, { Attack: 100 }, { Strength: 1.5 }, { Defence: '50' }, null]) {
        expect(() => parseSteps([{ task: 'train-cows', finish: { ...goal, levels } }])).toThrow();
    }
    expect(() => parseMeleeGoal({ ...goal, style: 'Rapid' })).toThrow('style preference');
    expect(() => parseSteps([{ task: 'train-hitpoints', finish: goal }])).toThrow('valid finish');
});

test('the planner requires every requested base level and can insert the existing HP prerequisite', () => {
    for (let i = 0; i < 4; i++) {
        const game = world(skills(50, 50, 50, 60));
        game.skills[i]!.baseLevel--;
        expect(nextWork(step, game)).toMatchObject({ task: 'train-cows', finish: goal });
    }
    const done = world(skills(52, 50, 50, 60));
    done.skills[3]!.level = done.player!.hp = 1;
    expect(nextWork(step, done)).toBeNull();
    expect(nextWork(step, world(skills(1, 1, 1, 10)))?.task).toBe('train-hitpoints');
    expect(() => nextWork(step, world(skills(50, 50, 50, 60).slice(0, 3)))).toThrow('Hitpoints');
});

test('style preferences follow unmet targets and the equipped weapon', () => {
    const weapon = combat();
    const values = skills(47, 48, 49, 59);
    const choose = (style: typeof goal.style) => meleeTrainingStyle({ ...goal, style }, values, weapon).type;
    expect(choose('Balanced')).toBe('Accurate');
    expect(choose('Aggressive')).toBe('Aggressive');
    expect(choose('Defensive')).toBe('Defensive');
    expect(choose('Controlled')).toBe('Controlled');
    values[2]!.baseLevel = 50;
    expect(choose('Defensive')).toBe('Accurate');
    weapon.styles.shift();
    expect(choose('Controlled')).toBe('Accurate');
    weapon.styles = [{ index: 0, name: 'Longrange', type: 'Longrange', trainsSkills: ['Ranged', 'Defence'], damageType: 'Ranged' }];
    expect(() => choose('Defensive')).toThrow('no melee style');
    const sharedOnly = combat();
    sharedOnly.styles.length = 1;
    expect(meleeTrainingStyle(goal, values, sharedOnly).type).toBe('Controlled');
    expect(meleeTrainingStyle({ ...goal, levels: { Hitpoints: 60 }, style: 'Defensive' }, values, combat()).type).toBe('Defensive');
});

test('the cow script switches stances, keeps fighting at 50/50/50, and stops at base 60 HP', async () => {
    const game = world(skills(49, 49, 49, 59));
    const stance = game.combatStyle!;
    const rounds: string[] = [];
    const ctx = {
        sdk: {
            waitForReady() {}, getState: () => game, getStateAge: () => 0, getInventory: () => [],
            getSkill: (name: string) => game.skills.find(skill => skill.name === name),
            sendSetCombatStyle(index: number) { stance.currentStyle = index; return { success: true }; },
            waitForCondition(check: (state: BotWorldState) => boolean) { expect(check(game)).toBe(true); },
            findNearbyNpc: () => ({ name: 'Cow', x: 3254, z: 3258 }), waitForTicks() {}, scanGroundItems: () => [],
        },
        bot: {
            attack() {
                const [trained] = stance.styles.find(option => option.index === stance.currentStyle)!.trainsSkills;
                rounds.push(trained!);
                if (rounds.length > 4) throw new Error('Extra attack after reaching the goal');
                const leveled = rounds.length === 4 ? 'Hitpoints' : trained;
                game.skills = game.skills.map(s => s.name === leveled ? { ...s, baseLevel: s.baseLevel + 1, experience: s.experience + 1000 } : s);
                return { success: true };
            },
        },
    } as unknown as ScriptContext;
    await trainCows(ctx, undefined, goal);
    expect(rounds).toEqual(['Attack', 'Strength', 'Defence', 'Attack']);
    game.player!.hp = 1;
    await trainCows(ctx, undefined, goal);
    expect(rounds).toHaveLength(4);
});

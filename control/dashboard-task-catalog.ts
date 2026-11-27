import { miningResources, miningSelection, type MiningTask } from './mining-routes';

export const trainingSkills = ['Hitpoints', 'Thieving', 'Attack', 'Strength', 'Defence', 'Runecraft', 'Mining'] as const;
export type TrainingSkill = typeof trainingSkills[number];
export type Requirement =
    | { type: 'level'; skill: TrainingSkill; level: number }
    | { type: 'quest'; task: string };

type Activity = {
    label: string;
    category: 'Quests' | 'Combat' | 'Thieving' | 'Runecraft' | 'Mining' | 'Setup' | 'Legacy';
    usage: 'once' | 'repeatable';
    script: string;
    requirements?: Requirement[];
    trains?: readonly TrainingSkill[];
    journal?: number;
};

const level = (skill: TrainingSkill, minimum: number): Requirement => ({ type: 'level', skill, level: minimum });

const miningTasks = Object.keys(miningResources).flatMap(resource =>
    (['bank', 'power'] as const).map(mode => `mine-${resource}-${mode}` as MiningTask));
const miningActivities = Object.fromEntries<Activity>(miningTasks.map(id => {
    const { resource, mode } = miningSelection(id);
    const name = miningResources[resource].label;
    return [id, {
        label: mode === 'bank' ? `Mine and bank ${name.toLowerCase()}` : `Powermine ${name.toLowerCase()}`,
        category: 'Mining', usage: 'repeatable', script: 'mine-resources.ts', trains: ['Mining'],
    } satisfies Activity];
})) as Record<MiningTask, Activity>;

export const activityCatalog = {
    'lost-city': {
        label: 'Lost City', category: 'Quests', usage: 'once', script: 'quests/lost-city.ts', journal: 7367,
    },
    'dragon-maze-recovery': {
        label: 'Check Melzar’s Maze for dropped items', category: 'Setup', usage: 'once',
        script: 'quests/dragon-maze-recovery.ts',
    },
    'dragon-slayer': {
        label: 'Dragon Slayer', category: 'Quests', usage: 'once', script: 'quests/dragon-slayer.ts', journal: 7383,
    },
    'sheep-shearer': {
        label: 'Sheep Shearer', category: 'Quests', usage: 'once', script: 'quests/sheep-shearer.ts', journal: 7344,
    },
    'romeo-and-juliet': {
        label: 'Romeo & Juliet', category: 'Quests', usage: 'once', script: 'quests/romeo-and-juliet.ts', journal: 7343,
    },
    'vampire-slayer': {
        label: 'Vampire Slayer', category: 'Quests', usage: 'once', script: 'quests/vampire-slayer.ts', journal: 7347,
    },
    'ernest-the-chicken': {
        label: 'Ernest the Chicken', category: 'Quests', usage: 'once', script: 'quests/ernest-the-chicken.ts', journal: 7339,
    },
    'goblin-diplomacy': {
        label: 'Goblin Diplomacy', category: 'Quests', usage: 'once', script: 'quests/goblin-diplomacy.ts', journal: 7338,
    },
    'druidic-ritual': {
        label: 'Druidic Ritual', category: 'Quests', usage: 'once', script: 'quests/druidic-ritual.ts', journal: 7355,
    },
    'witchs-house': {
        label: 'Witch’s House', category: 'Quests', usage: 'once', script: 'quests/witchs-house.ts', journal: 7351,
    },
    'black-knights-fortress': {
        label: 'Black Knight’s Fortress', category: 'Quests', usage: 'once', script: 'quests/black-knights-fortress.ts', journal: 7332,
    },
    'dorics-quest': {
        label: 'Doric’s Quest', category: 'Quests', usage: 'once', script: 'quests/dorics-quest.ts', journal: 7336,
    },
    'cooks-assistant': {
        label: 'Cook’s Assistant', category: 'Quests', usage: 'once', script: 'quests/cooks-assistant.ts', journal: 7333,
    },
    'restless-ghost': {
        label: 'The Restless Ghost', category: 'Quests', usage: 'once', script: 'quests/restless-ghost.ts', journal: 7337,
    },
    'train-hitpoints': {
        label: 'Train Hitpoints', category: 'Combat', usage: 'repeatable', script: 'train-hitpoints.ts', trains: ['Hitpoints'],
    },
    'train-cows': {
        label: 'Train melee on cows', category: 'Combat', usage: 'repeatable', script: 'train-cows.ts',
        requirements: [level('Hitpoints', 15)], trains: ['Attack', 'Strength', 'Defence'],
    },
    'pickpocket-men': {
        label: 'Pickpocket Men', category: 'Thieving', usage: 'repeatable', script: 'pickpocket.ts', trains: ['Thieving'],
    },
    'pickpocket-guards': {
        label: 'Pickpocket Guards', category: 'Thieving', usage: 'repeatable', script: 'pickpocket.ts',
        requirements: [level('Thieving', 40)], trains: ['Thieving'],
    },
    'pickpocket-knights': {
        label: 'Pickpocket Ardougne Knights', category: 'Thieving', usage: 'repeatable', script: 'pickpocket.ts',
        requirements: [level('Thieving', 55)], trains: ['Thieving'],
    },
    'pickpocket-paladins': {
        label: 'Pickpocket Paladins', category: 'Thieving', usage: 'repeatable', script: 'pickpocket.ts',
        requirements: [level('Thieving', 70)], trains: ['Thieving'],
    },
    'pickpocket-heroes': {
        label: 'Pickpocket Heroes', category: 'Thieving', usage: 'repeatable', script: 'pickpocket.ts',
        requirements: [level('Thieving', 80), level('Hitpoints', 80)], trains: ['Thieving'],
    },
    'craft-body-runes': {
        label: 'Craft Body runes', category: 'Runecraft', usage: 'repeatable', script: 'craft-body-runes.ts', trains: ['Runecraft'],
    },
    ...miningActivities,
    'skip-tutorial': { label: 'Skip Tutorial Island', category: 'Setup', usage: 'once', script: 'skip-tutorial.ts' },
    'train-hp-pickpocket': {
        label: 'Train Hitpoints, then pickpocket', category: 'Legacy', usage: 'repeatable', script: 'train-hp-pickpocket.ts',
    },
} satisfies Record<string, Activity>;

export type ActivityId = keyof typeof activityCatalog;
export const isActivity = (id: unknown): id is ActivityId => typeof id === 'string' && Object.hasOwn(activityCatalog, id);
export const activity = (id: ActivityId): Activity => activityCatalog[id];
export const activityIds = Object.keys(activityCatalog) as ActivityId[];

export const planCatalog = activityIds.flatMap(id => {
    const { script, ...meta } = activity(id);
    return meta.category === 'Legacy' || meta.category === 'Setup' ? [] : [{ id, ...meta }];
});

export function onTutorial(x: number, z: number) {
    return (x >= 3053 && x <= 3156 && z >= 3056 && z <= 3136) ||
        (x >= 3072 && x <= 3118 && z >= 9492 && z <= 9535);
}

export function inTutorialDestination(x: number, z: number, plane: number) {
    return plane === 0 && x >= 3200 && x <= 3255 && z >= 3190 && z <= 3250;
}

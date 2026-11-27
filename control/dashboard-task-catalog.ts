export const trainingSkills = ['Hitpoints', 'Thieving', 'Attack', 'Strength', 'Defence'] as const;
export type TrainingSkill = typeof trainingSkills[number];
export type Requirement =
    | { type: 'level'; skill: TrainingSkill; level: number }
    | { type: 'quest'; task: string };

type Activity = {
    label: string;
    category: 'Quests' | 'Combat' | 'Thieving' | 'Setup' | 'Legacy';
    usage: 'once' | 'repeatable';
    script: string;
    requirements?: Requirement[];
    trains?: readonly TrainingSkill[];
    journal?: number;
};

const level = (skill: TrainingSkill, minimum: number): Requirement => ({ type: 'level', skill, level: minimum });

export const activityCatalog = {
    'romeo-and-juliet': {
        label: 'Romeo & Juliet', category: 'Quests', usage: 'once', script: 'quests/romeo-and-juliet.ts', journal: 7343,
    },
    'vampire-slayer': {
        label: 'Vampire Slayer', category: 'Quests', usage: 'once', script: 'quests/vampire-slayer.ts', journal: 7347,
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
    'pickpocket-heroes': {
        label: 'Pickpocket Heroes', category: 'Thieving', usage: 'repeatable', script: 'pickpocket.ts',
        requirements: [level('Thieving', 80), level('Hitpoints', 80)], trains: ['Thieving'],
    },
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

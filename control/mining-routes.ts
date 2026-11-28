import { bankLocations as miningBanks, place, type NamedTile, type Tile } from './bank-locations';

export { miningBanks, type Tile };

export const miningResources = {
    clay: { label: 'Clay', level: 1, items: [434], rocks: [2108, 2109, 2137, 2138, 4994, 4995, 4996], respawn: 4 },
    copper: { label: 'Copper', level: 1, items: [436], rocks: [2090, 2091, 2119, 2120, 4976, 4977, 4978], respawn: 6 },
    tin: { label: 'Tin', level: 1, items: [438], rocks: [2094, 2095, 2123, 2124, 4979, 4980, 4981], respawn: 6 },
    iron: { label: 'Iron', level: 15, items: [440], rocks: [2092, 2093, 2121, 2122, 4982, 4983, 4984], respawn: 12 },
    silver: { label: 'Silver', level: 20, items: [442], rocks: [2100, 2101, 2129, 2130], respawn: 120 },
    coal: { label: 'Coal', level: 30, items: [453], rocks: [2096, 2097, 2125, 2126, 4676, 4985, 4986, 4987], respawn: 60 },
    gold: { label: 'Gold', level: 40, items: [444], rocks: [2098, 2099, 2127, 2128], respawn: 120 },
    mithril: { label: 'Mithril', level: 55, items: [447], rocks: [2102, 2103, 2131, 2132, 4988, 4989, 4990], respawn: 240 },
    adamantite: { label: 'Adamantite', level: 70, items: [449], rocks: [2104, 2105, 2133, 2134, 4991, 4992, 4993], respawn: 480 },
    limestone: { label: 'Limestone', level: 10, items: [3211], rocks: [4027, 4028, 4029], respawn: 24 },
    gems: { label: 'Gems', level: 40, items: [1617, 1619, 1621, 1623, 1625, 1627, 1629], rocks: [2111, 2140], respawn: 120 },
    essence: { label: 'Rune essence', level: 1, items: [1436], rocks: [2491], respawn: 1 },
} as const;

export type MiningResource = keyof typeof miningResources;
export type MiningMode = 'power' | 'bank';
export type MiningTask = `mine-${MiningResource}-${MiningMode}`;
export type MiningSite = {
    mine: NamedTile;
    bank: NamedTile;
    rocks: Partial<Record<MiningResource, number>>;
    teleport?: string;
    guild?: true;
};

export const fishingGuildBank = place('Fishing Guild Bank', 2586, 3420);
export const coalTrucks: MiningSite = {
    mine: place('Coal Trucks', 2581, 3474), bank: miningBanks.seers, rocks: { coal: 18 },
};

export function miningSiteBanks(site: MiningSite, fishingLevel: number): [NamedTile, ...NamedTile[]] {
    return site === coalTrucks && fishingLevel >= 68 ? [fishingGuildBank, site.bank] : [site.bank];
}

// Rock counts and anchors come from the checked-in 289 map regions. Each
// route stays south of the Wilderness and uses a surface bank.
const sites: MiningSite[] = [
    { mine: place('Varrock southeast mine', 3286, 3366), bank: miningBanks.east, rocks: { copper: 9, tin: 6, iron: 4 } },
    { mine: place('Varrock southwest mine', 3178, 3371), bank: miningBanks.west, rocks: { clay: 3, tin: 8, iron: 3, silver: 3 } },
    { mine: place('Al Kharid mine', 3300, 3301), bank: miningBanks.kharid,
        rocks: { copper: 3, tin: 1, iron: 9, silver: 5, coal: 3, gold: 2, mithril: 2, adamantite: 2 } },
    { mine: place('Rimmington mine', 2978, 3239), bank: miningBanks.draynor, rocks: { clay: 2, copper: 5, tin: 2, iron: 6, gold: 2 } },
    { mine: place('Barbarian Village mine', 3088, 3429), bank: miningBanks.west, rocks: { coal: 4, tin: 5 } },
    { mine: place('Lumbridge southwest swamp mine', 3239, 3163), bank: miningBanks.draynor, rocks: { coal: 7, mithril: 5, adamantite: 2 } },
    coalTrucks,
    { mine: place('Monastery mine', 2600, 3229), bank: miningBanks.ardougne, rocks: { coal: 4, iron: 13 } },
    { mine: place('Fight Arena mine', 2634, 3146), bank: miningBanks.yanille,
        rocks: { copper: 4, tin: 9, clay: 4, iron: 9, mithril: 4 } },
    { mine: place('Falador west surface mine', 2907, 3359), bank: miningBanks.falador, rocks: { iron: 3, tin: 6, copper: 2, coal: 2 } },
    { mine: place('Mining Guild', 3041, 9736), bank: miningBanks.falador, rocks: { coal: 45, mithril: 7 }, guild: true },
    { mine: place('Brimhaven southeast mine', 2745, 3150), bank: miningBanks.shilo, rocks: { gold: 6 } },
    { mine: place('Brimhaven north mine', 2733, 3223), bank: miningBanks.shilo, rocks: { gold: 10 } },
    { mine: place('Varrock limestone quarry', 3373, 3499), bank: miningBanks.east, rocks: { limestone: 8 } },
    { mine: place('Shilo Village gem mine', 2823, 2999), bank: miningBanks.shilo, rocks: { gems: 7 } },
    { mine: place('Aubury’s rune shop', 3253, 3401), bank: miningBanks.east, rocks: { essence: 1 }, teleport: 'Aubury' },
    { mine: place('Wizard Cromperty’s house', 2684, 3322), bank: miningBanks.ardougne, rocks: { essence: 1 }, teleport: 'Wizard Cromperty' },
];

export const miningDistance = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
export const miningTravelTimeout = (distance: number) => Math.min(480_000, Math.max(35_000, 25_000 + distance * 950));

export const alKharidTollGate = place('Al Kharid toll gate', 3268, 3227);
const alKharidWestApproach = place('the west approach to the Al Kharid bypass', 3250, 3311);
const alKharidEastApproach = place('the east approach to the Al Kharid bypass', 3275, 3306);

export function miningTravelWaypoints(from: Tile, to: Tile): readonly NamedTile[] {
    const [west, east] = from.x < to.x ? [from, to] : [to, from];
    if (west.x < alKharidTollGate.x && west.z < 3300 &&
        east.x >= alKharidTollGate.x && east.x <= 3335 && east.z >= 3130 && east.z < alKharidEastApproach.z) {
        // A single waypoint across the border can still route through the toll gate.
        return from === west ? [alKharidWestApproach, alKharidEastApproach] : [alKharidEastApproach, alKharidWestApproach];
    }
    return [];
}

export function miningPathDistance(from: Tile, points: readonly Tile[]) {
    let distance = 0;
    let previous = from;
    for (const point of points) {
        distance += miningDistance(previous, point);
        previous = point;
    }
    return distance;
}

export function miningTravelDistance(from: Tile, to: Tile) {
    return miningPathDistance(from, [...miningTravelWaypoints(from, to), to]);
}

export const guildLadder = place('Mining Guild ladders', 3019, 3339);
export function inMiningGuild(p: Tile) {
    return p.x >= 3010 && p.x <= 3060 && p.z >= 9722 && p.z <= 9755;
}

export function rankMiningSites(resource: MiningResource, mode: MiningMode, from: Tile, level: number, fishingLevel = 0) {
    const respawn = miningResources[resource].respawn;
    const score = (site: MiningSite) => {
        const stock = site.rocks[resource]!;
        const start = site.guild ? guildLadder : site.mine;
        const origin = inMiningGuild(from) ? guildLadder : from;
        const ladder = site.guild ? 25 : 0;
        const bank = miningSiteBanks(site, fishingLevel)[0];
        const banking = mode === 'bank' ? 2 * (miningTravelDistance(start, bank) + ladder) / 27 : 0;
        return Math.max(0, respawn / stock - 2) + banking + (miningTravelDistance(origin, start) + ladder) / 55;
    };
    return sites.filter(site => site.rocks[resource] && (!site.guild || level >= 60)).sort((a, b) => score(a) - score(b));
}

export function miningSelection(task: string): { resource: MiningResource; mode: MiningMode } {
    const match = /^mine-([a-z]+)-(power|bank)$/.exec(task);
    if (!match || !Object.hasOwn(miningResources, match[1]!)) {
        throw new Error('Choose a supported Mining resource and mode.');
    }
    return { resource: match[1] as MiningResource, mode: match[2] as MiningMode };
}

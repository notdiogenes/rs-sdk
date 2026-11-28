export type Tile = { x: number; z: number };
export type NamedTile = Tile & { name: string };

export const place = (name: string, x: number, z: number): NamedTile => ({ name, x, z });
export const bankLocations = {
    west: place('Varrock West Bank', 3185, 3436),
    east: place('Varrock East Bank', 3253, 3420),
    kharid: place('Al Kharid Bank', 3269, 3167),
    draynor: place('Draynor Bank', 3092, 3243),
    falador: place('Falador East Bank', 3012, 3355),
    seers: place('Seers’ Village Bank', 2725, 3493),
    yanille: place('Yanille Bank', 2612, 3093),
    ardougne: place('Ardougne North Bank', 2615, 3332),
    shilo: place('Shilo Village Bank', 2852, 2954),
};

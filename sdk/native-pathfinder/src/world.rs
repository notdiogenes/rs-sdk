use rsmod::rsmod::collision_flag::CollisionFlag;
use rsmod::rsmod::CollisionType;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

type Key = (i32, i32, i32);
const WALK_BLOCKED: u32 = CollisionFlag::WALK_BLOCKED as u32;
const ONE_WAY: [Key; 5] = [
    (0, 3108, 3353),
    (0, 3109, 3353),
    (0, 2924, 9654),
    (0, 2927, 9649),
    (0, 2931, 9640),
];

#[derive(Clone, Copy)]
struct Door {
    level: i32,
    x: i32,
    z: i32,
    shape: i8,
    angle: u8,
    blockrange: bool,
}
impl Door {
    fn key(&self) -> Key {
        (self.level, self.x, self.z)
    }
    fn json(&self) -> Value {
        json!({"level":self.level,"x":self.x,"z":self.z,"shape":self.shape,
            "angle":self.angle,"blockrange":self.blockrange})
    }
    fn collision(&self, add: bool) {
        // All access to the upstream collision and solver globals is single-threaded.
        unsafe {
            if self.shape == 9 {
                let (dx, dz) = [(0, 1), (1, 0), (0, -1), (-1, 0)][usize::from(self.angle & 3)];
                rsmod::changeLoc(
                    self.x,
                    self.z,
                    self.level,
                    1,
                    1,
                    self.blockrange,
                    false,
                    add,
                );
                rsmod::changeLoc(
                    self.x + dx,
                    self.z + dz,
                    self.level,
                    1,
                    1,
                    self.blockrange,
                    false,
                    !add,
                );
            } else {
                rsmod::changeWall(
                    self.x,
                    self.z,
                    self.level,
                    self.angle,
                    self.shape,
                    self.blockrange,
                    false,
                    add,
                );
            }
        }
    }
}

#[derive(Deserialize)]
struct MapData {
    zones: Vec<(i32, i32, i32)>,
    tiles: Vec<(i32, i32, i32, i64)>,
    #[serde(default)]
    doors: Vec<(i32, i32, i32, i8, u8, i32)>,
}

pub(super) struct World {
    doors: HashMap<Key, Door>,
    // The upstream solver owns process-global mutable state. Construct and
    // access this object only on the single solver thread.
    _thread_bound: std::marker::PhantomData<std::rc::Rc<()>>,
}

impl World {
    pub(super) fn open(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let data: MapData = serde_json::from_reader(BufReader::new(File::open(path)?))?;
        for (level, x, z) in data.zones {
            unsafe {
                rsmod::allocateIfAbsent(x, z, level);
            }
        }
        for x in (2304..=3392).step_by(8) {
            for z in (2944..=3584).step_by(8) {
                unsafe {
                    if !rsmod::isZoneAllocated(x, z, 0) {
                        rsmod::allocateIfAbsent(x, z, 0);
                    }
                }
            }
        }
        for (level, x, z, flags) in data.tiles {
            unsafe {
                rsmod::__set(x, z, level, flags as u32);
            }
        }
        let mut doors = HashMap::new();
        for (level, x, z, shape, angle, blockrange) in data.doors {
            if ONE_WAY.contains(&(level, x, z)) {
                continue;
            }
            let door = Door {
                level,
                x,
                z,
                shape,
                angle,
                blockrange: blockrange != 0,
            };
            door.collision(false);
            doors.insert(door.key(), door);
        }
        Ok(Self {
            doors,
            _thread_bound: std::marker::PhantomData,
        })
    }

    fn route(&self, query: &Value) -> Option<Value> {
        let level = number(query, "level", 3)? as i32;
        let sx = number(query, "srcX", 16383)? as i32;
        let sz = number(query, "srcZ", 16383)? as i32;
        let dx = number(query, "destX", 16383)? as i32;
        let dz = number(query, "destZ", 16383)? as i32;
        // The existing Wasm wrapper converts the SDK-clamped value to the solver's u16.
        let maximum = number(query, "maxWaypoints", u32::MAX)?.min(2048 * 2048) as u16;
        let mut active = Vec::new();
        let mut included = HashSet::new();
        if let Some(list) = query.get("blockedDoors") {
            for tile in list.as_array()? {
                let key = tile_key(tile)?;
                if let Some(d) = self.doors.get(&key) {
                    if included.insert(key) {
                        active.push(*d);
                    }
                }
            }
        }
        let source_allocated = unsafe { rsmod::isZoneAllocated(sx, sz, level) };
        let destination_allocated = unsafe { rsmod::isZoneAllocated(dx, dz, level) };
        let walkable = unsafe { !rsmod::isFlagged(dx, dz, level, WALK_BLOCKED) };
        let mut changed = DoorScope(Vec::with_capacity(active.len()));
        for d in active {
            d.collision(true);
            changed.0.push(d);
        }
        let packed = unsafe {
            rsmod::findLongPath(
                level,
                sx,
                sz,
                dx,
                dz,
                1,
                1,
                1,
                0,
                -1,
                true,
                0,
                maximum,
                CollisionType::NORMAL,
            )
        };
        drop(changed);
        let mut points = Vec::with_capacity(packed.len());
        let mut doors = Vec::new();
        let mut seen = HashSet::new();
        for p in packed {
            let x = ((p >> 14) & 0x3fff) as i32;
            let z = (p & 0x3fff) as i32;
            let level = ((p >> 28) & 3) as i32;
            points.push(json!({"x":x,"z":z,"level":level}));
            for k in [
                (level, x, z),
                (level, x, z + 1),
                (level, x, z - 1),
                (level, x + 1, z),
                (level, x - 1, z),
            ] {
                if let Some(d) = self.doors.get(&k) {
                    if seen.insert(k) {
                        doors.push(d.json());
                    }
                }
            }
        }
        Some(
            json!({"doors":doors,"waypoints":points,"sourceAllocated":source_allocated,"destinationAllocated":destination_allocated,"destinationWalkable":walkable}),
        )
    }

    pub(super) fn execute(&self, query: &Value) -> Option<Value> {
        match query.get("type")?.as_str()? {
            "route" => self.route(query),
            "tile" => {
                let (level, x, z) = tile_key(query)?;
                Some(json!({"walkable":unsafe{!rsmod::isFlagged(x,z,level,WALK_BLOCKED)}}))
            }
            "door" => {
                let k = tile_key(query)?;
                Some(json!({"door":self.doors.get(&k).map(Door::json)}))
            }
            _ => None,
        }
    }
}

struct DoorScope(Vec<Door>);
impl Drop for DoorScope {
    fn drop(&mut self) {
        for d in &self.0 {
            d.collision(false);
        }
    }
}

fn number(value: &Value, name: &str, max: u32) -> Option<u32> {
    let n = value.get(name)?.as_f64()?;
    if n >= 0. && n <= max as f64 && n.trunc() == n {
        Some(n as u32)
    } else {
        None
    }
}
fn tile_key(v: &Value) -> Option<Key> {
    Some((
        number(v, "level", 3)? as i32,
        number(v, "x", 16383)? as i32,
        number(v, "z", 16383)? as i32,
    ))
}

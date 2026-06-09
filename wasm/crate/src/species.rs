use super::utils::*;
use Cell;
use SandApi;
use Wind;
use EMPTY_CELL;
use {FLAG_SOURCES, FLAG_PLANT_ABSORBS};

// use std::cmp;
use std::mem;
use wasm_bindgen::prelude::*;
// use web_sys::console;

#[wasm_bindgen]
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Species {
    Empty = 0,
    Wall = 1,
    Sand = 2,
    Water = 3,
    // X = 21,
    Stone = 13,
    Ice = 9,
    Gas = 4,
    Cloner = 5,
    // Sink = 10,
    Mite = 15,
    Wood = 7,
    Plant = 11,
    Fungus = 18,
    Seed = 19,
    Fire = 6,
    Lava = 8,
    Acid = 12,
    Dust = 14,
    Oil = 16,
    Rocket = 17,
    Spout = 20,
    SandSource = 21,
    Torch = 22,
    OilWell = 23,
    GasSource = 24,
    AcidSource = 25,
    BlackHole = 26,
    // ── Electricity & automation ─────────────────────────────────────────
    Wire = 27,    // static conductor; rb = refractory countdown (0 = resting)
    Spark = 28,   // travelling current; lives one tick then decays to refractory wire
    Battery = 29, // source-gated pulse emitter (FLAG_SOURCES)
    Switch = 30,  // insulating, toggleable break in a wire run (open by default)
}

// Electricity tuning constants. See the Electricity & Automation spec.
// REFRACTORY_TICKS must be >= 2: in this single-buffer push model the
// sparks a cell emits at tick T fire at T+1, so the cell it discharged
// from must still be refractory at T+1 to prevent the pulse flowing back.
const REFRACTORY_TICKS: u8 = 2;
// Generations between battery pulses. `generation` advances by 2 per tick
// and is odd during the update pass, so `g % BATTERY_PERIOD == 1` fires
// once every BATTERY_PERIOD/2 ticks (here: every 6 ticks).
const BATTERY_PERIOD: u8 = 12;

impl Species {
    pub fn update(&self, cell: Cell, api: SandApi) {
        match self {
            Species::Empty => {}
            Species::Wall => {}
            Species::Sand => update_sand(cell, api),
            Species::Dust => update_dust(cell, api),
            Species::Water => update_water(cell, api),
            Species::Stone => update_stone(cell, api),
            Species::Gas => update_gas(cell, api),
            Species::Cloner => update_cloner(cell, api),
            Species::Rocket => update_rocket(cell, api),
            Species::Fire => update_fire(cell, api),
            Species::Wood => update_wood(cell, api),
            Species::Lava => update_lava(cell, api),
            Species::Ice => update_ice(cell, api),
            Species::Plant => update_plant(cell, api),
            Species::Acid => update_acid(cell, api),
            Species::Mite => update_mite(cell, api),
            Species::Oil => update_oil(cell, api),
            Species::Fungus => update_fungus(cell, api),
            Species::Seed => update_seed(cell, api),
            Species::Spout => update_spout(cell, api),
            Species::SandSource => update_sand_source(cell, api),
            Species::Torch => update_torch(cell, api),
            Species::OilWell => update_oil_well(cell, api),
            Species::GasSource => update_gas_source(cell, api),
            Species::AcidSource => update_acid_source(cell, api),
            Species::BlackHole => update_black_hole(cell, api),
            Species::Wire => update_wire(cell, api),
            Species::Spark => update_spark(cell, api),
            Species::Battery => update_battery(cell, api),
            Species::Switch => update_switch(cell, api),
        }
    }
}

pub fn update_sand(cell: Cell, mut api: SandApi) {
    let dx = api.rand_dir_2();

    let nbr = api.get(0, 1);
    if nbr.species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(0, 1, cell);
    } else if api.get(dx, 1).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(dx, 1, cell);
    } else if nbr.species == Species::Water
        || nbr.species == Species::Gas
        || nbr.species == Species::Oil
        || nbr.species == Species::Acid
    {
        api.set(0, 0, nbr);
        api.set(0, 1, cell);
    } else {
        api.set(0, 0, cell);
    }
}

pub fn update_dust(cell: Cell, mut api: SandApi) {
    let dx = api.rand_dir();
    let fluid = api.get_fluid();

    if fluid.pressure > 120 {
        api.set(
            0,
            0,
            Cell {
                species: Species::Fire,
                ra: (150 + (cell.ra / 10)) as u8,
                rb: 0,
                clock: 0,
            },
        );
        api.set_fluid(Wind {
            dx: 0,
            dy: 0,
            pressure: 80,
            density: 5,
        });
        return;
    }

    let nbr = api.get(0, 1);
    if nbr.species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(0, 1, cell);
    } else if nbr.species == Species::Water {
        api.set(0, 0, nbr);
        api.set(0, 1, cell);
    } else if api.get(dx, 1).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(dx, 1, cell);
    } else {
        api.set(0, 0, cell);
    }
}

pub fn update_stone(cell: Cell, mut api: SandApi) {
    if api.get(-1, -1).species == Species::Stone && api.get(1, -1).species == Species::Stone {
        return;
    }
    let fluid = api.get_fluid();

    if fluid.pressure > 120 && api.rand_int(1) == 0 {
        api.set(
            0,
            0,
            Cell {
                species: Species::Sand,
                ra: cell.ra,
                rb: 0,
                clock: 0,
            },
        );
        return;
    }

    let nbr = api.get(0, 1);
    let nbr_species = nbr.species;
    if nbr_species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(0, 1, cell);
    } else if nbr_species == Species::Water
        || nbr_species == Species::Gas
        || nbr_species == Species::Oil
        || nbr_species == Species::Acid
    {
        api.set(0, 0, nbr);
        api.set(0, 1, cell);
    } else {
        api.set(0, 0, cell);
    }
}

pub fn update_water(cell: Cell, mut api: SandApi) {
    let mut dx = api.rand_dir();
    let below = api.get(0, 1);
    let dx1 = api.get(dx, 1);
    // let mut dx0 = api.get(dx, 0);
    //fall down
    if below.species == Species::Empty || below.species == Species::Oil {
        api.set(0, 0, below);
        let mut ra = cell.ra;
        if api.once_in(20) {
            //randomize direction when falling sometimes
            ra = 100 + api.rand_int(50) as u8;
        }
        api.set(0, 1, Cell { ra, ..cell });

        return;
    } else if dx1.species == Species::Empty || dx1.species == Species::Oil {
        //fall diagonally
        api.set(0, 0, dx1);
        api.set(dx, 1, cell);
        return;
    } else if api.get(-dx, 1).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(-dx, 1, cell);
        return;
    }
    let left = cell.ra % 2 == 0;
    dx = if left { 1 } else { -1 };
    let dx0 = api.get(dx, 0);
    let dxd = api.get(dx * 2, 0);

    if dx0.species == Species::Empty && dxd.species == Species::Empty {
        // scoot double
        api.set(0, 0, dxd);
        api.set(2 * dx, 0, Cell { rb: 6, ..cell });
        let (dx, dy) = api.rand_vec_8();
        let nbr = api.get(dx, dy);

        // spread opinion
        if nbr.species == Species::Water {
            if nbr.ra % 2 != cell.ra % 2 {
                api.set(
                    dx,
                    dy,
                    Cell {
                        ra: cell.ra,
                        ..cell
                    },
                )
            }
        }
    } else if dx0.species == Species::Empty || dx0.species == Species::Oil {
        api.set(0, 0, dx0);
        api.set(dx, 0, Cell { rb: 3, ..cell });
        let (dx, dy) = api.rand_vec_8();
        let nbr = api.get(dx, dy);
        if nbr.species == Species::Water {
            if nbr.ra % 2 != cell.ra % 2 {
                api.set(
                    dx,
                    dy,
                    Cell {
                        ra: cell.ra,
                        ..cell
                    },
                )
            }
        }
    } else if cell.rb == 0 {
        if api.get(-dx, 0).species == Species::Empty {
            // bump
            api.set(
                0,
                0,
                Cell {
                    ra: ((cell.ra as i32) + dx) as u8,
                    ..cell
                },
            );
        }
    } else {
        // become less certain (more bumpable)
        api.set(
            0,
            0,
            Cell {
                rb: cell.rb - 1,
                ..cell
            },
        );
    }
    // if api.once_in(8) {
    //     let (dx, dy) = api.rand_vec_8();
    //     let nbr = api.get(dx, dy);
    //     if nbr.species == Species::Water {
    //         if nbr.ra % 2 != cell.ra % 2 {
    //             api.set(0, 0, Cell { ra: nbr.ra, ..cell })
    //         }
    //     }
    // }

    // let (dx, dy) = api.rand_vec_8();
    // let nbr = api.get(dx, dy);
    // if nbr.species == Species::Water {
    //     if nbr.ra % 2 != cell.ra % 2 && api.once_in(2) {
    //         api.set(0, 0, Cell { ra: nbr.ra, ..cell })
    //     }
    // }

    // {

    // if api.get(-dx, 0).species == Species::Empty {
    //     api.set(0, 0, EMPTY_CELL);
    //     api.set(-dx, 0, cell);
    // }
}

pub fn update_oil(cell: Cell, mut api: SandApi) {
    let rb = cell.rb;
    let (dx, dy) = api.rand_vec();

    let mut new_cell = cell;
    let nbr = api.get(dx, dy);
    if rb == 0 && nbr.species == Species::Fire
        || nbr.species == Species::Lava
        || (nbr.species == Species::Oil && nbr.rb > 1 && nbr.rb < 20)
    {
        new_cell = Cell {
            species: Species::Oil,
            ra: cell.ra,
            rb: 50,
            clock: 0,
        };
    }

    if rb > 1 {
        new_cell = Cell {
            species: Species::Oil,
            ra: cell.ra,
            rb: rb - 1,
            clock: 0,
        };
        api.set_fluid(Wind {
            dx: 0,
            dy: 10,
            pressure: 10,
            density: 180,
        });
        if rb % 4 != 0 && nbr.species == Species::Empty && nbr.species != Species::Water {
            let ra = 20 + api.rand_int(30) as u8;
            api.set(
                dx,
                dy,
                Cell {
                    species: Species::Fire,
                    ra,
                    rb: 0,
                    clock: 0,
                },
            );
        }
        if nbr.species == Species::Water {
            new_cell = Cell {
                species: Species::Oil,
                ra: 50,
                rb: 0,
                clock: 0,
            };
        }
    } else if rb == 1 {
        api.set(
            0,
            0,
            Cell {
                species: Species::Empty,
                ra: cell.ra,
                rb: 90,
                clock: 0,
            },
        );
        return;
    }

    if api.get(0, 1).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(0, 1, new_cell);
    } else if api.get(dx, 1).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(dx, 1, new_cell);
    } else if api.get(-dx, 1).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(-dx, 1, new_cell);
    } else if api.get(dx, 0).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(dx, 0, new_cell);
    } else if api.get(-dx, 0).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(-dx, 0, new_cell);
    } else {
        api.set(0, 0, new_cell);
    }
}

pub fn update_gas(cell: Cell, mut api: SandApi) {
    let (dx, dy) = api.rand_vec();

    let nbr = api.get(dx, dy);
    // api.set_fluid(Wind {
    //     dx: 0,
    //     dy: 0,
    //     pressure: 5,
    //     density: 0,
    // });
    if cell.rb == 0 {
        api.set(0, 0, Cell { rb: 5, ..cell });
    }

    if nbr.species == Species::Empty {
        if cell.rb < 3 {
            //single molecule
            api.set(0, 0, EMPTY_CELL);
            api.set(dx, dy, cell);
        } else {
            api.set(0, 0, Cell { rb: 1, ..cell });
            api.set(
                dx,
                dy,
                Cell {
                    rb: cell.rb - 1,
                    ..cell
                },
            );
        }
    } else if (dx != 0 || dy != 0) && nbr.species == Species::Gas && nbr.rb < 4 {
        // if (cell.rb < 2) {
        api.set(0, 0, EMPTY_CELL);
        // }
        api.set(
            dx,
            dy,
            Cell {
                rb: nbr.rb + cell.rb,
                ..cell
            },
        );
    }
}
// pub fn update_x(cell: Cell, mut api: SandApi) {
//     let (dx, dy) = api.rand_vec_8();

//     let nbr = api.get(dx, dy);

//     if nbr.species == Species::X {
//         let opposite = api.get(-dx, -dy);
//         if opposite.species == Species::Empty {
//             api.set(0, 0, EMPTY_CELL);
//             api.set(-dx, -dy, cell);
//         }
//     }
// }

pub fn update_cloner(cell: Cell, mut api: SandApi) {
    let mut clone_species = unsafe { mem::transmute(cell.rb as u8) };
    let g = api.universe.generation;
    for dx in [-1, 0, 1].iter().cloned() {
        for dy in [-1, 0, 1].iter().cloned() {
            if cell.rb == 0 {
                let nbr_species = api.get(dx, dy).species;
                if nbr_species != Species::Empty
                    && nbr_species != Species::Cloner
                    && nbr_species != Species::Wall
                {
                    clone_species = nbr_species;
                    api.set(
                        0,
                        0,
                        Cell {
                            species: cell.species,
                            ra: 200,
                            rb: clone_species as u8,
                            clock: 0,
                        },
                    );

                    break;
                }
            } else {
                if api.rand_int(100) > 90 && api.get(dx, dy).species == Species::Empty {
                    let ra = 80 + api.rand_int(30) as u8 + ((g % 127) as i8 - 60).abs() as u8;
                    api.set(
                        dx,
                        dy,
                        Cell {
                            species: clone_species,
                            ra,
                            rb: 0,
                            clock: 0,
                        },
                    );
                    break;
                }
            }
        }
    }
}

pub fn update_rocket(cell: Cell, mut api: SandApi) {
    // rocket has complicated behavior that is staged piecewise in ra.
    // it would be awesome to diagram the ranges of values and their meaning

    if cell.rb == 0 {
        //initialize
        api.set(
            0,
            0,
            Cell {
                ra: 0,
                rb: 100,
                ..cell
            },
        );
        return;
    }

    let clone_species = if cell.rb != 100 {
        unsafe { mem::transmute(cell.rb as u8) }
    } else {
        Species::Sand
    };

    let (sx, sy) = api.rand_vec();
    let sample = api.get(sx, sy);

    if cell.rb == 100 //the type is unset
        && sample.species != Species::Empty
        && sample.species != Species::Rocket
        && sample.species != Species::Wall
        && sample.species != Species::Cloner
    {
        api.set(
            0,
            0,
            Cell {
                ra: 1,
                rb: sample.species as u8, //store the type
                ..cell
            },
        );
        return;
    }

    let ra = cell.ra;

    if ra == 0 {
        //falling (dormant)
        let dx = api.rand_dir();
        let nbr = api.get(0, 1);
        if nbr.species == Species::Empty {
            api.set(0, 0, EMPTY_CELL);
            api.set(0, 1, cell);
        } else if api.get(dx, 1).species == Species::Empty {
            api.set(0, 0, EMPTY_CELL);
            api.set(dx, 1, cell);
        } else if nbr.species == Species::Water
            || nbr.species == Species::Gas
            || nbr.species == Species::Oil
            || nbr.species == Species::Acid
        {
            api.set(0, 0, nbr);
            api.set(0, 1, cell);
        } else {
            api.set(0, 0, cell);
        }
    } else if ra == 1 {
        //launch
        api.set(0, 0, Cell { ra: 2, ..cell });
    } else if ra == 2 {
        let (mut dx, mut dy) = api.rand_vec_8();
        let nbr = api.get(dx, dy);
        if nbr.species != Species::Empty {
            dx *= -1;
            dy *= -1;
        }
        api.set(
            0,
            0,
            Cell {
                ra: 100 + join_dy_dx(dx, dy),
                ..cell
            },
        );
    } else if ra > 50 {
        let (dx, dy) = split_dy_dx(cell.ra - 100);

        let nbr = api.get(dx, dy * 2);

        if nbr.species == Species::Empty
            || nbr.species == Species::Fire
            || nbr.species == Species::Rocket
        {
            api.set(0, 0, Cell::new(clone_species));
            api.set(0, dy, Cell::new(clone_species));

            let (ndx, ndy) = match api.rand_int(100) % 5 {
                0 => adjacency_left((dx, dy)),
                1 => adjacency_right((dx, dy)),
                // 2 => adjacency_right((dx, dy)),
                _ => (dx, dy),
            };
            api.set(
                dx,
                dy * 2,
                Cell {
                    ra: 100 + join_dy_dx(ndx, ndy),
                    ..cell
                },
            );
        } else {
            //fizzle
            api.set(0, 0, EMPTY_CELL);
        }
    }
}

pub fn update_fire(cell: Cell, mut api: SandApi) {
    let ra = cell.ra;
    let mut degraded = cell.clone();
    degraded.ra = ra - (2 + api.rand_dir()) as u8;

    let (dx, dy) = api.rand_vec();

    api.set_fluid(Wind {
        dx: 0,
        dy: 150,
        pressure: 1,
        density: 120,
    });
    if api.get(dx, dy).species == Species::Gas || api.get(dx, dy).species == Species::Dust {
        api.set(
            dx,
            dy,
            Cell {
                species: Species::Fire,
                ra: (150 + (dx + dy) * 10) as u8,
                rb: 0,
                clock: 0,
            },
        );
        api.set_fluid(Wind {
            dx: 0,
            dy: 0,
            pressure: 80,
            density: 40,
        });
    }
    if api.get(dx, dy).species == Species::Plant && api.once_in(3) {
        let fire_ra = 80 + api.rand_int(40) as u8;
        api.set(
            dx,
            dy,
            Cell {
                species: Species::Fire,
                ra: fire_ra,
                rb: 0,
                clock: 0,
            },
        );
    }
    // Mirror the plant case: fire actively ignites adjacent fungus on a
    // 1-in-3 sample. Fungus stays Fungus (so its own update keeps running
    // through the burn-down) but rb is set to the burn timer.
    if api.get(dx, dy).species == Species::Fungus && api.once_in(3) {
        let nbr = api.get(dx, dy);
        if nbr.rb == 0 {
            api.set(
                dx,
                dy,
                Cell {
                    species: Species::Fungus,
                    ra: nbr.ra,
                    rb: 4,
                    clock: 0,
                },
            );
        }
    }
    if ra < 5 || api.get(dx, dy).species == Species::Water {
        api.set(0, 0, EMPTY_CELL);
    } else if api.get(dx, dy).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(dx, dy, degraded);
    } else {
        api.set(0, 0, degraded);
    }
}

pub fn update_lava(cell: Cell, mut api: SandApi) {
    api.set_fluid(Wind {
        dx: 0,
        dy: 10,
        pressure: 0,
        density: 60,
    });
    let (dx, dy) = api.rand_vec();

    if api.get(dx, dy).species == Species::Gas || api.get(dx, dy).species == Species::Dust {
        api.set(
            dx,
            dy,
            Cell {
                species: Species::Fire,
                ra: (150 + (dx + dy) * 10) as u8,
                rb: 0,
                clock: 0,
            },
        );
    }
    let sample = api.get(dx, dy);
    if sample.species == Species::Water {
        api.set(
            0,
            0,
            Cell {
                species: Species::Stone,
                ra: (150 + (dx + dy) * 10) as u8,
                rb: 0,
                clock: 0,
            },
        );
        api.set(dx, dy, EMPTY_CELL);
    } else if api.get(0, 1).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(0, 1, cell);
    } else if api.get(dx, 1).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(dx, 1, cell);
    } else if api.get(dx, 0).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(dx, 0, cell);
    } else {
        api.set(0, 0, cell);
    }
}

pub fn update_wood(cell: Cell, mut api: SandApi) {
    let rb = cell.rb;

    let (dx, dy) = api.rand_vec();

    let nbr_species = api.get(dx, dy).species;
    if rb == 0 && nbr_species == Species::Fire || nbr_species == Species::Lava {
        api.set(
            0,
            0,
            Cell {
                species: Species::Wood,
                ra: cell.ra,
                rb: 90,
                clock: 0,
            },
        );
    }

    if rb > 1 {
        api.set(
            0,
            0,
            Cell {
                species: Species::Wood,
                ra: cell.ra,
                rb: rb - 1,
                clock: 0,
            },
        );

        if rb % 4 == 0 && nbr_species == Species::Empty {
            let ra = 30 + api.rand_int(60) as u8;
            api.set(
                dx,
                dy,
                Cell {
                    species: Species::Fire,
                    ra,
                    rb: 0,
                    clock: 0,
                },
            )
        }
        if nbr_species == Species::Water {
            api.set(
                0,
                0,
                Cell {
                    species: Species::Wood,
                    ra: 50,
                    rb: 0,
                    clock: 0,
                },
            );
            api.set_fluid(Wind {
                dx: 0,
                dy: 0,
                pressure: 0,
                density: 220,
            });
        }
    } else if rb == 1 {
        api.set(
            0,
            0,
            Cell {
                species: Species::Empty,
                ra: cell.ra,
                rb: 90,
                clock: 0,
            },
        );
    }
}
pub fn update_ice(cell: Cell, mut api: SandApi) {
    let (dx, dy) = api.rand_vec();

    let fluid = api.get_fluid();

    if fluid.pressure > 120 && api.rand_int(1) == 0 {
        api.set(
            0,
            0,
            Cell {
                species: Species::Water,
                ra: cell.ra,
                rb: 0,
                clock: 0,
            },
        );
        return;
    }

    // Ice is a passive solid: it melts under high pressure or against
    // heat (fire/lava), but it does NOT actively freeze adjacent water.
    // Drawing an ice cube into water leaves the surrounding water liquid.
    let nbr_species = api.get(dx, dy).species;
    if nbr_species == Species::Fire || nbr_species == Species::Lava {
        api.set(
            0,
            0,
            Cell {
                species: Species::Water,
                ra: cell.ra,
                rb: cell.rb,
                clock: 0,
            },
        );
    }
}

pub fn update_plant(cell: Cell, mut api: SandApi) {
    let rb = cell.rb;

    if rb == 0 && api.universe.flags & FLAG_PLANT_ABSORBS != 0 && api.once_in(3) {
        let (adx, ady) = api.rand_vec_8();
        if api.get(adx, ady).species == Species::Water {
            let drift = api.rand_int(15) - 7;
            let newra = (cell.ra as i32 + drift) as u8;
            api.set(
                adx,
                ady,
                Cell {
                    species: Species::Plant,
                    ra: newra,
                    rb: 0,
                    clock: 0,
                },
            );
        }
    }

    let mut i = api.rand_int(100);
    let (dx, dy) = api.rand_vec();

    let nbr_species = api.get(dx, dy).species;
    if rb == 0 && nbr_species == Species::Fire || nbr_species == Species::Lava {
        api.set(
            0,
            0,
            Cell {
                species: Species::Plant,
                ra: cell.ra,
                rb: 20,
                clock: 0,
            },
        );
    }
    if nbr_species == Species::Wood {
        let (dx, dy) = api.rand_vec();

        let drift = (i % 15) - 7;
        let newra = (cell.ra as i32 + drift) as u8;
        if api.get(dx, dy).species == Species::Empty {
            api.set(
                dx,
                dy,
                Cell {
                    species: Species::Plant,
                    ra: newra,
                    rb: 0,
                    clock: 0,
                },
            );
        }
    }
    if api.rand_int(100) > 80
        && (nbr_species == Species::Water
            || nbr_species == Species::Fungus
                && (api.get(-dx, dy).species == Species::Empty
                    || api.get(-dx, dy).species == Species::Water
                    || api.get(-dx, dy).species == Species::Fungus))
    {
        i = api.rand_int(100);
        let drift = (i % 15) - 7;
        let newra = (cell.ra as i32 + drift) as u8;
        api.set(
            dx,
            dy,
            Cell {
                ra: newra,
                rb: 0,
                ..cell
            },
        );
        api.set(-dx, dy, EMPTY_CELL);
    }

    if rb > 1 {
        api.set(
            0,
            0,
            Cell {
                ra: cell.ra,
                rb: rb - 1,
                ..cell
            },
        );

        if nbr_species == Species::Empty {
            let ra = 20 + api.rand_int(30) as u8;
            api.set(
                dx,
                dy,
                Cell {
                    species: Species::Fire,
                    ra,
                    rb: 0,
                    clock: 0,
                },
            );
        }
        if nbr_species == Species::Water {
            api.set(
                0,
                0,
                Cell {
                    ra: 50,
                    rb: 0,
                    ..cell
                },
            )
        }
    } else if rb == 1 {
        api.set(0, 0, EMPTY_CELL);
    }
    let ra = cell.ra;
    if ra > 50
        && api.get(1, 1).species != Species::Plant
        && api.get(-1, 1).species != Species::Plant
    {
        if api.get(0, 1).species == Species::Empty {
            let i = (js_sys::Math::random() * js_sys::Math::random() * 100.) as i32;
            let dec = api.rand_int(30) - 20;
            if (i + ra as i32) > 165 {
                api.set(
                    0,
                    1,
                    Cell {
                        ra: (ra as i32 + dec) as u8,
                        ..cell
                    },
                );
            }
        } else {
            api.set(
                0,
                0,
                Cell {
                    ra: (ra - 1) as u8,
                    ..cell
                },
            );
        }
    }
}

pub fn update_seed(cell: Cell, mut api: SandApi) {
    let rb = cell.rb;
    let ra = cell.ra;

    let (dx, dy) = api.rand_vec();

    let nbr_species = api.get(dx, dy).species;
    if nbr_species == Species::Fire || nbr_species == Species::Lava {
        api.set(
            0,
            0,
            Cell {
                species: Species::Fire,
                ra: 5,
                rb: 0,
                clock: 0,
            },
        );
        return;
    }

    if rb == 0 {
        //falling

        let dxf = api.rand_dir(); //falling dx
        let nbr_species_below = api.get(dxf, 1).species;
        if nbr_species_below == Species::Sand
            || nbr_species_below == Species::Plant
            || nbr_species_below == Species::Fungus
        {
            let rb = (api.rand_int(253) + 1) as u8;
            api.set(0, 0, Cell { rb, ..cell });
            return;
        }

        let nbr = api.get(0, 1);
        if nbr.species == Species::Empty {
            api.set(0, 0, EMPTY_CELL);
            api.set(0, 1, cell);
        } else if api.get(dxf, 1).species == Species::Empty {
            api.set(0, 0, EMPTY_CELL);
            api.set(dxf, 1, cell);
        } else if nbr.species == Species::Water
            || nbr.species == Species::Gas
            || nbr.species == Species::Oil
            || nbr.species == Species::Acid
        {
            api.set(0, 0, nbr);
            api.set(0, 1, cell);
        } else {
            api.set(0, 0, cell);
        }
    } else {
        if ra > 60 {
            //stem
            let dxr = api.rand_dir(); //raising dx
            if api.rand_int(100) > 75 {
                if (api.get(dxr, -1).species == Species::Empty
                    || api.get(dxr, -1).species == Species::Sand
                    || api.get(dxr, -1).species == Species::Seed)
                    && api.get(1, -1).species != Species::Plant
                    && api.get(-1, -1).species != Species::Plant
                {
                    let ra = (ra as i32 - api.rand_int(10)) as u8;
                    api.set(dxr, -1, Cell { ra, ..cell });
                    let ra2 = 80 + api.rand_int(30) as u8;
                    api.set(
                        0,
                        0,
                        Cell {
                            species: Species::Plant,
                            ra: ra2,
                            rb: 0,
                            clock: 0,
                        },
                    )
                } else {
                    api.set(0, 0, EMPTY_CELL);
                }
            }
        } else {
            if ra > 40 {
                //petals

                let (mdx, mdy) = api.rand_vec();

                let (ldx, ldy) = adjacency_left((mdx, mdy));
                let (rdx, rdy) = adjacency_right((mdx, mdy));

                if (api.get(mdx, mdy).species == Species::Empty
                    || api.get(mdx, mdy).species == Species::Plant)
                    && (api.get(ldx, ldy).species == Species::Empty
                        || api.get(rdx, rdy).species == Species::Empty)
                {
                    let i = (js_sys::Math::random() * js_sys::Math::random() * 100.) as i32;
                    let dec = 9 - api.rand_int(3);
                    if (i + ra as i32) > 100 {
                        api.set(
                            mdx,
                            mdy,
                            Cell {
                                ra: (ra as i32 - dec) as u8,
                                ..cell
                            },
                        );
                    }
                }
            } else {
                if nbr_species == Species::Water {
                    api.set(dx, dy, Cell::new(Species::Seed))
                }
            }
        }
    }
}

pub fn update_fungus(cell: Cell, mut api: SandApi) {
    let rb = cell.rb;

    let (dx, dy) = api.rand_vec();

    let nbr_species = api.get(dx, dy).species;
    // Burn timer dropped from 10 → 4 so once a fungus cell catches fire
    // it dies within ~4 ticks. Combined with fire's new active ignition
    // path against fungus (see update_fire), fire is now a reliable
    // countermeasure to fungus growth.
    if rb == 0 && nbr_species == Species::Fire || nbr_species == Species::Lava {
        api.set(
            0,
            0,
            Cell {
                species: Species::Fungus,
                ra: cell.ra,
                rb: 4,
                clock: 0,
            },
        );
    }
    let mut i = api.rand_int(100);

    if nbr_species != Species::Empty
        && nbr_species != Species::Fungus
        && nbr_species != Species::Fire
        && nbr_species != Species::Ice
    {
        let (dx, dy) = api.rand_vec();

        let drift = (i % 15) - 7;
        let newra = (cell.ra as i32 + drift) as u8;
        if api.get(dx, dy).species == Species::Empty {
            api.set(
                dx,
                dy,
                Cell {
                    species: Species::Fungus,
                    ra: newra,
                    rb: 0,
                    clock: 0,
                },
            );
        }
    }

    if i > 9
        && nbr_species == Species::Wood
        && api.get(-dx, dy).species == Species::Wood
        && api.get(dx, -dy).species == Species::Wood
        && api.get(dx, dy).ra % 4 != 0
    {
        i = api.rand_int(100);
        let drift = (i % 15) - 7;
        let newra = (cell.ra as i32 + drift) as u8;
        api.set(
            dx,
            dy,
            Cell {
                ra: newra,
                rb: 0,
                ..cell
            },
        );
    }

    if rb > 1 {
        api.set(
            0,
            0,
            Cell {
                ra: cell.ra,
                rb: rb - 1,
                ..cell
            },
        );
        if nbr_species == Species::Empty {
            let ra = 10 + api.rand_int(10) as u8;
            api.set(
                dx,
                dy,
                Cell {
                    species: Species::Fire,
                    ra,
                    rb: 0,
                    clock: 0,
                },
            )
        }
        if nbr_species == Species::Water {
            api.set(
                0,
                0,
                Cell {
                    ra: 50,
                    rb: 0,
                    ..cell
                },
            )
        }
    } else if rb == 1 {
        api.set(0, 0, EMPTY_CELL);
    }

    let ra = cell.ra;

    if ra > 120 {
        let (mdx, mdy) = api.rand_vec();

        let (ldx, ldy) = adjacency_left((mdx, mdy));
        let (rdx, rdy) = adjacency_right((mdx, mdy));
        if api.get(mdx, mdy).species == Species::Empty
            && api.get(ldx, ldy).species != Species::Fungus
            && api.get(rdx, rdy).species != Species::Fungus
        {
            let i = (js_sys::Math::random() * js_sys::Math::random() * 100.) as i32;
            let dec = 15 - api.rand_int(20);
            if (i + ra as i32) > 165 {
                api.set(
                    mdx,
                    mdy,
                    Cell {
                        ra: (ra as i32 - dec) as u8,
                        ..cell
                    },
                );
            }
        }
    }
}

pub fn update_acid(cell: Cell, mut api: SandApi) {
    let dx = api.rand_dir();

    let ra = cell.ra;
    let mut degraded = cell.clone();
    degraded.ra = ra - 60;
    // i = api.rand_int(100);
    if degraded.ra < 80 {
        degraded = EMPTY_CELL;
    }
    if api.get(0, 1).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(0, 1, cell);
    } else if api.get(dx, 0).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(dx, 0, cell);
    } else if api.get(-dx, 0).species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(-dx, 0, cell);
    } else {
        if api.get(0, 1).species != Species::Wall
            && api.get(0, 1).species != Species::Acid
            && api.get(0, 1).species != Species::BlackHole
        {
            api.set(0, 0, EMPTY_CELL);
            api.set(0, 1, degraded);
        } else if api.get(dx, 0).species != Species::Wall
            && api.get(dx, 0).species != Species::Acid
            && api.get(dx, 0).species != Species::BlackHole
        {
            api.set(0, 0, EMPTY_CELL);
            api.set(dx, 0, degraded);
        } else if api.get(-dx, 0).species != Species::Wall
            && api.get(-dx, 0).species != Species::Acid
            && api.get(-dx, 0).species != Species::BlackHole
        {
            api.set(0, 0, EMPTY_CELL);
            api.set(-dx, 0, degraded);
        } else if api.get(0, -1).species != Species::Wall
            && api.get(0, -1).species != Species::Acid
            && api.get(0, -1).species != Species::BlackHole
            && api.get(0, -1).species != Species::Empty
        {
            api.set(0, 0, EMPTY_CELL);
            api.set(0, -1, degraded);
        } else {
            api.set(0, 0, cell);
        }
    }
}

pub fn update_mite(cell: Cell, mut api: SandApi) {
    let mut i = api.rand_int(100);
    let mut dx = 0;
    if cell.ra < 20 {
        dx = (cell.ra as i32) - 1;
    }
    let mut dy = 1;
    let mut mite = cell.clone();

    if cell.rb > 10 {
        // /
        mite.rb = mite.rb.saturating_sub(1);
        dy = -1;
    } else if cell.rb > 1 {
        // \
        mite.rb = mite.rb.saturating_sub(1);
    } else {
        // |
        dx = 0;
    }
    let nbr = api.get(dx, dy);

    let sx = (i % 3) - 1;
    i = api.rand_int(1000);
    let sy = (i % 3) - 1;
    let sample = api.get(sx, sy).species;
    if sample == Species::Fire
        || sample == Species::Lava
        || sample == Species::Water
        || sample == Species::Oil
    {
        api.set(0, 0, EMPTY_CELL);
        return;
    }
    if (sample == Species::Plant || sample == Species::Wood || sample == Species::Seed) && i > 800 {
        api.set(0, 0, EMPTY_CELL);
        api.set(sx, sy, cell);

        return;
    }
    if sample == Species::Dust {
        api.set(sx, sy, if i > 800 { cell } else { EMPTY_CELL });
    }

    if nbr.species == Species::Empty {
        api.set(0, 0, EMPTY_CELL);
        api.set(dx, dy, mite);
    } else if dy == 1 && i > 800 {
        i = api.rand_int(100);
        let mut ndx = (i % 3) - 1;
        if i < 6 {
            //switch direction
            ndx = dx;
        }

        mite.ra = (1 + ndx) as u8;
        mite.rb = 10 + (i % 10) as u8; //hop height

        api.set(0, 0, mite);
    } else {
        if api.get(-1, 0).species == Species::Mite
            && api.get(1, 0).species == Species::Mite
            && api.get(0, -1).species == Species::Mite
        {
            api.set(0, 0, EMPTY_CELL);
        } else {
            if api.get(0, 1).species == Species::Ice {
                if api.get(dx, 0).species == Species::Empty {
                    api.set(0, 0, EMPTY_CELL);
                    api.set(dx, 0, mite);
                }
            } else {
                api.set(0, 0, mite);
            }
        }
    }
}

pub fn update_spout(cell: Cell, mut api: SandApi) {
    if api.universe.flags & FLAG_SOURCES == 0 { return; }
    if api.once_in(4) {
        if api.get(0, 1).species == Species::Empty {
            api.set(0, 1, Cell::new(Species::Water));
        }
    }
    api.set(0, 0, cell);
}

pub fn update_sand_source(cell: Cell, mut api: SandApi) {
    if api.universe.flags & FLAG_SOURCES == 0 { return; }
    if api.once_in(4) {
        if api.get(0, 1).species == Species::Empty {
            api.set(0, 1, Cell::new(Species::Sand));
        }
    }
    api.set(0, 0, cell);
}

pub fn update_torch(cell: Cell, mut api: SandApi) {
    if api.universe.flags & FLAG_SOURCES == 0 { return; }
    if api.once_in(4) {
        let ra = 80 + api.rand_int(40) as u8;
        let (dx, dy) = api.rand_vec_8();
        if api.get(dx, dy).species == Species::Empty {
            api.set(
                dx,
                dy,
                Cell {
                    species: Species::Fire,
                    ra,
                    rb: 0,
                    clock: 0,
                },
            );
        }
    }
    api.set(0, 0, cell);
}

pub fn update_oil_well(cell: Cell, mut api: SandApi) {
    if api.universe.flags & FLAG_SOURCES == 0 { return; }
    if api.once_in(4) {
        if api.get(0, 1).species == Species::Empty {
            api.set(0, 1, Cell::new(Species::Oil));
        }
    }
    api.set(0, 0, cell);
}

pub fn update_gas_source(cell: Cell, mut api: SandApi) {
    if api.universe.flags & FLAG_SOURCES == 0 { return; }
    if api.once_in(4) {
        // Gas is buoyant, so emit it above the source.
        if api.get(0, -1).species == Species::Empty {
            api.set(0, -1, Cell::new(Species::Gas));
        }
    }
    api.set(0, 0, cell);
}

pub fn update_acid_source(cell: Cell, mut api: SandApi) {
    if api.universe.flags & FLAG_SOURCES == 0 { return; }
    if api.once_in(4) {
        if api.get(0, 1).species == Species::Empty {
            api.set(0, 1, Cell::new(Species::Acid));
        }
    }
    api.set(0, 0, cell);
}

pub fn update_black_hole(cell: Cell, mut api: SandApi) {
    if api.universe.flags & FLAG_SOURCES == 0 { return; }
    // Sample one of the 8 neighbors and erase it. Wall cells and other
    // BlackHole cells are spared so users can build funnels/containers
    // around a black hole and so two adjacent black holes don't eat
    // each other on alternating ticks.
    let (dx, dy) = api.rand_vec_8();
    let nbr = api.get(dx, dy);
    if nbr.species != Species::Empty
        && nbr.species != Species::Wall
        && nbr.species != Species::BlackHole
    {
        api.set(dx, dy, EMPTY_CELL);
    }
    api.set(0, 0, cell);
}

// ── Electricity & automation ────────────────────────────────────────────────
//
// Deterministic, single-buffer "push" propagation. A Spark writes Sparks into
// its resting-Wire neighbors (which, thanks to SandApi::set stamping
// clock = generation + 1, are skipped for the rest of this tick and only fire
// next tick), then decays itself into refractory Wire. That gives exactly one
// cell of travel per tick with no dependence on the alternating scan
// direction, since the result of any write is identical regardless of which
// neighbor writes first.

// 4-neighbor (orthogonal) connectivity. Diagonal wires intentionally do not
// conduct — see the spec's "Connectivity" decision.
const NEIGHBORS_4: [(i32, i32); 4] = [(0, -1), (0, 1), (-1, 0), (1, 0)];

// Resting wire (rb == 0) is inert: it simply waits to be pushed by an adjacent
// Spark or Battery. Refractory wire (rb > 0) counts down one step per tick and
// is NOT a valid spark target, which is what keeps a pulse from flowing back
// into the cell it just left.
pub fn update_wire(cell: Cell, mut api: SandApi) {
    if cell.rb > 0 {
        api.set(
            0,
            0,
            Cell {
                rb: cell.rb - 1,
                ..cell
            },
        );
    }
    // rb == 0: leave the cell untouched (sandspiel keeps unwritten cells as-is).
}

// Travelling current. Lights resting-wire neighbors, ignites adjacent
// gas/dust, then becomes refractory wire so the pulse moves on cleanly.
pub fn update_spark(cell: Cell, mut api: SandApi) {
    for (dx, dy) in NEIGHBORS_4.iter().cloned() {
        let nbr = api.get(dx, dy);
        if nbr.species == Species::Wire && nbr.rb == 0 {
            api.set(
                dx,
                dy,
                Cell {
                    species: Species::Spark,
                    ra: cell.ra,
                    rb: 0,
                    clock: 0,
                },
            );
        } else if nbr.species == Species::Gas || nbr.species == Species::Dust {
            // Mirror fire's gas/dust ignition (see update_fire).
            api.set(
                dx,
                dy,
                Cell {
                    species: Species::Fire,
                    ra: (150 + (dx + dy) * 10) as u8,
                    rb: 0,
                    clock: 0,
                },
            );
        }
    }
    // Decay into refractory wire. The cell can't be re-lit until rb hits 0.
    api.set(
        0,
        0,
        Cell {
            species: Species::Wire,
            ra: cell.ra,
            rb: REFRACTORY_TICKS,
            clock: 0,
        },
    );
}

// Source-gated pulse emitter. On its pulse generation it injects a Spark into
// each resting-wire neighbor; otherwise it just persists in place. Immovable.
pub fn update_battery(cell: Cell, mut api: SandApi) {
    if api.universe.flags & FLAG_SOURCES == 0 {
        api.set(0, 0, cell);
        return;
    }
    if api.universe.generation % BATTERY_PERIOD == 1 {
        for (dx, dy) in NEIGHBORS_4.iter().cloned() {
            let nbr = api.get(dx, dy);
            if nbr.species == Species::Wire && nbr.rb == 0 {
                api.set(
                    dx,
                    dy,
                    Cell {
                        species: Species::Spark,
                        ra: cell.ra,
                        rb: 0,
                        clock: 0,
                    },
                );
            }
        }
    }
    api.set(0, 0, cell);
}

// Open switch: an insulating, immovable break in a wire run. It is never a
// valid spark target, so current stops here. "Closing" the switch means
// overpainting the cell with Wire (electrically identical to a closed switch),
// which is just another draw transaction — no per-cell mutable state needed.
pub fn update_switch(cell: Cell, mut api: SandApi) {
    api.set(0, 0, cell);
}

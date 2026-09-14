# Licences and data provenance

Solar Map is built from public scientific data and a small number of openly licensed assets. Nothing here is
fetched at runtime: every dataset is downloaded once by a script in `scripts/`, checked, and committed.

## Code

| Component | Licence |
|---|---|
| Solar Map source (`src/`, `scripts/`, `test/`) | MIT |
| [three.js](https://threejs.org) 0.186.0 | MIT (© 2010–2026 three.js authors) |
| [Vite](https://vite.dev) 8.3.0 (build only) | MIT |
| [webgl-noise](https://github.com/stegu/webgl-noise) 3-D simplex noise, used verbatim in `src/render/shaders/noise3d.js` | MIT (© 2011 Ashima Arts; © 2011–2016 Stefan Gustavson) |

## Ephemeris and reference data

| Dataset | Source | Terms |
|---|---|---|
| VSOP87A planetary theory (`src/astro/data/vsop87a.js`) | Bretagnon & Francou 1988, A&A 202, 309; files from the [IMCCE distribution](https://ftp.imcce.fr/pub/ephem/planets/vsop87/) | Freely redistributable; cite the paper. |
| JPL Horizons state vectors (`test/fixtures/horizons/`) | [NASA/JPL Solar System Dynamics](https://ssd.jpl.nasa.gov/horizons/) | Public data. Fetched once by `scripts/fetch-horizons.mjs` under JPL's fair-use policy; the app never calls the API. |
| IAU WGCCRE 2015 rotational elements | Archinal et al. 2018, *Celest. Mech. Dyn. Astr.* 130:22 | Published values, cited in `src/astro/bodies.js`. |
| Leap seconds, ΔT | IERS Bulletin C / `Leap_Second.dat`; Espenak & Meeus (2006) polynomials via NASA GSFC | Public data. |
| Physical parameters (radii, GM, periods) | NASA NSSDC planetary fact sheets; JPL SSD `astro_par` (DE440) | Public data. |
| Reference event times (`test/fixtures/events.json`) | Derived from JPL Horizons; cross-checked against Fred Espenak's *Astropixels* almanac and in-the-sky.org | Each row carries its source URL. |

## Imagery

| Asset | Source | Licence |
|---|---|---|
| `public/textures/2k_*.jpg`, `2k_saturn_ring_alpha.png` | [Solar System Scope texture maps](https://www.solarsystemscope.com/textures/), compiled from NASA imagery and elevation data (MESSENGER, Magellan, Blue Marble, Earth at Night, Viking, Cassini, Voyager) | **CC BY 4.0** — attribution is given in the app's About panel and here. |

Photographic surfaces can be switched off in Settings, in which case every body is drawn with the project's own
procedural shaders and no third-party imagery is used.

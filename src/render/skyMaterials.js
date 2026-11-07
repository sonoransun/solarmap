// Material factories for everything luminous in the sky: catalogue stars, warp streaks, glow markers, the Milky Way
// (bake + sphere), the Sun glare quad and the analytic ecliptic grid disc. The older factories in materials.js are
// untouched; stars.js / markers.js / sunGlare.js / orbits.js import these directly. Same conventions as materials.js:
// every custom uniform object is exposed at `material.userData.uniforms` (the same objects three uploads) and
// `userData.kind` names the program.
//
// Blending: the additive materials here set `premultipliedAlpha: true`, which makes three use (ONE, ONE) instead of
// (SRC_ALPHA, ONE) — the shaders write premultiplied colour (rgb·a, a), so brightness is applied exactly once.
// (The previous star shader wrote rgb·a with SRC_ALPHA blending: colour × a² — part of the "faint stars invisible" defect.)
//
// r186 facts relied upon: TONE_MAPPING is defined for on-screen programs only, so <tonemapping_fragment> is a no-op
// inside the composer and the bake target; the HDR values written here reach UnrealBloomPass unclamped (HalfFloat).

import {
  AdditiveBlending, BackSide, Color, DoubleSide, NormalBlending, ShaderMaterial, Vector2, Vector3, Vector4,
} from 'three';
import { STAR_VERTEX, STAR_FRAGMENT } from './shaders/stars.js';
import { STREAK_VERTEX, STREAK_FRAGMENT } from './shaders/streaks.js';
import { MARKER_VERTEX, MARKER_FRAGMENT } from './shaders/markers.js';
import {
  MILKY_WAY_VERTEX, MILKY_WAY_FRAGMENT, MILKY_WAY_BAKE_VERTEX, MILKY_WAY_BAKE_FRAGMENT,
} from './shaders/milkyWay.js';
import { SUN_FLARE_VERTEX, SUN_FLARE_FRAGMENT } from './shaders/sunFlare.js';
import { GRID_VERTEX, GRID_FRAGMENT } from './shaders/grid.js';
import { FINAL_VERTEX, FINAL_FRAGMENT } from './shaders/finalPass.js';

/**
 * Catalogue star Points material (attributes aSize [CSS px], aColor [linear RGB × intensity]; uniforms uPixelRatio,
 * uFovScale, uTime, uTwinkle = 0). Additive, premultiplied, depthTest on (planets occlude stars), depthWrite off.
 * @returns {ShaderMaterial}
 */
export function createSkyStarMaterial() {
  const uniforms = { uPixelRatio: { value: 1 }, uFovScale: { value: 1 }, uTime: { value: 0 }, uTwinkle: { value: 0 } };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
  });
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'sky-stars';
  return mat;
}

/**
 * Warp streak LineSegments material (attributes aTail 0/1, aColor; uniforms uVelDir [unit, world], uStreak 0…0.6,
 * uPixelRatio). Additive, premultiplied, no depth test.
 * @returns {ShaderMaterial}
 */
export function createSkyStreakMaterial() {
  const uniforms = { uVelDir: { value: new Vector3(0, 0, 1) }, uStreak: { value: 0 }, uPixelRatio: { value: 1 } };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: STREAK_VERTEX,
    fragmentShader: STREAK_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: false,
  });
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'sky-streaks';
  return mat;
}

/**
 * Glow marker Points material (attributes aSize [CSS px], aAlpha, aIntensity, aColor; uniform uPixelRatio).
 * Additive, premultiplied, depthTest on, depthWrite off.
 * @returns {ShaderMaterial}
 */
export function createGlowMarkerMaterial() {
  const uniforms = { uPixelRatio: { value: 1 } };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: MARKER_VERTEX,
    fragmentShader: MARKER_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
  });
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'glow-markers';
  return mat;
}

/** Default linear intensity of the Milky Way band (baked peak ≈ 1.3 → 0.04–0.12 on screen). */
export const MILKY_WAY_INTENSITY = 0.09;

/**
 * Milky Way sphere material (BackSide, additive, premultiplied, depthWrite off). Uniforms: uMap (the baked
 * equirectangular texture, set by stars.js after baking; until then three binds its 1×1 empty texture and the band is
 * black), uGalPole / uGalCentre / uGalY (galactic basis, scene frame), uIntensity. The material stays `visible`:
 * three never queues an object whose material is invisible, which would also skip the onBeforeRender hook that bakes.
 * @param {{ galPole: ArrayLike<number>, galCentre: ArrayLike<number>, galY: ArrayLike<number> }} basis
 * @returns {ShaderMaterial}
 */
export function createMilkyWayMaterial(basis) {
  const uniforms = {
    uMap: { value: null },
    uGalPole: { value: new Vector3().fromArray(basis.galPole) },
    uGalCentre: { value: new Vector3().fromArray(basis.galCentre) },
    uGalY: { value: new Vector3().fromArray(basis.galY) },
    uIntensity: { value: MILKY_WAY_INTENSITY },
  };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: MILKY_WAY_VERTEX,
    fragmentShader: MILKY_WAY_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    side: BackSide,
  });
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'milky-way';
  return mat;
}

/**
 * Milky Way bake material: a full-screen quad rendered once into the equirectangular (galactic l, b) target.
 * @param {{ seed?: number }} [opts]
 * @returns {ShaderMaterial}
 */
export function createMilkyWayBakeMaterial({ seed = 3.1 } = {}) {
  const uniforms = { uSeed: { value: seed } };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: MILKY_WAY_BAKE_VERTEX,
    fragmentShader: MILKY_WAY_BAKE_FRAGMENT,
    depthWrite: false,
    depthTest: false,
  });
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'milky-way-bake';
  return mat;
}

/**
 * Sun glare billboard material. Uniforms (set per frame by sunGlare.js): uHalfSize [world units], uDiscR [disc
 * radius in quad units], uTime, uSuppress 0…1, uIntensity, uSpikeRot [rad]. Additive, premultiplied, depthTest on
 * (the photosphere occludes the centre), depthWrite off, DoubleSide (the quad is view-aligned, but the winding
 * depends on the parent's transform).
 * @returns {ShaderMaterial}
 */
export function createSunFlareMaterial() {
  const uniforms = {
    uHalfSize: { value: 1 },
    uDiscR: { value: 0.1 },
    uTime: { value: 0 },
    uSuppress: { value: 0 },
    uIntensity: { value: 1 },
    uSpikeRot: { value: 0.26 },
  };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: SUN_FLARE_VERTEX,
    fragmentShader: SUN_FLARE_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
  });
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'sun-flare';
  return mat;
}

/** Grid appearance: ring radii (AU), fade radius (AU) and opacities (plan §Rendering › Orbits, revised). */
export const GRID_DISC = Object.freeze({
  rings: [1, 5, 10, 30], fadeAu: 45, plane: 0.05, ring: 0.10, spoke: 0.05, colour: 0x8b93a7,
});

/**
 * Analytic ecliptic-grid disc material (normal blending, depthWrite off, DoubleSide).
 * @param {{ rings?: number[], fadeAu?: number, plane?: number, ring?: number, spoke?: number, colour?: number }} [opts]
 * @returns {ShaderMaterial}
 */
export function createGridDiscMaterial(opts = {}) {
  const o = { ...GRID_DISC, ...opts };
  const r = o.rings;
  const uniforms = {
    uColor: { value: new Color(o.colour) },
    uRings: { value: new Vector4(r[0] ?? 1, r[1] ?? 5, r[2] ?? 10, r[3] ?? 30) },
    uFadeAu: { value: o.fadeAu },
    uPlane: { value: o.plane },
    uRing: { value: o.ring },
    uSpoke: { value: o.spoke },
  };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: GRID_VERTEX,
    fragmentShader: GRID_FRAGMENT,
    transparent: true,
    blending: NormalBlending,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
  });
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'grid-disc';
  return mat;
}

/**
 * Final grade pass definition for `new ShaderPass(FinalGradeShader)` (renderer.js), placed after bloom and before
 * OutputPass. ShaderPass clones the uniforms: drive `pass.uniforms.uSeed.value` (per-frame dither seed),
 * `uResolution` (CSS px, for the vignette's aspect) and `uVignette` (0 disables).
 */
export const FinalGradeShader = {
  name: 'FinalGradeShader',
  defines: {},
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.22 },
    uSeed: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },
  },
  vertexShader: FINAL_VERTEX,
  fragmentShader: FINAL_FRAGMENT,
};

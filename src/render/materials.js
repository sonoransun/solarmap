// Material factory for the render layer. Every material exposes its custom uniforms at
// `material.userData.uniforms` (same objects three uploads), so the render core updates
// e.g. `mat.userData.uniforms.uSunDirView.value.copy(v)` per frame and `setMaterialTime(mat, t)`.
//
// three r186 facts this file relies on (verified in node_modules/three/src, see the research notes):
//  - MeshStandardMaterial fragment (ShaderLib/meshphysical.glsl.js) contains the anchors <common>,
//    <color_fragment>, <alphamap_fragment>, <roughnessmap_fragment>, <emissivemap_fragment>; the vertex
//    contains <common> and <begin_vertex>. <lights_pars_begin> precedes them, so `pointLights[0]` exists when
//    NUM_POINT_LIGHTS > 0 (guarded; falls back to the uSunDirView uniform otherwise).
//  - Custom ShaderMaterials get log depth only through the r186 chunks <common>, <logdepthbuf_pars_vertex>,
//    <logdepthbuf_vertex>, <logdepthbuf_pars_fragment>, <logdepthbuf_fragment> (define
//    USE_LOGARITHMIC_DEPTH_BUFFER), and tone mapping / output colour space only through
//    <tonemapping_fragment> + <colorspace_fragment> (TONE_MAPPING is defined for on-screen programs only,
//    so the composer path applies ACES once in OutputPass and the Quality-Low direct path matches).
//  - A `Color` is accepted as a vec3 uniform value (WebGLUniforms.setValueV3f reads .r/.g/.b); with
//    ColorManagement on, `new Color(hex)` converts the sRGB design hex to linear working space.
//  - customProgramCacheKey() returns one key per planet kind; all per-body variation is in uniforms, so the
//    injected code is identical for materials sharing a key (a requirement of three's program cache).
import {
  AdditiveBlending,
  BackSide,
  CanvasTexture,
  Color,
  DoubleSide,
  MeshStandardMaterial,
  NormalBlending,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from 'three';
import { NOISE3D_GLSL } from './shaders/noise3d.js';
import { PLANET_COMMON_GLSL } from './shaders/planetCommon.js';
import { GAS_GIANT_GLSL } from './shaders/gasGiant.js';
import { ROCKY_GLSL } from './shaders/rocky.js';
import { VENUS_GLSL } from './shaders/venus.js';
import { EARTH_GLSL } from './shaders/earth.js';
import { ICE_GLSL } from './shaders/ice.js';
import { SUN_VERTEX, SUN_FRAGMENT } from './shaders/sun.js';
import { ATMOSPHERE_VERTEX, ATMOSPHERE_FRAGMENT } from './shaders/atmosphere.js';
import { RINGS_VERTEX, RINGS_FRAGMENT } from './shaders/rings.js';
import { MARKER_VERTEX, MARKER_FRAGMENT } from './shaders/markers.js';
import { STAR_VERTEX, STAR_FRAGMENT } from './shaders/stars.js';
import { STREAK_VERTEX, STREAK_FRAGMENT } from './shaders/streaks.js';
import { RADIAL_BLUR_VERTEX, RADIAL_BLUR_FRAGMENT } from './shaders/radialBlur.js';

/** uTime is wrapped at this many seconds (float32 drift in the noise domain; drifts are 1e4 s periodic). */
export const TIME_WRAP_S = 1e4;

/** @typedef {'rocky'|'venus'|'earth'|'gas'|'ice'|'flat'} PlanetKind */

/** Body id → procedural material kind (one shader program per kind). */
export const PLANET_KIND = Object.freeze({
  mercury: 'rocky',
  venus: 'venus',
  earth: 'earth',
  mars: 'rocky',
  jupiter: 'gas',
  saturn: 'gas',
  uranus: 'ice',
  neptune: 'ice',
});

/** Flat/marker/label body colours (plan §UI palette). */
export const BODY_COLOUR = Object.freeze({
  sun: 0xffd27d,
  mercury: 0xb5b2ad,
  venus: 0xe8cda0,
  earth: 0x6b93d6,
  mars: 0xc1440e,
  jupiter: 0xd8a96b,
  saturn: 0xe3d6a8,
  uranus: 0x9ad6de,
  neptune: 0x4c6ef5,
});

// Per-body pattern parameters (plan §Rendering "Procedural materials"; research §4.3). Colours are sRGB hex.
const PLANET_PARAMS = {
  jupiter: { colA: 0xc8a97e, colB: 0x8c5a3c, colC: 0xe8d8c0, stormCol: 0xb5583c, bands: 5.0, warp: 0.35, storm: 1.0, spot: 1.0, seed: 1.3 },
  saturn: { colA: 0xe3d6a8, colB: 0xc9b37e, colC: 0xf1e8c8, stormCol: 0xf4eedc, bands: 7.0, warp: 0.15, storm: 0.15, spot: 0.0, seed: 2.1 },
  uranus: { colA: 0x9ad6de, colB: 0x7fc4d0, colC: 0xd8f3f6, stormCol: 0x5e9eaa, bands: 3.0, warp: 0.05, storm: 0.0, spot: 0.0, seed: 3.7 },
  neptune: { colA: 0x4c6ef5, colB: 0x2f4bc2, colC: 0x8fb3ff, stormCol: 0x22357a, bands: 3.0, warp: 0.12, storm: 0.6, spot: 0.8, seed: 4.2 },
  mercury: { colA: 0xb5b2ad, colB: 0x6e6b66, colC: 0xb5b2ad, cap: 0.0, craterScale: 1.0, seed: 5.1 },
  mars: { colA: 0xc1440e, colB: 0x6b2a12, colC: 0xf4eee6, cap: 1.0, craterScale: 0.8, seed: 6.4 },
  venus: { colA: 0xe8cda0, colB: 0xd9b77a, colC: 0xe8cda0, seed: 7.9 },
  earth: { colA: 0x6b93d6, colB: 0x6b93d6, colC: 0x6b93d6, seed: 8.8, city: 0.6 },
};

// Atmosphere colour / fresnel power / intensity (plan §Rendering). Bodies missing here get an invisible material.
const ATMOSPHERE_PARAMS = {
  earth: { color: 0x6ea8ff, power: 3.0, intensity: 1.0 },
  venus: { color: 0xf2d9a6, power: 2.5, intensity: 0.9 },
  mars: { color: 0xe7a87a, power: 4.0, intensity: 0.5 },
  jupiter: { color: 0xffe7c2, power: 4.5, intensity: 0.5 },
  saturn: { color: 0xffe7c2, power: 4.5, intensity: 0.5 },
  uranus: { color: 0xa8e6ff, power: 3.5, intensity: 0.8 },
  neptune: { color: 0xa8e6ff, power: 3.5, intensity: 0.8 },
};

const KIND_GLSL = { gas: GAS_GIANT_GLSL, ice: ICE_GLSL, rocky: ROCKY_GLSL, venus: VENUS_GLSL, earth: EARTH_GLSL };

const KIND_UNIFORM_DECL = {
  gas: 'uniform float uBands;\nuniform float uWarp;\nuniform float uStorm;\nuniform float uSpot;\nuniform vec3 uStormCol;\n',
  ice: 'uniform float uBands;\nuniform float uWarp;\nuniform float uStorm;\nuniform float uSpot;\nuniform vec3 uStormCol;\n',
  rocky: 'uniform float uCap;\nuniform float uCraterScale;\n',
  venus: '',
  earth: 'uniform float uCity;\n',
};

// Albedo line injected after <color_fragment>; smN / smRough / smCity are declared just before it.
const KIND_COLOR_LINE = {
  gas: 'diffuseColor.rgb *= mix(gasGiant(smN, uTime, uColA, uColB, uColC, uStormCol, uBands, uWarp, uStorm, uSpot, uSeed), vec3(1.0), uTexMix);',
  ice: 'diffuseColor.rgb *= mix(iceGiant(smN, uTime, uColA, uColB, uColC, uStormCol, uBands, uWarp, uStorm, uSpot, uSeed), vec3(1.0), uTexMix);',
  rocky: 'diffuseColor.rgb *= mix(rocky(smN, uColA, uColB, uColC, uCap, uCraterScale, uSeed), vec3(1.0), uTexMix);',
  venus: 'diffuseColor.rgb *= mix(venusClouds(smN, uTime, uColA, uColB, uSeed), vec3(1.0), uTexMix);',
  earth: 'diffuseColor.rgb *= mix(earthSurface(smN, uSeed, smRough, smCity), vec3(1.0), uTexMix);',
};

// Night-side city lights (Earth only). Gate on the actual point light when the scene has one; else on uSunDirView.
const EARTH_EMISSIVE_BLOCK = /* glsl */ `
{
  #if NUM_POINT_LIGHTS > 0
    vec3 smSunDir = normalize(pointLights[0].position + vViewPosition);
  #else
    vec3 smSunDir = uSunDirView;
  #endif
  float smNight = 1.0 - smoothstep(-0.08, 0.12, dot(normal, smSunDir));
  vec3 smLights = vec3(1.0, 0.78, 0.5) * (smCity * uCity);
  #if defined( USE_MAP )
    // Photographic mode: NASA's "Earth at night" composite, gated to the unlit hemisphere.
    smLights = mix(smLights, texture2D(uNightMap, vMapUv).rgb * uCity * 1.6, uTexMix);
  #endif
  totalEmissiveRadiance += smLights * smNight;
}
`;

// With a day map bound, ocean is the blue-dominant part of the albedo: give it a low roughness so the Sun glints
// off water the way it does in orbital photography, and keep land matte.
const EARTH_TEXTURED_ROUGHNESS = /* glsl */ `
#if defined( USE_MAP )
{
  float smOcean = smoothstep(0.0, 0.22, diffuseColor.b - max(diffuseColor.r, diffuseColor.g) * 1.05);
  roughnessFactor = mix(roughnessFactor, mix(0.92, 0.28, smOcean), uTexMix);
}
#endif
`;

/** @param {number} hex @returns {{ value: Color }} */
function colorUniform(hex) {
  return { value: new Color(hex) };
}

/**
 * Inject `varying vec3 vObj` (object-space position of the unit sphere → seamless object-space sampling).
 * @param {string} vertexShader
 * @returns {string}
 */
function injectVertexObj(vertexShader) {
  return vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vObj;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = position;');
}

/**
 * Procedural planet material: MeshStandardMaterial + onBeforeCompile. Patterns sample the object-space unit
 * normal (local +Z = spin axis, latitude = n.z), so the r186 sphere seam on −X is irrelevant.
 * @param {string} id body id ('mercury' … 'neptune')
 * @param {{ flat?: boolean }} [opts] flat: plain colour fallback material (no procedural shader)
 * @returns {MeshStandardMaterial}
 */
export function createPlanetMaterial(id, opts = {}) {
  const kind = PLANET_KIND[id];
  if (opts.flat || !kind) return createFlatMaterial(id);
  const p = PLANET_PARAMS[id];
  const mat = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: kind === 'gas' || kind === 'ice' ? 0.85 : 0.9,
    metalness: 0,
  });
  const uniforms = {
    uTime: { value: 0 },
    uSeed: { value: p.seed },
    uColA: colorUniform(p.colA),
    uColB: colorUniform(p.colB),
    uColC: colorUniform(p.colC),
    uSunDirView: { value: new Vector3(0, 0, 1) },
    uTexMix: { value: 0 }, // 0 = procedural surface, 1 = photographic map (set by applyTexture)
  };
  if (kind === 'gas' || kind === 'ice') {
    uniforms.uStormCol = colorUniform(p.stormCol);
    uniforms.uBands = { value: p.bands };
    uniforms.uWarp = { value: p.warp };
    uniforms.uStorm = { value: p.storm };
    uniforms.uSpot = { value: p.spot };
  } else if (kind === 'rocky') {
    uniforms.uCap = { value: p.cap };
    uniforms.uCraterScale = { value: p.craterScale };
  } else if (kind === 'earth') {
    uniforms.uCity = { value: p.city };
    uniforms.uNightMap = { value: null };
  }
  mat.userData.uniforms = uniforms;
  mat.userData.kind = kind;
  mat.userData.bodyId = id;

  const fragmentHead =
    '#include <common>\n' +
    'varying vec3 vObj;\n' +
    'uniform float uTime;\nuniform float uSeed;\nuniform vec3 uColA;\nuniform vec3 uColB;\nuniform vec3 uColC;\n' +
    'uniform vec3 uSunDirView;\nuniform float uTexMix;\n' +
    (kind === 'earth' ? 'uniform sampler2D uNightMap;\n' : '') +
    KIND_UNIFORM_DECL[kind] +
    NOISE3D_GLSL +
    PLANET_COMMON_GLSL +
    KIND_GLSL[kind];
  const colorBlock =
    '#include <color_fragment>\n' +
    'vec3 smN = normalize(vObj);\nfloat smRough = roughness;\nfloat smCity = 0.0;\n' +
    KIND_COLOR_LINE[kind] + '\n';

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectVertexObj(shader.vertexShader);
    let fs = shader.fragmentShader
      .replace('#include <common>', fragmentHead)
      .replace('#include <color_fragment>', colorBlock);
    if (kind === 'earth') {
      fs = fs
        .replace('#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\nroughnessFactor = mix(smRough, roughnessFactor, uTexMix);' + EARTH_TEXTURED_ROUGHNESS)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + EARTH_EMISSIVE_BLOCK);
    }
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'solarmap-planet-' + kind;
  return mat;
}

/**
 * Flat-colour fallback (plan: "Flat-colour fallback material behind a flag").
 * @param {string} id
 * @returns {MeshStandardMaterial}
 */
export function createFlatMaterial(id) {
  const mat = new MeshStandardMaterial({ color: BODY_COLOUR[id] ?? 0x9aa0a6, roughness: 0.9, metalness: 0 });
  mat.userData.uniforms = {};
  mat.userData.kind = 'flat';
  mat.userData.bodyId = id;
  return mat;
}

/**
 * Earth cloud layer (mesh at 1.006 R, spinning with the surface; slow periodic FBM drift, no super-rotation).
 * @returns {MeshStandardMaterial} transparent, depthWrite off
 */
export function createEarthCloudMaterial() {
  const mat = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    transparent: true,
    depthWrite: false,
  });
  const uniforms = { uTime: { value: 0 }, uSeed: { value: 12.5 }, uTexMix: { value: 0 } };
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'clouds';
  mat.userData.bodyId = 'earth';
  const fragmentHead =
    '#include <common>\nvarying vec3 vObj;\nuniform float uTime;\nuniform float uSeed;\nuniform float uTexMix;\n' +
    NOISE3D_GLSL + PLANET_COMMON_GLSL + EARTH_GLSL;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectVertexObj(shader.vertexShader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', fragmentHead)
      .replace('#include <alphamap_fragment>',
        '#include <alphamap_fragment>\n' +
        'float smCloudA = earthCloudAlpha(normalize(vObj), uTime, uSeed);\n' +
        '#if defined( USE_MAP )\n' +
        // The photographic cloud sheet is white-on-black: its luminance is the coverage.
        '  smCloudA = mix(smCloudA, smoothstep(0.06, 0.55, dot(diffuseColor.rgb, vec3(0.3333))), uTexMix);\n' +
        '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), uTexMix);\n' +
        '#endif\n' +
        'diffuseColor.a *= smCloudA;\ndiffuseColor.rgb *= 0.96;');
  };
  mat.customProgramCacheKey = () => 'solarmap-earth-clouds';
  return mat;
}

/**
 * Sun photosphere: unlit HDR ShaderMaterial (≈2–5 linear → bloom). Freeze by not calling setMaterialTime.
 * @returns {ShaderMaterial}
 */
export function createSunMaterial() {
  const uniforms = {
    uTime: { value: 0 }, uIntensity: { value: 1.0 }, uSeed: { value: 0.7 },
    uMap: { value: null }, uTexMix: { value: 0 },
  };
  const mat = new ShaderMaterial({ uniforms, vertexShader: SUN_VERTEX, fragmentShader: SUN_FRAGMENT });
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'sun';
  return mat;
}

/**
 * Radial-gradient CanvasTexture (sRGB) for the corona sprites. Needs a DOM (call at runtime only).
 * @param {number} size
 * @param {Array<[number, string]>} stops
 * @returns {CanvasTexture}
 */
function radialGradientTexture(size, stops) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [t, colour] of stops) g.addColorStop(t, colour);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * Corona (3.5 R☉) and glare (8 R☉, clamped by the render core to ≥ 28 CSS px) sprites, additive, depthWrite off.
 * Sizing hints are in `sprite.userData` ({ radiusFactor, minCssPx }); the render core sets `sprite.scale`.
 * @returns {{ corona: Sprite, glare: Sprite }}
 */
export function createCoronaSprites() {
  const coronaTex = radialGradientTexture(256, [
    [0.0, 'rgba(255, 225, 170, 1.0)'],
    [0.18, 'rgba(255, 190, 100, 0.75)'],
    [0.45, 'rgba(255, 150, 60, 0.25)'],
    [1.0, 'rgba(255, 120, 40, 0.0)'],
  ]);
  const glareTex = radialGradientTexture(256, [
    [0.0, 'rgba(255, 240, 210, 0.9)'],
    [0.12, 'rgba(255, 210, 140, 0.45)'],
    [0.4, 'rgba(255, 180, 90, 0.12)'],
    [1.0, 'rgba(255, 160, 70, 0.0)'],
  ]);
  const corona = new Sprite(new SpriteMaterial({
    map: coronaTex,
    color: new Color(1.6, 1.35, 1.0),   // > 1: HDR so the bloom pass catches the inner corona
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  }));
  corona.userData.radiusFactor = 3.5;
  corona.userData.minCssPx = 0;
  corona.name = 'sun-corona';
  const glare = new Sprite(new SpriteMaterial({
    map: glareTex,
    color: new Color(1.0, 1.0, 1.0),
    opacity: 0.9,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  }));
  glare.userData.radiusFactor = 8;
  glare.userData.minCssPx = 28;
  glare.name = 'sun-glare';
  return { corona, glare };
}

/**
 * Fresnel atmosphere shell material (BackSide, additive, depthWrite off). Bodies without an atmosphere
 * (mercury, sun) get a material with `visible = false` and zero intensity so callers need not special-case.
 * Per frame: `mat.userData.uniforms.uSunDirView.value` = unit body→Sun direction in view space.
 * @param {string} id
 * @returns {ShaderMaterial}
 */
export function createAtmosphereMaterial(id) {
  const p = ATMOSPHERE_PARAMS[id];
  const uniforms = {
    uColor: colorUniform(p ? p.color : 0xffffff),
    uPower: { value: p ? p.power : 3.0 },
    uIntensity: { value: p ? p.intensity : 0.0 },
    uShell: { value: 1.02 },
    uSunDirView: { value: new Vector3(0, 0, 1) },
    uTexMix: { value: 0 }, // 0 = procedural surface, 1 = photographic map (set by applyTexture)
  };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: ATMOSPHERE_VERTEX,
    fragmentShader: ATMOSPHERE_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: BackSide,
  });
  mat.visible = !!p;
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'atmosphere';
  mat.userData.bodyId = id;
  return mat;
}

/**
 * Saturn ring material for RingGeometry(innerR, outerR, 256) in planet radii, DoubleSide, transparent,
 * depthWrite off. Per frame (ring object space, planet-radius units): uSunDirObj (unit planet→Sun),
 * uCamPosObj (camera position via ring.worldToLocal). uPolarRatio = polar/equatorial radius (Saturn 0.902).
 * @param {{ innerR: number, outerR: number, polarRatio?: number }} spec
 * @returns {ShaderMaterial}
 */
export function createRingMaterial(spec) {
  const uniforms = {
    uSunDirObj: { value: new Vector3(0, 0, 1) },
    uCamPosObj: { value: new Vector3(0, 0, 10) },
    uPolarRatio: { value: spec.polarRatio ?? 54364 / 60268 },   // NSSDC Saturn c/a
    uOpacity: { value: 1.0 },
    uSeed: { value: 2.0 },
    uInnerR: { value: spec.innerR },
    uOuterR: { value: spec.outerR },
    uRingTex: { value: null },
    uTexMix: { value: 0 },
  };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: RINGS_VERTEX,
    fragmentShader: RINGS_FRAGMENT,
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
    depthTest: true,
  });
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'rings';
  return mat;
}

/**
 * Marker Points material (attributes aSize [CSS px], aAlpha, aColor; uniform uPixelRatio).
 * @returns {ShaderMaterial}
 */
export function createMarkerMaterial() {
  const uniforms = { uPixelRatio: { value: 1 } };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: MARKER_VERTEX,
    fragmentShader: MARKER_FRAGMENT,
    transparent: true,
    blending: NormalBlending,
    depthWrite: false,
    depthTest: true,
  });
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'markers';
  return mat;
}

/**
 * Star Points material (attributes aSize [CSS px], aColor; uniforms uPixelRatio, uTime, uTwinkle = 0).
 * @returns {ShaderMaterial}
 */
export function createStarMaterial() {
  const uniforms = { uPixelRatio: { value: 1 }, uTime: { value: 0 }, uTwinkle: { value: 0 } };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'stars';
  return mat;
}

/**
 * Warp streak LineSegments material (attributes aTail 0/1, aMag, aColor; uniforms uVelDir [unit, world],
 * uStreak 0…0.6, uPixelRatio). Additive, no depth test.
 * @returns {ShaderMaterial}
 */
export function createStreakMaterial() {
  const uniforms = { uVelDir: { value: new Vector3(0, 0, 1) }, uStreak: { value: 0 }, uPixelRatio: { value: 1 } };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: STREAK_VERTEX,
    fragmentShader: STREAK_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  mat.userData.uniforms = uniforms;
  mat.userData.kind = 'streaks';
  return mat;
}

/**
 * Radial-blur pass definition for `new ShaderPass(RadialBlurShader)`. ShaderPass clones the uniforms:
 * drive `pass.uniforms.uCenter.value` (uv of the projected velocity direction, clamp to [-0.5, 1.5]) and
 * `pass.uniforms.uStrength.value` (= uStreak), and set `pass.enabled = strength > 0.01`.
 */
export const RadialBlurShader = {
  name: 'RadialBlurShader',
  defines: {},
  uniforms: {
    tDiffuse: { value: null },
    uCenter: { value: new Vector2(0.5, 0.5) },
    uStrength: { value: 0 },
  },
  vertexShader: RADIAL_BLUR_VERTEX,
  fragmentShader: RADIAL_BLUR_FRAGMENT,
};

/**
 * Set the animation time of a material (no-op when it has no uTime). Wrapped at TIME_WRAP_S; all drifts are
 * periodic in that interval so the wrap never pops. Skip the call to freeze (reduced motion).
 * @param {import('three').Material} material
 * @param {number} tSeconds
 */
export function setMaterialTime(material, tSeconds) {
  const u = material && material.userData && material.userData.uniforms;
  if (!u || !u.uTime) return;
  let t = tSeconds % TIME_WRAP_S;
  if (t < 0) t += TIME_WRAP_S;
  u.uTime.value = t;
}

/**
 * Copy a unit Sun direction into whichever uniform the material uses (uSunDirView for planets/atmospheres
 * in view space, uSunDirObj for rings in object space). No-op otherwise.
 * @param {import('three').Material} material
 * @param {Vector3} dir
 */
export function setMaterialSunDir(material, dir) {
  const u = material && material.userData && material.userData.uniforms;
  if (!u) return;
  if (u.uSunDirView) u.uSunDirView.value.copy(dir);
  else if (u.uSunDirObj) u.uSunDirObj.value.copy(dir);
}

/**
 * Bind a photographic map to a live material and cross-fade the procedural surface out. Safe to call at any time:
 * the shader keeps both paths and `uTexMix` chooses between them, so surfaces upgrade in place while the app runs.
 *
 * @param {import('three').Material} material  planet / clouds / sun / ring material from this module
 * @param {import('three').Texture|null} texture
 * @param {object} [opts]
 * @param {'map'|'night'|'clouds'|'ring'} [opts.kind='map']
 * @param {number} [opts.mix=1]  0 → procedural, 1 → photographic
 * @returns {boolean} whether anything changed
 */
export function applyTexture(material, texture, { kind = 'map', mix = 1 } = {}) {
  if (!material || !texture) return false;
  const u = material.userData?.uniforms;
  const bodyKind = material.userData?.kind;
  if (kind === 'night') {
    if (!u?.uNightMap) return false;
    u.uNightMap.value = texture;
    return true;
  }
  if (kind === 'ring') {
    if (!u?.uRingTex) return false;
    u.uRingTex.value = texture;
    u.uTexMix.value = mix;
    return true;
  }
  if (bodyKind === 'sun') {
    if (!u?.uMap) return false;
    u.uMap.value = texture;
    u.uTexMix.value = mix;
    return true;
  }
  // MeshStandardMaterial paths (planets and the Earth cloud shell): three's <map_fragment> multiplies the albedo in,
  // and uTexMix switches the injected procedural colour off.
  material.map = texture;
  material.needsUpdate = true;
  if (u?.uTexMix) u.uTexMix.value = mix;
  return true;
}

/**
 * Which texture kinds a material can take (used by the loader to avoid pointless work).
 * @param {import('three').Material} material
 * @returns {string[]}
 */
export function textureSlots(material) {
  const u = material?.userData?.uniforms;
  const k = material?.userData?.kind;
  if (!u) return [];
  if (k === 'sun') return ['map'];
  if (k === 'rings') return ['ring'];
  if (k === 'clouds') return ['clouds'];
  if (k === 'earth') return ['map', 'night'];
  return ['map'];
}

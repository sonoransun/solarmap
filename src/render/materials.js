// Material factory for the render layer. Every material exposes its custom uniforms at
// `material.userData.uniforms` (same objects three uploads), so the render core updates
// e.g. `mat.userData.uniforms.uSunDirView.value.copy(v)` per frame and `setMaterialTime(mat, t)`.
//
// three r186 facts this file relies on (verified in node_modules/three/src, see the research notes):
//  - MeshStandardMaterial fragment (ShaderLib/meshphysical.glsl.js) contains the anchors <common>,
//    <color_fragment>, <alphamap_fragment>, <roughnessmap_fragment>, <emissivemap_fragment> and
//    <lights_fragment_begin>; the vertex contains <common> and <begin_vertex>. <lights_pars_begin> precedes them, so
//    `pointLights[0]` exists when NUM_POINT_LIGHTS > 0 (guarded; falls back to the uSunDirView uniform otherwise).
//    After <lights_fragment_begin> the function-scope `directLight` holds the last point light's view-space direction
//    and colour (the Sun: scene.js adds exactly one PointLight), `geometryNormal` / `geometryViewDir` are in scope
//    and `reflectedLight.directDiffuse` holds Lambert's N·L · colour · albedo/π — which the planet materials replace
//    with the wrap + Minnaert term of planetCommon.js (specular, i.e. the ocean glint, is kept as three computes it).
//    `material.diffuseContribution` and BRDF_Lambert (<common>) are the r186 names.
//  - Custom ShaderMaterials get log depth only through the r186 chunks <common>, <logdepthbuf_pars_vertex>,
//    <logdepthbuf_vertex>, <logdepthbuf_pars_fragment>, <logdepthbuf_fragment> (define
//    USE_LOGARITHMIC_DEPTH_BUFFER), and tone mapping / output colour space only through
//    <tonemapping_fragment> + <colorspace_fragment> (TONE_MAPPING is defined for on-screen programs only,
//    so the composer path applies tone mapping once in OutputPass and the Quality-Low direct path matches).
//  - r186 compiles every program as GLSL ES 3.00 and defines `texture2DLodEXT` → textureLod (WebGLProgram.js), used
//    here for the equirectangular cloud-shadow lookup with an explicit mip level.
//  - A `Color` is accepted as a vec3 uniform value (WebGLUniforms.setValueV3f reads .r/.g/.b); with
//    ColorManagement on, `new Color(hex)` converts the sRGB design hex to linear working space.
//  - customProgramCacheKey() returns one key per planet kind; all per-body variation is in uniforms, so the
//    injected code is identical for materials sharing a key (a requirement of three's program cache). Saturn's ring
//    shadow lives in the shared 'gas' program behind the uRingShadow uniform (0 for Jupiter).
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  FrontSide,
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
import { RINGS_VERTEX, RINGS_FRAGMENT, RING_ALPHA_GLSL } from './shaders/rings.js';
import { MARKER_VERTEX, MARKER_FRAGMENT } from './shaders/markers.js';
import { STAR_VERTEX, STAR_FRAGMENT } from './shaders/stars.js';
import { STREAK_VERTEX, STREAK_FRAGMENT } from './shaders/streaks.js';
import { RADIAL_BLUR_VERTEX, RADIAL_BLUR_FRAGMENT } from './shaders/radialBlur.js';

/** uTime is wrapped at this many seconds (float32 drift in the noise domain; drifts are 1e4 s periodic). */
export const TIME_WRAP_S = 1e4;

/** @typedef {'rocky'|'venus'|'earth'|'gas'|'ice'|'flat'} PlanetKind */

/** Body id → procedural material kind (one shader program per kind). The Moon is a rocky body like Mercury. */
export const PLANET_KIND = Object.freeze({
  mercury: 'rocky',
  venus: 'venus',
  earth: 'earth',
  moon: 'rocky',
  mars: 'rocky',
  jupiter: 'gas',
  saturn: 'gas',
  uranus: 'ice',
  neptune: 'ice',
});

/**
 * Fallback flat/marker colours (plan §UI palette). The scene passes each body's own `colour` from its bodyDef
 * (src/astro/bodies.js through main.js) to createPlanetMaterial / createFlatMaterial, so this table is only used
 * when a caller gives none.
 */
export const BODY_COLOUR = Object.freeze({
  sun: 0xffd27d,
  mercury: 0xb5b2ad,
  venus: 0xe8cda0,
  earth: 0x6b93d6,
  moon: 0xc8c8c8,
  mars: 0xc1440e,
  jupiter: 0xd8a96b,
  saturn: 0xe3d6a8,
  uranus: 0x9ad6de,
  neptune: 0x8db9d8,
});

// Per-body pattern parameters (plan §Rendering "Procedural materials"; research §4.3). Colours are sRGB hex.
// Neptune: pale azure after Irwin et al. 2024 (MNRAS 527, 11521, "Modelling the seasonal cycle of Uranus's colour
// and magnitude, and comparison with Neptune"): reprocessed Voyager 2 / HST data show Neptune a pale greenish-blue
// only slightly bluer than Uranus; the saturated royal blue of the 1989 releases was a contrast stretch. The hex
// values are a stylised rendering of that result, not measured chromaticities.
// Moon: grey highlands (#A8A6A2) and darker maria (#5E5C59) — stylised from the Moon's geometric albedo 0.12 with a
// ~2:1 highland/mare contrast (NSSDC moonfact); craters denser than Mercury's lattice; no polar caps.
const PLANET_PARAMS = {
  jupiter: { colA: 0xc8a97e, colB: 0x8c5a3c, colC: 0xe8d8c0, stormCol: 0xb5583c, bands: 5.0, warp: 0.35, storm: 1.0, spot: 1.0, seed: 1.3 },
  saturn: { colA: 0xe3d6a8, colB: 0xc9b37e, colC: 0xf1e8c8, stormCol: 0xf4eedc, bands: 7.0, warp: 0.15, storm: 0.15, spot: 0.0, seed: 2.1 },
  uranus: { colA: 0x9ad6de, colB: 0x7fc4d0, colC: 0xd8f3f6, stormCol: 0x5e9eaa, bands: 3.0, warp: 0.05, storm: 0.0, spot: 0.0, seed: 3.7 },
  neptune: { colA: 0x8db9d8, colB: 0x6fa0c4, colC: 0xd4eaf5, stormCol: 0x4f7fa6, bands: 3.0, warp: 0.12, storm: 0.6, spot: 0.8, seed: 4.2 },
  mercury: { colA: 0xb5b2ad, colB: 0x6e6b66, colC: 0xb5b2ad, cap: 0.0, craterScale: 1.0, seed: 5.1 },
  moon: { colA: 0xa8a6a2, colB: 0x5e5c59, colC: 0xa8a6a2, cap: 0.0, craterScale: 1.4, seed: 9.3 },
  mars: { colA: 0xc1440e, colB: 0x6b2a12, colC: 0xf4eee6, cap: 1.0, craterScale: 0.8, seed: 6.4 },
  venus: { colA: 0xe8cda0, colB: 0xd9b77a, colC: 0xe8cda0, seed: 7.9 },
  earth: { colA: 0x6b93d6, colB: 0x6b93d6, colC: 0x6b93d6, seed: 8.8, city: 0.6 },
};

/**
 * Per-body surface shading look (planetCommon.js planetDiffuse / twilightTint; see the sources there):
 *  - wrap: wrap-lighting extent past the terminator (∝ atmosphere depth: airless 0, Venus 0.3);
 *  - minnaert: Minnaert k (1 = Lambert; the giants and Venus flatten toward the limb; stylised, not fitted);
 *  - twilightWidth / twilight / twilightCol: Gaussian band (in N·L) around the terminator, its strength and tint
 *    (Earth and Venus warm; Mars BLUISH — Martian twilights are blue from forward scattering by dust, Curiosity
 *    sol 956 sunset, NASA/JPL PIA19400);
 *  - nightFloor: fraction of the Sun's irradiance added everywhere so night sides read as dark surfaces rather than
 *    holes (≈ 1 % of the day side after tone mapping; a legibility aid, not earthshine).
 */
export const SHADING_PARAMS = Object.freeze({
  mercury: { wrap: 0.0, minnaert: 1.0, twilightWidth: 0.05, twilight: 0.0, twilightCol: 0xffffff, nightFloor: 0.02 },
  moon: { wrap: 0.0, minnaert: 0.9, twilightWidth: 0.05, twilight: 0.0, twilightCol: 0xffffff, nightFloor: 0.02 },
  venus: { wrap: 0.30, minnaert: 0.8, twilightWidth: 0.20, twilight: 0.25, twilightCol: 0xffd9a8, nightFloor: 0.02 },
  earth: { wrap: 0.10, minnaert: 1.0, twilightWidth: 0.09, twilight: 0.55, twilightCol: 0xff9c5a, nightFloor: 0.02 },
  mars: { wrap: 0.04, minnaert: 1.0, twilightWidth: 0.05, twilight: 0.30, twilightCol: 0x8fb4e0, nightFloor: 0.02 },
  jupiter: { wrap: 0.10, minnaert: 0.8, twilightWidth: 0.07, twilight: 0.20, twilightCol: 0xffd0a0, nightFloor: 0.015 },
  saturn: { wrap: 0.10, minnaert: 0.8, twilightWidth: 0.07, twilight: 0.20, twilightCol: 0xffd0a0, nightFloor: 0.015 },
  uranus: { wrap: 0.14, minnaert: 0.75, twilightWidth: 0.08, twilight: 0.15, twilightCol: 0xbfe8ff, nightFloor: 0.015 },
  neptune: { wrap: 0.14, minnaert: 0.75, twilightWidth: 0.08, twilight: 0.15, twilightCol: 0xbfe8ff, nightFloor: 0.015 },
});
const DEFAULT_SHADING = { wrap: 0.0, minnaert: 1.0, twilightWidth: 0.05, twilight: 0.0, twilightCol: 0xffffff, nightFloor: 0.02 };

/**
 * Atmosphere shells (shaders/atmosphere.js): colour (sRGB), twilight tint, scale height H and vertical optical depth
 * `density` in planet radii, shell radius factor (≈ 1 + 3H, the density is faded to 0 at the top), terminator
 * softness (planet radii), twilight mix and night-limb airglow fraction. Stylised per the brief: Earth blue with
 * H ≈ 0.02 R, Venus thick cream, Mars thin orange (blue twilight, see SHADING_PARAMS), giants pale, ice giants cyan.
 * Bodies missing here get an invisible material.
 */
export const ATMOSPHERE_PARAMS = Object.freeze({
  earth: { color: 0x6ea8ff, twilight: 0xff9a5c, scaleHeight: 0.020, density: 0.10, shell: 1.06, soft: 0.05, twilightMix: 0.6, nightGlow: 0.04, intensity: 1.0 },
  venus: { color: 0xf2dcae, twilight: 0xffc58a, scaleHeight: 0.030, density: 0.35, shell: 1.08, soft: 0.08, twilightMix: 0.3, nightGlow: 0.03, intensity: 1.0 },
  mars: { color: 0xe3a070, twilight: 0x8fb4e0, scaleHeight: 0.012, density: 0.03, shell: 1.04, soft: 0.03, twilightMix: 0.5, nightGlow: 0.02, intensity: 1.0 },
  jupiter: { color: 0xffe2c0, twilight: 0xffc890, scaleHeight: 0.010, density: 0.04, shell: 1.03, soft: 0.03, twilightMix: 0.2, nightGlow: 0.02, intensity: 1.0 },
  saturn: { color: 0xffe8c8, twilight: 0xffc890, scaleHeight: 0.010, density: 0.04, shell: 1.03, soft: 0.03, twilightMix: 0.2, nightGlow: 0.02, intensity: 1.0 },
  uranus: { color: 0xaee9f5, twilight: 0xd2f3ff, scaleHeight: 0.014, density: 0.06, shell: 1.045, soft: 0.04, twilightMix: 0.1, nightGlow: 0.03, intensity: 1.0 },
  neptune: { color: 0x9fd7f0, twilight: 0xcdeeff, scaleHeight: 0.014, density: 0.06, shell: 1.045, soft: 0.04, twilightMix: 0.1, nightGlow: 0.03, intensity: 1.0 },
});

/** Earth cloud deck: shell factor (bodyView scales the cloud mesh by it), the fbm seed shared by the cloud layer and
 * the surface's cloud-shadow lookup, the photographic sheet's width in texels (2k_earth_clouds.jpg is 2048 × 1024)
 * and how dark a full cloud makes the ground beneath (0.55: a bright overcast still shows the land tone). */
export const EARTH_CLOUD_SCALE = 1.006;
export const EARTH_CLOUD_SEED = 12.5;
export const EARTH_CLOUD_TEX_WIDTH = 2048;
export const EARTH_CLOUD_SHADOW = 0.55;

const KIND_GLSL = { gas: GAS_GIANT_GLSL, ice: ICE_GLSL, rocky: ROCKY_GLSL, venus: VENUS_GLSL, earth: EARTH_GLSL };

// Uniforms shared by every planet kind (lighting block) and the per-kind additions.
const SHADING_UNIFORM_DECL =
  'uniform float uWrap;\nuniform float uMinnaertK;\nuniform float uTwilightWidth;\nuniform float uTwilight;\n' +
  'uniform vec3 uTwilightCol;\nuniform float uNightFloor;\nuniform vec3 uSunDirObj;\n';
const KIND_UNIFORM_DECL = {
  gas: 'uniform float uBands;\nuniform float uWarp;\nuniform float uStorm;\nuniform float uSpot;\nuniform vec3 uStormCol;\n' +
    'uniform float uRingShadow;\nuniform float uRingInnerR;\nuniform float uRingOuterR;\nuniform float uRingSeed;\n' +
    'uniform sampler2D uRingTex;\nuniform float uRingTexMix;\nuniform float uPolarRatio;\n',
  ice: 'uniform float uBands;\nuniform float uWarp;\nuniform float uStorm;\nuniform float uSpot;\nuniform vec3 uStormCol;\n',
  rocky: 'uniform float uCap;\nuniform float uCraterScale;\n',
  venus: '',
  earth: 'uniform float uCity;\nuniform sampler2D uNightMap;\nuniform sampler2D uCloudMap;\nuniform float uCloudMix;\n' +
    'uniform float uCloudShadow;\nuniform float uCloudSeed;\n',
};
const KIND_EXTRA_GLSL = { gas: RING_ALPHA_GLSL, ice: '', rocky: '', venus: '', earth: '' };

// Albedo line injected after <color_fragment>; smN / smRough / smCity are declared just before it. The ice giants
// keep a ±6 % band modulation on the photographic maps too (the 2K Uranus/Neptune maps are nearly featureless).
const KIND_COLOR_LINE = {
  gas: 'diffuseColor.rgb *= mix(gasGiant(smN, uTime, uColA, uColB, uColC, uStormCol, uBands, uWarp, uStorm, uSpot, uSeed), vec3(1.0), uTexMix);',
  ice: 'diffuseColor.rgb *= mix(iceGiant(smN, uTime, uColA, uColB, uColC, uStormCol, uBands, uWarp, uStorm, uSpot, uSeed), iceBandMod(smN, uTime, uBands, uWarp, uStorm, uSeed), uTexMix);',
  rocky: 'diffuseColor.rgb *= mix(rocky(smN, uColA, uColB, uColC, uCap, uCraterScale, uSeed), vec3(1.0), uTexMix);',
  venus: 'diffuseColor.rgb *= mix(venusClouds(smN, uTime, uColA, uColB, uSeed), vec3(1.0), uTexMix);',
  earth: 'diffuseColor.rgb *= mix(earthSurface(smN, uSeed, smRough, smCity), vec3(1.0), uTexMix);',
};

// Lighting: three's Lambert direct diffuse is replaced by wrap + Minnaert (planetCommon.js), tinted through the
// twilight band, plus the night floor. Specular (ocean glints) stays as three computed it in RE_Direct_Physical.
const LIGHT_BLOCK = /* glsl */ `
#include <lights_fragment_begin>
#if NUM_POINT_LIGHTS > 0
  vec3 smL = directLight.direction;
  vec3 smLightCol = directLight.color;
#else
  vec3 smL = uSunDirView;
  vec3 smLightCol = vec3(1.0);
#endif
float smNdotL = dot(geometryNormal, smL);
float smNdotV = saturate(dot(geometryNormal, geometryViewDir));
float smDiff = planetDiffuse(smNdotL, smNdotV, uWrap, uMinnaertK);
vec3 smTint = twilightTint(smNdotL, uTwilightWidth, uTwilightCol, uTwilight);
reflectedLight.directDiffuse = smLightCol * (smDiff * smTint + vec3(uNightFloor)) * BRDF_Lambert(material.diffuseContribution);
`;

// Earth: cloud shadows. The cloud that shades surface point n lies where the Sun ray through n crosses the cloud
// deck at height h = EARTH_CLOUD_SCALE − 1: n + (h / μ0)·L (μ0 = N·L, floored so low-Sun shadows stretch but stay
// finite). Coverage comes from the same fbm (procedural) or the same photographic sheet (uCloudMap, luminance →
// coverage exactly as in createEarthCloudMaterial) as the cloud layer itself, so shadows sit under their clouds.
const EARTH_SHADOW_BLOCK = /* glsl */ `
{
  float smMu0 = max(dot(smN, uSunDirObj), 0.08);
  vec3 smNc = normalize(smN + (${(EARTH_CLOUD_SCALE - 1).toFixed(4)} / smMu0) * uSunDirObj);
  float smLod = equirectLod(smNc, ${EARTH_CLOUD_TEX_WIDTH.toFixed(1)});
  float smCov = earthCloudAlpha(smNc, uTime, uCloudSeed);
  vec3 smPhotoCloud = texture2DLodEXT(uCloudMap, planetEquirectUv(smNc), max(smLod, 0.0)).rgb;
  smCov = mix(smCov, smoothstep(0.06, 0.55, dot(smPhotoCloud, vec3(0.3333))), uCloudMix);
  float smSh = 1.0 - uCloudShadow * smCov;
  reflectedLight.directDiffuse *= smSh;
  reflectedLight.directSpecular *= smSh;
}
`;

// Saturn: the rings' shadow on the globe. The surface point in spin-frame units of R_eq is (n.x, n.y, n.z·c/a); the
// ray toward the Sun meets the ring plane z = 0 at t = −P.z / L.z (t > 0: the plane lies between the point and the
// Sun), and the ring opacity at that radius (shared RING_ALPHA_GLSL law, photographic strip when loaded) is how
// much sunlight the rings take away (0.92: a little light scatters through even the B ring). The branch is on a
// uniform (uRingShadow), so control flow stays uniform and fwidth() / the strip's texture fetch inside it have
// well-defined derivatives; the per-fragment "is the ring plane between this point and the Sun" test is a factor.
const GAS_SHADOW_BLOCK = /* glsl */ `
if (uRingShadow > 0.5) {
  vec3 smP = vec3(smN.xy, smN.z * uPolarRatio);
  float smLz = uSunDirObj.z;
  float smLzSafe = (abs(smLz) > 1e-4) ? smLz : 1e-4;
  float smT = -smP.z / smLzSafe;
  vec2 smHit = smP.xy + max(smT, 0.0) * uSunDirObj.xy;
  float smRr = length(smHit);
  float smFw = fwidth(smRr);
  float smA = ringOpticalAlpha(smRr, uRingInnerR, uRingOuterR, uRingSeed, smFw, uRingTex, uRingTexMix);
  float smOn = (smT > 0.0 && abs(smLz) > 1e-4) ? 1.0 : 0.0;
  float smSh = 1.0 - 0.92 * smA * smOn;
  reflectedLight.directDiffuse *= smSh;
  reflectedLight.directSpecular *= smSh;
}
`;

// Night-side city lights (Earth only), slightly warm (sodium / LED mix). Gate on the actual point light when the
// scene has one; else on uSunDirView.
const EARTH_EMISSIVE_BLOCK = /* glsl */ `
{
  #if NUM_POINT_LIGHTS > 0
    vec3 smSunDir = normalize(pointLights[0].position + vViewPosition);
  #else
    vec3 smSunDir = uSunDirView;
  #endif
  float smNight = 1.0 - smoothstep(-0.08, 0.12, dot(normal, smSunDir));
  vec3 smLights = vec3(1.0, 0.72, 0.42) * (smCity * uCity);
  #if defined( USE_MAP )
    // Photographic mode: NASA's "Earth at night" composite, gated to the unlit hemisphere, warmed a little.
    smLights = mix(smLights, texture2D(uNightMap, vMapUv).rgb * vec3(1.0, 0.9, 0.76) * uCity * 1.6, uTexMix);
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
 * Per frame (bodyView.js): uSunDirView (unit body→Sun, view space), uSunDirObj (unit body→Sun, spin frame);
 * Earth also mirrors the cloud layer's map / mix into uCloudMap / uCloudMix, Saturn the ring strip into
 * uRingTex / uRingTexMix (setRingShadow() switches the ring shadow on).
 * @param {string} id body id ('mercury' … 'neptune', 'moon')
 * @param {{ flat?: boolean, colour?: number }} [opts] flat: plain colour fallback material; colour: the bodyDef colour
 * @returns {MeshStandardMaterial}
 */
export function createPlanetMaterial(id, opts = {}) {
  const kind = PLANET_KIND[id];
  if (opts.flat || !kind) return createFlatMaterial(id, opts.colour);
  const p = PLANET_PARAMS[id];
  const sh = SHADING_PARAMS[id] ?? DEFAULT_SHADING;
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
    uSunDirObj: { value: new Vector3(0, 0, 1) },
    uTexMix: { value: 0 }, // 0 = procedural surface, 1 = photographic map (set by applyTexture)
    uWrap: { value: sh.wrap },
    uMinnaertK: { value: sh.minnaert },
    uTwilightWidth: { value: sh.twilightWidth },
    uTwilight: { value: sh.twilight },
    uTwilightCol: colorUniform(sh.twilightCol),
    uNightFloor: { value: sh.nightFloor },
  };
  if (kind === 'gas' || kind === 'ice') {
    uniforms.uStormCol = colorUniform(p.stormCol);
    uniforms.uBands = { value: p.bands };
    uniforms.uWarp = { value: p.warp };
    uniforms.uStorm = { value: p.storm };
    uniforms.uSpot = { value: p.spot };
  }
  if (kind === 'gas') {
    uniforms.uRingShadow = { value: 0 };
    uniforms.uRingInnerR = { value: 1.239 };
    uniforms.uRingOuterR = { value: 2.27 };
    uniforms.uRingSeed = { value: 2.0 };
    uniforms.uRingTex = { value: null };
    uniforms.uRingTexMix = { value: 0 };
    uniforms.uPolarRatio = { value: 1 };
  } else if (kind === 'rocky') {
    uniforms.uCap = { value: p.cap };
    uniforms.uCraterScale = { value: p.craterScale };
  } else if (kind === 'earth') {
    uniforms.uCity = { value: p.city };
    uniforms.uNightMap = { value: null };
    uniforms.uCloudMap = { value: null };
    uniforms.uCloudMix = { value: 0 };
    uniforms.uCloudShadow = { value: EARTH_CLOUD_SHADOW };
    uniforms.uCloudSeed = { value: EARTH_CLOUD_SEED };
  }
  mat.userData.uniforms = uniforms;
  mat.userData.kind = kind;
  mat.userData.bodyId = id;
  mat.userData.colour = opts.colour ?? BODY_COLOUR[id] ?? 0x9aa0a6;

  const fragmentHead =
    '#include <common>\n' +
    'varying vec3 vObj;\n' +
    'uniform float uTime;\nuniform float uSeed;\nuniform vec3 uColA;\nuniform vec3 uColB;\nuniform vec3 uColC;\n' +
    'uniform vec3 uSunDirView;\nuniform float uTexMix;\n' +
    SHADING_UNIFORM_DECL +
    KIND_UNIFORM_DECL[kind] +
    NOISE3D_GLSL +
    PLANET_COMMON_GLSL +
    KIND_EXTRA_GLSL[kind] +
    KIND_GLSL[kind];
  const colorBlock =
    '#include <color_fragment>\n' +
    'vec3 smN = normalize(vObj);\nfloat smRough = roughness;\nfloat smCity = 0.0;\n' +
    KIND_COLOR_LINE[kind] + '\n';
  const lightBlock = LIGHT_BLOCK + (kind === 'earth' ? EARTH_SHADOW_BLOCK : kind === 'gas' ? GAS_SHADOW_BLOCK : '');

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectVertexObj(shader.vertexShader);
    let fs = shader.fragmentShader
      .replace('#include <common>', fragmentHead)
      .replace('#include <color_fragment>', colorBlock)
      .replace('#include <lights_fragment_begin>', lightBlock);
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
 * Switch on the rings' shadow for a 'gas' planet material (Saturn). Radii in planet radii, as the ring material.
 * @param {import('three').Material} material  a createPlanetMaterial('saturn') material
 * @param {{ innerR: number, outerR: number, polarRatio?: number, seed?: number }} spec
 * @returns {boolean} whether the material supports it
 */
export function setRingShadow(material, spec) {
  const u = material?.userData?.uniforms;
  if (!u || !u.uRingShadow) return false;
  u.uRingShadow.value = 1;
  u.uRingInnerR.value = spec.innerR;
  u.uRingOuterR.value = spec.outerR;
  u.uPolarRatio.value = spec.polarRatio ?? 1;
  if (spec.seed !== undefined) u.uRingSeed.value = spec.seed;
  return true;
}

/**
 * Flat-colour fallback (plan: "Flat-colour fallback material behind a flag").
 * @param {string} id
 * @param {number} [colour] the bodyDef colour; BODY_COLOUR[id] when omitted
 * @returns {MeshStandardMaterial}
 */
export function createFlatMaterial(id, colour = undefined) {
  const hex = colour ?? BODY_COLOUR[id] ?? 0x9aa0a6;
  const mat = new MeshStandardMaterial({ color: hex, roughness: 0.9, metalness: 0 });
  mat.userData.uniforms = {};
  mat.userData.kind = 'flat';
  mat.userData.bodyId = id;
  mat.userData.colour = hex;
  return mat;
}

/**
 * Earth cloud layer (mesh at EARTH_CLOUD_SCALE·R, spinning with the surface; slow periodic FBM drift, no
 * super-rotation). The surface material reads the same coverage for its cloud shadows (EARTH_SHADOW_BLOCK).
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
  const uniforms = { uTime: { value: 0 }, uSeed: { value: EARTH_CLOUD_SEED }, uTexMix: { value: 0 } };
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
 * This is the FALLBACK Sun glare: bodyView.js uses `materials.createSunGlare` (the HDR billboard of
 * shaders/sunFlare.js, provided through the materials object by main.js) when it exists and these sprites otherwise.
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
 * Atmosphere shell material (shaders/atmosphere.js): ONE FrontSide shell at uShell·R, additive, depthWrite off, an
 * exponential scale-height atmosphere ray-marched per fragment. Bodies without an atmosphere (mercury, moon, sun)
 * get a material with `visible = false` and zero intensity so callers need not special-case.
 * Per frame (bodyView.js): uSunDirObj (unit body→Sun in the planet frame), uCamPosObj (camera position in planet
 * units: spin frame divided by the (a, a, c) display scale). The mesh must be scaled by uShell (read it back from
 * `material.userData.uniforms.uShell.value`).
 * @param {string} id
 * @returns {ShaderMaterial}
 */
export function createAtmosphereMaterial(id) {
  const p = ATMOSPHERE_PARAMS[id];
  const uniforms = {
    uColor: colorUniform(p ? p.color : 0xffffff),
    uTwilightColor: colorUniform(p ? p.twilight : 0xffffff),
    uScaleHeight: { value: p ? p.scaleHeight : 0.02 },
    uDensity: { value: p ? p.density : 0.0 },
    uShell: { value: p ? p.shell : 1.03 },
    uTerminatorSoft: { value: p ? p.soft : 0.04 },
    uTwilight: { value: p ? p.twilightMix : 0.0 },
    uNightGlow: { value: p ? p.nightGlow : 0.0 },
    uIntensity: { value: p ? p.intensity : 0.0 },
    uSunDirObj: { value: new Vector3(0, 0, 1) },
    uCamPosObj: { value: new Vector3(0, 0, 10) },
    uSunDirView: { value: new Vector3(0, 0, 1) }, // kept for setMaterialSunDir() callers; the shader uses uSunDirObj
  };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: ATMOSPHERE_VERTEX,
    fragmentShader: ATMOSPHERE_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: FrontSide,
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
 * Marker Points material (attributes aSize [CSS px], aAlpha, aIntensity, aColor; uniform uPixelRatio). Premultiplied
 * additive, as shaders/markers.js outputs. Kept for API compatibility: markers.js builds its glow material in
 * skyMaterials.js.
 * @returns {ShaderMaterial}
 */
export function createMarkerMaterial() {
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
  mat.userData.kind = 'markers';
  return mat;
}

/**
 * Star Points material (attributes aSize [CSS px], aColor; uniforms uPixelRatio, uFovScale, uTime, uTwinkle = 0).
 * Premultiplied additive, as shaders/stars.js outputs. Kept for API compatibility: stars.js builds its sky
 * materials in skyMaterials.js.
 * @returns {ShaderMaterial}
 */
export function createStarMaterial() {
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
  mat.userData.kind = 'stars';
  return mat;
}

/**
 * Warp streak LineSegments material (attributes aTail 0/1, aColor; uniforms uVelDir [unit, world],
 * uStreak 0…0.6, uPixelRatio). Premultiplied additive, no depth test.
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
    premultipliedAlpha: true,
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

// The Milky Way as a faint luminous band on an inverted far sphere that follows the camera.
//
// Two programs:
//  1. MILKY_WAY_BAKE_*: renders the band ONCE into a 1024×512 half-float equirectangular texture in GALACTIC
//     coordinates (u = l/2π + ½, v = b/π + ½). Everything expensive (6-octave fbm clouds, ridged dust lanes) runs
//     once at start-up instead of per frame; the texture is seamless in longitude because the noise is sampled on
//     the 3-D unit direction, not on (u, v).
//  2. MILKY_WAY_*: the sphere shader converts the view direction to (l, b) with the galactic basis uniforms
//     (uGalCentre = x, uGalY = y, uGalPole = z, from src/astro/sky.js) and samples the texture, × uIntensity.
//
// Model (qualitative, tuned to look like a dark-sky photograph, not a surface-brightness map):
//  - thin disc  exp(−(b/9°)²) and a thick/halo term 0.35·exp(−(b/22°)²): the visual band is ~10° half-width
//    (Binney & Merrifield, Galactic Astronomy §10.4: thin-disc scale height ≈ 300 pc seen from inside);
//  - longitude term 0.45 + 0.55·((1 + cos l)/2)^1.4: the Sun is 8 kpc from the centre, so the band is brightest
//    toward Sagittarius (l = 0) and faintest toward the anticentre in Auriga (l = 180°);
//  - bulge 0.8·exp(−(l/18°)² − (b/11°)²);
//  - fbm cloud structure and a ridged-noise dust mask within |b| ≲ 5° (the Great Rift from Cygnus to Sagittarius);
//  - colour: warm (1.0, 0.86, 0.68) toward the centre (old stars + reddening), cool (0.72, 0.82, 1.0) outward.
// The baked peak is ≈ 1.3; uIntensity 0.09 puts the band at 0.04–0.12 linear, well under the bloom threshold.
// Output is premultiplied; the sphere material is additive (ONE, ONE), depthWrite off, BackSide.

import { NOISE3D_GLSL } from './noise3d.js';
import { PLANET_COMMON_GLSL } from './planetCommon.js';

export const MILKY_WAY_BAKE_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const MILKY_WAY_BAKE_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uSeed;
varying vec2 vUv;
${NOISE3D_GLSL}
${PLANET_COMMON_GLSL}
void main() {
  float l = (vUv.x - 0.5) * 6.283185307179586;      // galactic longitude, centre column = l 0
  float b = (vUv.y - 0.5) * 3.141592653589793;      // galactic latitude
  float cb = cos(b);
  vec3 d = vec3(cb * cos(l), cb * sin(l), sin(b));  // unit direction in the galactic frame: seamless noise domain
  float bDeg = b * 57.29577951308232;
  float lDeg = l * 57.29577951308232;

  float thin = exp(-pow(bDeg / 9.0, 2.0));
  float thick = 0.35 * exp(-pow(bDeg / 22.0, 2.0));
  float towardCentre = 0.45 + 0.55 * pow(0.5 + 0.5 * cos(l), 1.4);
  float bulge = 0.8 * exp(-pow(lDeg / 18.0, 2.0) - pow(bDeg / 11.0, 2.0));

  float c1 = fbm(d * 5.0 + uSeed);                    // large cloud complexes, [-1, 1]
  float c2 = fbm4(d * 14.0 + uSeed * 1.7);            // finer mottling
  float clouds = clamp(0.62 + 0.38 * c1 + 0.18 * c2, 0.0, 1.6);

  // dust: ridged noise stretched along the plane (×3 in the plane, ×9 across it) masked to |b| ≲ 5°, with the edge
  // itself wobbled by c2 so the rift is ragged rather than a straight slot
  float rift = fbmRidged(vec3(d.x * 3.0, d.y * 3.0, d.z * 9.0) + uSeed * 2.3);
  float dustMask = exp(-pow((bDeg + 1.5 * c2) / 4.5, 2.0));
  float dust = smoothstep(0.42, 0.72, rift) * dustMask * (0.55 + 0.45 * towardCentre);

  float band = (thin + thick) * towardCentre * clouds + bulge * (0.7 + 0.3 * clouds);
  band *= 1.0 - 0.85 * dust;
  band = max(band, 0.0);

  vec3 warm = vec3(1.0, 0.86, 0.68);
  vec3 cool = vec3(0.72, 0.82, 1.0);
  vec3 col = mix(cool, warm, clamp(towardCentre * 0.8 + bulge, 0.0, 1.0));
  gl_FragColor = vec4(col * band, 1.0);
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const MILKY_WAY_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = position;                                   // unit sphere scaled by the object: direction == position
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const MILKY_WAY_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
uniform vec3 uGalPole;
uniform vec3 uGalCentre;
uniform vec3 uGalY;
uniform float uIntensity;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float x = dot(d, uGalCentre);
  float y = dot(d, uGalY);
  float z = dot(d, uGalPole);
  float rxy = length(vec2(x, y));
  float l = rxy > 1e-7 ? atan(y, x) : 0.0;           // atan(0, 0) is undefined in GLSL: guard the galactic poles
  float b = atan(z, rxy);
  vec2 uv = vec2(l / 6.283185307179586 + 0.5, b / 3.141592653589793 + 0.5);
  vec3 c = texture2D(uMap, uv).rgb * uIntensity;
  gl_FragColor = vec4(c, 1.0);
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

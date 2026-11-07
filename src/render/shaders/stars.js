// Catalogue starfield: Points with a per-star diameter (aSize, CSS px from the display law in src/astro/sky.js:
// 1.2–5 px for V 6.5 … −1.5) and a per-star LINEAR colour already multiplied by the intensity law (aColor,
// B−V → RGB × 0.22 … 1.9 — HDR for the brightest so the bloom pass catches Sirius, Canopus, Vega …).
// The disc is a soft Gaussian (σ = 0.38 of the half-size) windowed to zero at the quad edge; points of 1–2 device px
// bypass the falloff so the lone fragment keeps the star's full intensity (the "faint stars nearly invisible" defect:
// a radial falloff sampled at a single fragment centre is fine, but the old shader also multiplied colour × mag × a).
// uFovScale enlarges every point a little in narrow sky views (fov < 50°). uTwinkle stays 0 by default (reduced
// motion keeps it off). Output is PREMULTIPLIED (material: additive, premultipliedAlpha true → ONE, ONE).
// The Points object follows the camera (5 000 AU sphere), frustumCulled false; log depth so planets occlude stars.

export const STAR_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSize;
attribute vec3 aColor;
uniform float uPixelRatio;
uniform float uFovScale;
uniform float uTime;
uniform float uTwinkle;
varying vec3 vColor;
varying float vSize;
float starHash(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = aSize * uFovScale * uPixelRatio;
  gl_PointSize = max(size, 1.0);
  vSize = gl_PointSize;
  float h = starHash(position);
  float tw = 1.0 - uTwinkle * 0.5 * (0.5 + 0.5 * sin(uTime * (3.0 + 4.0 * h) + h * 40.0));
  vColor = aColor * tw;
  #include <logdepthbuf_vertex>
}
`;

export const STAR_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vSize;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  // Gaussian disc: exp(-r² / (2 σ²)) with σ = 0.38 → exp(-3.46 r²); windowed so the quad corners are exactly 0.
  float a = exp(-3.46 * r2) * (1.0 - smoothstep(0.7, 1.0, r2));
  // 1–2 device-px points: the single fragment sits near the centre; flatten the profile so faint stars keep their intensity.
  a = mix(1.0, a, smoothstep(1.0, 2.5, vSize));
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * a, a);
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

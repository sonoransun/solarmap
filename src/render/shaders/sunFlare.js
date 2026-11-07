// Sun glare: one HDR billboard quad through the Sun's centre, view-aligned in the vertex shader (the quad is a child
// of the Sun anchor; `modelViewMatrix × origin` gives the centre in view space and the corners are offset in view
// space by uHalfSize world units, so it faces the camera whatever the parent's rotation). Quad coordinates p ∈ [−1, 1]²
// (vP); r = |p|. uDiscR is the photosphere's radius in those units (sunPxRadius / halfPx).
//
// Components (all linear, additive, premultiplied; uIntensity ≈ 1, uSuppress fades everything for close-ups):
//  - core: Gaussian exp(−r²/2σ²), σ = 0.09, peak 3.0 → bloom catches it from any distance ("presence");
//  - skirt: Moffat wings 0.35 / (1 + (r/0.16)^2.2) — the power-law halo of an over-exposed point source
//    (Moffat 1969, A&A 3, 455; β ≈ 1.1 is the long-tail "glare" regime);
//  - six diffraction spikes cos⁴⁸(3θ)·e^(−3r), the pattern of a hexagonal aperture / iris, at low amplitude 0.55;
//  - anamorphic streak: horizontal Gaussian in p.y (σ 0.012) × e^(−2.6|x|), amplitude 0.3 (cinematic cue);
//  - corona streamers: 4-octave fbm over the angle (periodic by construction: sampled on (cos θ, sin θ)) and r,
//    drifting with loopDrift(uTime) — seamless at the 1e4 s wrap — radially decaying from the limb outward.
// The whole quad is windowed to 0 by r = 1 so the square never shows. Log depth + depthTest ON (depthWrite off): the
// photosphere occludes the centre when the disc is on screen, so the glare is seen around the limb, as it should be.

import { NOISE3D_GLSL } from './noise3d.js';
import { PLANET_COMMON_GLSL } from './planetCommon.js';

export const SUN_FLARE_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uHalfSize;
varying vec2 vP;
void main() {
  vP = position.xy;                                          // PlaneGeometry(2, 2): corners at ±1
  vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  centre.xy += position.xy * uHalfSize;                      // view-aligned billboard through the Sun's centre
  gl_Position = projectionMatrix * centre;
  #include <logdepthbuf_vertex>
}
`;

export const SUN_FLARE_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uIntensity;
uniform float uSuppress;
uniform float uDiscR;
uniform float uSpikeRot;
varying vec2 vP;
${NOISE3D_GLSL}
${PLANET_COMMON_GLSL}
void main() {
  vec2 p = vP;
  float r2 = dot(p, p);
  float r = sqrt(r2);
  float th = r > 1e-6 ? atan(p.y, p.x) : 0.0;        // atan(0, 0) is undefined in GLSL: guard the centre fragment

  float core = exp(-r2 / (2.0 * 0.09 * 0.09));
  float skirt = 0.35 / (1.0 + pow(r / 0.16, 2.2));
  float spikes = pow(abs(cos(3.0 * th + uSpikeRot)), 48.0) * exp(-r * 3.0) * 0.55;
  float streak = exp(-p.y * p.y / (2.0 * 0.012 * 0.012)) * exp(-abs(p.x) * 2.6) * 0.3;

  vec3 q = vec3(cos(th), sin(th), 0.0) * 2.5 + vec3(0.0, 0.0, r * 2.0) + loopDrift(uTime, 0.6, 2.0);
  float s = fbm4(q);                                                                  // [-1, 1]
  float fromLimb = max(r - uDiscR, 0.0);
  float streamers = pow(clamp(0.5 + 0.5 * s, 0.0, 1.0), 2.5) * exp(-fromLimb * 4.0) * smoothstep(uDiscR * 0.85, uDiscR * 1.05 + 0.002, r) * 0.6;

  float win = 1.0 - smoothstep(0.75, 1.0, r);
  vec3 col = vec3(1.0, 0.93, 0.80) * (core * 3.0 + skirt)
           + vec3(1.0, 0.86, 0.66) * (spikes + streak)
           + vec3(1.0, 0.80, 0.55) * streamers;
  col *= uIntensity * (1.0 - uSuppress) * win;
  gl_FragColor = vec4(col, 1.0);
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

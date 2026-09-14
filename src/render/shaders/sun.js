// Sun surface: unlit ShaderMaterial with HDR output (≈2–5 linear) so the bloom pass (threshold 1.0) picks
// it up; granulation fbm drifting with uTime, ridged fine cells, limb term. Plan §Rendering "Sun".
// Log depth + tone-mapping chunks per CLAUDE.md (r186 chunk names verified in ShaderChunk/*.glsl.js).
import { NOISE3D_GLSL } from './noise3d.js';
import { PLANET_COMMON_GLSL } from './planetCommon.js';

export const SUN_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vObj;
varying vec3 vN;
varying vec3 vV;
void main() {
  vObj = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const SUN_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uIntensity;
uniform float uSeed;
uniform sampler2D uMap;      // optional photographic granulation (SDO/NASA composite via Solar System Scope)
uniform float uTexMix;       // 0 = procedural only, 1 = photograph modulated by the animated field
varying vec3 vObj;
varying vec3 vN;
varying vec3 vV;
${NOISE3D_GLSL}
${PLANET_COMMON_GLSL}
void main() {
  vec3 n = normalize(vObj);
  vec3 d = loopDrift(uTime, 1.5, 32.0);
  float g = fbm(n * 3.0 + d + uSeed) * 0.5 + 0.5;                 // granulation drift
  float g2 = fbmRidged(n * 9.0 - d * 0.6 + uSeed);                // fine cells
  float cells = smoothstep(0.35, 0.95, g2);
  vec3 base = mix(vec3(1.0, 0.45, 0.05), vec3(1.0, 0.85, 0.45), clamp(g * 0.7 + cells * 0.3, 0.0, 1.0));
  float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
  float limb = pow(1.0 - mu, 2.0);                                // limb brightening (chromosphere tint)
  float dark = 0.75 + 0.25 * mu;                                  // mild photospheric limb darkening
  vec3 col = base * (2.2 + 1.2 * cells) * dark + limb * vec3(1.0, 0.6, 0.2) * 1.5;   // HDR ≈ 1.6–5
  if (uTexMix > 0.001) {
    // Equirectangular lookup: local +Z is the spin axis, u = 0.5 at the prime meridian (matches SphereGeometry).
    vec2 uv = vec2(atan(n.y, n.x) / 6.2831853 + 0.5, asin(clamp(n.z, -1.0, 1.0)) / 3.14159265 + 0.5);
    vec3 photo = texture2D(uMap, uv).rgb;
    // Keep the surface alive: the animated granulation modulates the photograph rather than replacing its detail.
    vec3 photoHdr = photo * (2.6 + 1.0 * cells) * dark + limb * vec3(1.0, 0.6, 0.2) * 1.5;
    col = mix(col, photoHdr, uTexMix);
  }
  gl_FragColor = vec4(col * uIntensity, 1.0);
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

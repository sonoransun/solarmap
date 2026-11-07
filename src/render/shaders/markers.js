// Body markers as brightness-driven glows: one Points draw call; gl_PointSize = aSize · uPixelRatio (CSS px →
// device px). Per vertex: aAlpha (disc cross-fade + selection), aColor (body colour, linear), aIntensity (HDR level
// from the apparent-magnitude law in markers.js: 0.7 for Neptune … 2.6 for Venus). Profile in quad units r ∈ [0, 1]:
//   core  exp(−r²/2σ²), σ = 0.11 — a crisp dot whose colour is pulled 55 % toward white (an over-exposed point source
//         loses saturation; it also lifts the luminance over the bloom threshold for dark body colours such as Mars);
//   glow  0.45·exp(−r²/2σ²), σ = 0.32 — the soft halo in the body's own colour;
//   skirt 0.08·(1 − r) — a wide faint fringe out to the quad edge;
// windowed to 0 at r = 1 so a GPU that clamps gl_PointSize only shrinks the halo (gl_PointCoord spans the clamped
// quad), never clips it to a square. Premultiplied additive output; log depth so a marker behind a nearby planet is
// hidden (depthTest on, depthWrite off).

export const MARKER_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSize;
attribute float aAlpha;
attribute float aIntensity;
attribute vec3 aColor;
uniform float uPixelRatio;
varying float vAlpha;
varying float vIntensity;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio;
  vAlpha = aAlpha;
  vIntensity = aIntensity;
  vColor = aColor;
  #include <logdepthbuf_vertex>
}
`;

export const MARKER_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vAlpha;
varying float vIntensity;
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  float r = sqrt(r2);
  float core = exp(-r2 / (2.0 * 0.11 * 0.11));
  float glow = 0.45 * exp(-r2 / (2.0 * 0.32 * 0.32));
  float skirt = 0.08 * max(1.0 - r, 0.0);
  float win = 1.0 - smoothstep(0.85, 1.0, r);
  float a = (core + glow + skirt) * win * vAlpha;
  if (a < 0.003) discard;
  vec3 coreCol = mix(vColor, vec3(1.0), 0.55);
  vec3 col = (coreCol * core + vColor * (glow + skirt)) * vIntensity * win * vAlpha;
  gl_FragColor = vec4(col, a);
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Screen-space body markers: one Points draw call; gl_PointSize = aSize * uPixelRatio (CSS px → device px),
// soft disc + thin halo ring, per-vertex alpha / colour. Log-depth chunks so a marker behind a nearby planet
// is hidden (depthTest on, depthWrite off). Research §2.3.

export const MARKER_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uPixelRatio;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio;
  vAlpha = aAlpha;
  vColor = aColor;
  #include <logdepthbuf_vertex>
}
`;

export const MARKER_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  float disc = 1.0 - smoothstep(0.55, 0.75, r);                                  // soft-edged dot
  float ring = smoothstep(0.80, 0.85, r) * (1.0 - smoothstep(0.95, 1.0, r));   // thin halo ring
  float a = (disc + 0.55 * ring) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

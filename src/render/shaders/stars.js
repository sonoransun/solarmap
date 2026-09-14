// Seeded starfield: Points with a fixed pixel size (aSize CSS px * uPixelRatio), tinted colour, optional
// twinkle (uTwinkle = 0 by default; reduced motion keeps it off). The Points object follows the camera
// (5,000 AU sphere), frustumCulled false. Research §8.

export const STAR_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSize;
attribute vec3 aColor;
uniform float uPixelRatio;
uniform float uTime;
uniform float uTwinkle;
varying vec3 vColor;
varying float vAlpha;
float starHash(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(aSize * uPixelRatio, 1.0);
  float h = starHash(position);
  float tw = 1.0 - uTwinkle * 0.5 * (0.5 + 0.5 * sin(uTime * (3.0 + 4.0 * h) + h * 40.0));
  vColor = aColor;
  vAlpha = tw;
  #include <logdepthbuf_vertex>
}
`;

export const STAR_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  float a = (1.0 - smoothstep(0.35, 1.0, r)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a, a);
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

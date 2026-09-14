// Warp star streaks: LineSegments sharing the star directions (2 vertices per star, aTail = 0 head / 1 tail).
// The tail slides along the component of -uVelDir perpendicular to the star direction by aTail * uStreak, so
// streak length ∝ sin(angle from the motion axis): a radial "vanishing point" with no per-star CPU work.
// Additive, depthTest off. Research §3.6. uVelDir = unit camera velocity in WORLD space (the object is
// centred on the camera with no rotation, so world == object direction).

export const STREAK_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aTail;
attribute float aMag;
attribute vec3 aColor;
uniform vec3 uVelDir;
uniform float uStreak;
uniform float uPixelRatio;
varying float vA;
varying vec3 vC;
void main() {
  float radius = length(position);
  vec3 d = position / max(radius, 1e-6);                       // star direction on the sky sphere
  vec3 perp = -uVelDir + dot(uVelDir, d) * d;                  // component of -v perpendicular to d
  vec3 p = normalize(d + aTail * uStreak * perp) * radius;     // tail slides toward the anti-velocity pole
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float boost = 0.75 + 0.25 * clamp(uPixelRatio, 1.0, 2.0);   // 1-px lines are thinner on HiDPI: brighten
  vA = (1.0 - aTail) * aMag * boost * clamp(uStreak / 0.05, 0.0, 1.0);   // head bright, tail fades to 0
  vC = aColor;
  #include <logdepthbuf_vertex>
}
`;

export const STREAK_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vA;
varying vec3 vC;
void main() {
  gl_FragColor = vec4(vC * vA, vA);
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

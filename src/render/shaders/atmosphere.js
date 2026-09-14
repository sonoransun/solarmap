// Atmosphere halo: BackSide shell at uShell·R (1.02 by default), additive, depthWrite off. Brightness rises
// from the shell silhouette toward the planet limb (pow(x, uPower)) and is modulated by a soft day-side
// factor from uSunDirView (unit vector body→Sun in VIEW space, updated per frame by the render core).
// Colours/powers per plan: Earth #6EA8FF p3, Venus #F2D9A6 p2.5, Mars #E7A87A p4, Jupiter/Saturn #FFE7C2 p4.5,
// Uranus/Neptune #A8E6FF p3.5.

export const ATMOSPHERE_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const ATMOSPHERE_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uPower;
uniform float uIntensity;
uniform float uShell;        // shell radius / planet radius (1.02)
uniform vec3 uSunDirView;    // unit, view space, body -> Sun
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  // For the back faces seen outside the planet disc |dot(n, v)| runs from 0 (shell silhouette) to
  // muLimb (where the line of sight grazes the planet); x = 0 at the silhouette, 1 at the planet limb.
  float mu = abs(dot(n, v));
  float muLimb = sqrt(max(1.0 - 1.0 / (uShell * uShell), 1e-4));
  float x = clamp(mu / muLimb, 0.0, 1.0);
  float f = pow(x, uPower);
  float day = 0.15 + 0.85 * clamp(dot(n, uSunDirView) * 1.5 + 0.5, 0.0, 1.0);   // lit side stronger, soft terminator
  gl_FragColor = vec4(uColor * uIntensity, f * day);   // additive blending: rgb * alpha is what is added
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

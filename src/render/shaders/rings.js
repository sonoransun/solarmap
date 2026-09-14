// Saturn rings on RingGeometry(innerR, outerR, 256) in PLANET RADII (Req = 60,268 km), z = 0 plane =
// equator (the mesh is a child of the spin node). Radial-distance shader, NSSDC ring fact sheet
// (https://nssdc.gsfc.nasa.gov/planetary/factsheet/satringfact.html): C 74,658–91,975 km (1.239–1.526 R),
// B 91,975–117,507 km (1.526–1.950 R), A 122,340–136,780 km (2.030–2.270 R), Encke gap 133,410 km (2.214 R),
// Keeler gap 136,487 km (2.265 R), Maxwell gap 87,491 km (1.452 R); Cassini division = the B–A gap.
// Uniforms updated per frame by the render core (object space of the ring mesh, planet-radius units):
//   uSunDirObj  unit vector planet -> Sun ; uCamPosObj camera position (worldToLocal of the ring mesh).
import { NOISE3D_GLSL } from './noise3d.js';

export const RINGS_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vObj;
void main() {
  vObj = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const RINGS_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunDirObj;
uniform vec3 uCamPosObj;
uniform float uPolarRatio;   // polar / equatorial radius of the planet (Saturn 0.902) for the shadow ellipsoid
uniform float uOpacity;
uniform float uSeed;
uniform float uInnerR;
uniform float uOuterR;
uniform sampler2D uRingTex;  // optional photographic ring strip (radial: u = (r − inner)/(outer − inner))
uniform float uTexMix;
varying vec3 vObj;
${NOISE3D_GLSL}
float gapDip(float r, float c, float w) { return 1.0 - smoothstep(0.0, w, abs(r - c)); }
float ringAlpha(float r) {
  float a = 0.0;
  a += smoothstep(1.239, 1.26, r) * (1.0 - smoothstep(1.50, 1.526, r)) * 0.35;    // C ring (dim)
  a += smoothstep(1.526, 1.54, r) * (1.0 - smoothstep(1.93, 1.950, r)) * 0.95;    // B ring (bright)
  a += smoothstep(2.030, 2.045, r) * (1.0 - smoothstep(2.25, 2.270, r)) * 0.65;   // A ring
  a *= 1.0 - 0.85 * gapDip(r, 2.214, 0.004);                                      // Encke gap
  a *= 1.0 - 0.70 * gapDip(r, 2.265, 0.0025);                                     // Keeler gap
  a *= 1.0 - 0.50 * gapDip(r, 1.452, 0.006);                                      // Maxwell gap
  float fine = snoise(vec3(r * 140.0, uSeed, 0.0)) * 0.5 + snoise(vec3(r * 420.0, uSeed + 3.0, 0.0)) * 0.25;
  a *= 0.8 + 0.2 * fine;                                                          // fine ringlets
  a *= smoothstep(uInnerR, uInnerR + 0.01, r) * (1.0 - smoothstep(uOuterR - 0.01, uOuterR, r));
  return clamp(a, 0.0, 1.0);
}
vec3 ringColour(float r) {
  vec3 cC = vec3(0.62, 0.60, 0.58);
  vec3 cB = vec3(0.86, 0.80, 0.66);
  vec3 cA = vec3(0.80, 0.75, 0.63);
  vec3 col = mix(cC, cB, smoothstep(1.50, 1.54, r));
  return mix(col, cA, smoothstep(1.95, 2.03, r));
}
void main() {
  float r = length(vObj.xy);
  float a = ringAlpha(r) * uOpacity;
  vec3 baseCol = ringColour(r);
  if (uTexMix > 0.001) {
    // Photographic ring strip: Cassini-derived optical depth and colour, sampled by radius.
    float t = clamp((r - uInnerR) / max(uOuterR - uInnerR, 1e-4), 0.0, 1.0);
    vec4 photo = texture2D(uRingTex, vec2(t, 0.5));
    a = mix(a, photo.a * uOpacity, uTexMix);
    baseCol = mix(baseCol, photo.rgb, uTexMix);
  }
  if (a < 0.003) discard;
  float sz = uSunDirObj.z;
  bool camAbove = uCamPosObj.z > 0.0;
  float litSide = camAbove ? max(sz, 0.0) : max(-sz, 0.0);      // Sun on the camera's side of the plane
  float unlitSide = camAbove ? max(-sz, 0.0) : max(sz, 0.0);    // Sun behind the ring plane (backlit)
  // planet shadow: the projection along the light direction passes inside the (a, a, c) ellipsoid on the far side
  float tproj = dot(vObj, uSunDirObj);
  vec3 perp = vObj - tproj * uSunDirObj;
  perp.z /= max(uPolarRatio, 0.1);
  float rp = length(perp);
  float shadow = (tproj < 0.0) ? mix(0.06, 1.0, smoothstep(0.985, 1.03, rp)) : 1.0;
  float lit = 0.12 + 0.88 * sqrt(litSide);
  vec3 toCam = normalize(uCamPosObj - vObj);
  float fwd = pow(max(dot(-toCam, uSunDirObj), 0.0), 6.0);     // forward scattering toward the Sun
  float trans = unlitSide * (1.0 - a) * (0.3 + 0.7 * fwd) * 0.6; // thin parts glow when backlit
  vec3 col = baseCol * lit * shadow + vec3(0.9, 0.85, 0.7) * trans * shadow;
  gl_FragColor = vec4(col, a);
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

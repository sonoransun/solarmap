// Saturn rings on RingGeometry(innerR, outerR, 256) in PLANET RADII (Req = 60,268 km), z = 0 plane =
// equator (the mesh is a child of the spin node). Radial-distance shader, NSSDC ring fact sheet
// (https://nssdc.gsfc.nasa.gov/planetary/factsheet/satringfact.html): C 74,658–91,975 km (1.239–1.526 R),
// B 91,975–117,507 km (1.526–1.950 R), A 122,340–136,780 km (2.030–2.270 R), Encke gap 133,410 km (2.214 R),
// Keeler gap 136,487 km (2.265 R), Maxwell gap 87,491 km (1.452 R); Cassini division = the B–A gap.
// Uniforms updated per frame by the render core (object space of the ring mesh, planet-radius units):
//   uSunDirObj  unit vector planet -> Sun ; uCamPosObj camera position (worldToLocal of the ring mesh).
//
// RING_ALPHA_GLSL is shared with Saturn's globe material (materials.js), which projects each surface point along
// the Sun direction onto the ring plane and reads the same opacity law for the rings' shadow on the globe.
// Anti-aliasing: `fw` is the screen-space footprint of r (fwidth(r), computed by the caller in uniform control
// flow). The fine ringlet noise terms fade out once a pixel spans more than ~¼ of their period (Nyquist: a term
// at frequency f cycles/R cannot be resolved when fw·f ≳ 0.5), and each narrow gap is widened to the footprint
// with its depth scaled by w/w' so the total "missing light" is conserved — no moiré at mid distance, the gaps
// still read as thin dark lines.
import { NOISE3D_GLSL } from './noise3d.js';

export const RING_ALPHA_GLSL = /* glsl */ `
// 1 − smoothstep dip of width w around c, widened to the pixel footprint fw with conserved depth
float ringGapDip(float r, float c, float w, float fw) {
  float wp = max(w, fw);
  return (1.0 - smoothstep(0.0, wp, abs(r - c))) * (w / wp);
}
// 1 while a term of frequency f (cycles per planet radius) is resolvable at footprint fw, 0 past Nyquist
float ringAaFade(float fw, float f) {
  return 1.0 - smoothstep(0.2, 0.55, fw * f);
}
// Optical opacity of the main rings at radius r (planet radii), procedural law
float ringAlpha(float r, float innerR, float outerR, float seed, float fw) {
  float a = 0.0;
  a += smoothstep(1.239, 1.26, r) * (1.0 - smoothstep(1.50, 1.526, r)) * 0.35;    // C ring (dim)
  a += smoothstep(1.526, 1.54, r) * (1.0 - smoothstep(1.93, 1.950, r)) * 0.95;    // B ring (bright)
  a += smoothstep(2.030, 2.045, r) * (1.0 - smoothstep(2.25, 2.270, r)) * 0.65;   // A ring
  a *= 1.0 - 0.85 * ringGapDip(r, 2.214, 0.004, fw);                               // Encke gap
  a *= 1.0 - 0.70 * ringGapDip(r, 2.265, 0.0025, fw);                              // Keeler gap
  a *= 1.0 - 0.50 * ringGapDip(r, 1.452, 0.006, fw);                               // Maxwell gap
  // fine ringlets: two noise octaves (periods ≈ 1/140 R and 1/420 R), each faded out past its Nyquist footprint
  float fine = snoise(vec3(r * 140.0, seed, 0.0)) * 0.5 * ringAaFade(fw, 140.0)
             + snoise(vec3(r * 420.0, seed + 3.0, 0.0)) * 0.25 * ringAaFade(fw, 420.0);
  a *= 0.8 + 0.2 * fine;
  a *= smoothstep(innerR, innerR + 0.01, r) * (1.0 - smoothstep(outerR - 0.01, outerR, r));
  return clamp(a, 0.0, 1.0);
}
// Opacity with the optional photographic strip (Cassini-derived optical depth, u = (r − inner)/(outer − inner))
float ringOpticalAlpha(float r, float innerR, float outerR, float seed, float fw, sampler2D strip, float texMix) {
  float a = ringAlpha(r, innerR, outerR, seed, fw);
  if (texMix > 0.001) {
    float t = clamp((r - innerR) / max(outerR - innerR, 1e-4), 0.0, 1.0);
    a = mix(a, texture2D(strip, vec2(t, 0.5)).a, texMix);
  }
  return a;
}
`;

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
${RING_ALPHA_GLSL}
vec3 ringColour(float r) {
  vec3 cC = vec3(0.62, 0.60, 0.58);
  vec3 cB = vec3(0.86, 0.80, 0.66);
  vec3 cA = vec3(0.80, 0.75, 0.63);
  vec3 col = mix(cC, cB, smoothstep(1.50, 1.54, r));
  return mix(col, cA, smoothstep(1.95, 2.03, r));
}
void main() {
  float r = length(vObj.xy);
  float fw = fwidth(r);
  float a = ringOpticalAlpha(r, uInnerR, uOuterR, uSeed, fw, uRingTex, uTexMix) * uOpacity;
  vec3 baseCol = ringColour(r);
  if (uTexMix > 0.001) {
    float t = clamp((r - uInnerR) / max(uOuterR - uInnerR, 1e-4), 0.0, 1.0);
    baseCol = mix(baseCol, texture2D(uRingTex, vec2(t, 0.5)).rgb, uTexMix);
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

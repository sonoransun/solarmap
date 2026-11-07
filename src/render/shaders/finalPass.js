// Final grade pass: vignette + triangular dither, applied in LINEAR HDR right before OutputPass (which must stay last
// because it owns tone mapping and the sRGB conversion — a pass after it would operate on display-encoded values).
//
// Vignette: 1 − uVignette · smoothstep(0.45, 1.25, |q|) with q the centred, aspect-corrected uv (|q| ≈ 1.03 at the
// corners of 16:9), multiplied in linear light where lens falloff (cos⁴ law) physically belongs.
//
// Dither: banding appears when OutputPass quantises to 8 bits per channel AFTER the sRGB OETF. The noise is added
// here in linear light with an amplitude of exactly one output step at this pixel's level: for S(L) = 1.055 L^(1/2.4)
// − 0.055 (IEC 61966-2-1), dS/dL = 0.4396 L^(−0.5833), so one 8-bit step (1/255 in S) is dL = L^0.5833 / (0.4396 · 255);
// in the linear toe (S = 12.92 L) it is 1/(12.92 · 255) = 3.04e-4. NeutralToneMapping is the identity (minus a tiny
// offset) below 0.76 after exposure, so the calibration holds exactly where banding is visible: the dark sky, the
// Milky Way, glow halos. The noise has a triangular PDF (sum of two uniforms − 1, in (−1, 1); Lipshitz, Wannamaker &
// Vanderkooy 1992, J. AES 40(5): TPDF dither decouples the quantisation error from the signal) and is re-seeded per
// frame (uSeed) so the pattern never sits still. One noise value per pixel is shared by the three channels (chroma
// noise is far more visible than luminance noise).
// The tone-mapping / colour-space chunks compile to no-ops inside the composer (three defines TONE_MAPPING only for
// on-screen programs); they and the log-depth chunks are kept for the project's shader rule.

export const FINAL_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const FINAL_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D tDiffuse;
uniform float uVignette;
uniform float uSeed;
uniform vec2 uResolution;
varying vec2 vUv;
// Dave Hoskins, "Hash without Sine" (https://www.shadertoy.com/view/4djSRW, MIT)
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec2 q = vUv - 0.5;
  q.x *= uResolution.x / max(uResolution.y, 1.0);
  float vig = 1.0 - uVignette * smoothstep(0.45, 1.25, length(q));
  c.rgb *= vig;
  vec2 px = gl_FragCoord.xy + uSeed * vec2(13.0, 7.0);
  float n = hash12(px) + hash12(px.yx * 1.7 + 101.0) - 1.0;                       // triangular PDF in (-1, 1)
  float L = max(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0);
  float lsb = max(pow(L, 0.5833) / (0.4396 * 255.0), 3.04e-4);                     // one 8-bit sRGB step, in linear light
  c.rgb = max(c.rgb + n * lsb, 0.0);
  gl_FragColor = c;
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

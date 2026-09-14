// Radial (zoom) blur for the warp effect: 8 taps sampled toward uCenter (uv of the projected velocity
// direction), strength uStrength (= uStreak, 0…0.6). Used by renderer.js as `new ShaderPass(RadialBlurShader)`
// between RenderPass and UnrealBloomPass, enabled only while uStrength > 0.01. Research §3.6.
// The pass renders into the composer's HalfFloat target, so the tone-mapping / colour-space chunks are
// compiled as no-ops there (three only defines TONE_MAPPING for on-screen programs); log depth on the
// orthographic full-screen quad is likewise a no-op. Both are kept for the project's shader rule.

export const RADIAL_BLUR_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const RADIAL_BLUR_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D tDiffuse;
uniform vec2 uCenter;
uniform float uStrength;
varying vec2 vUv;
void main() {
  vec2 dir = vUv - uCenter;
  vec4 c = vec4(0.0);
  float wsum = 0.0;
  const int N = 8;
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N - 1);
    float w = 1.0 - 0.5 * t;                                  // weight toward the unblurred tap
    c += texture2D(tDiffuse, vUv - dir * uStrength * t * 0.08) * w;
    wsum += w;
  }
  gl_FragColor = c / wsum;
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

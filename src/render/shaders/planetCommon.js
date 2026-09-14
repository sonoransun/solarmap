// Shared procedural helpers used by every planet / Sun shader. Pure GLSL functions of an object-space unit
// normal `n` (seamless on the sphere: no UVs, no seam, rotates with the mesh). Must be concatenated AFTER
// NOISE3D_GLSL (uses snoise) and after three's `#include <common>` (uses the PI macro).
//
// fbm / ridged fbm / domain warping: Inigo Quilez, https://iquilezles.org/articles/fbm/ and
// https://iquilezles.org/articles/warp/ ; The Book of Shaders ch. 13, https://thebookofshaders.com/13/ .
// hash13: Dave Hoskins, "Hash without Sine" (https://www.shadertoy.com/view/4djSRW, MIT).
// craters: jittered-lattice cellular placement with a cosine bowl and raised rim (original design, see the
// rendering research §4.3).

export const PLANET_COMMON_GLSL = /* glsl */ `
// ---- solarmap planet helpers -------------------------------------------------------------------------
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

// 6-octave fbm, range about [-1, 1]
float fbm(vec3 p) {
  float a = 0.5;
  float f = 1.0;
  float s = 0.0;
  for (int i = 0; i < 6; i++) {
    s += a * snoise(p * f);
    f *= 2.02;
    a *= 0.5;
  }
  return s;
}

// cheaper 4-octave fbm for secondary warps
float fbm4(vec3 p) {
  float a = 0.5;
  float f = 1.0;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * snoise(p * f);
    f *= 2.02;
    a *= 0.5;
  }
  return s;
}

// ridged fbm, range about [0, 1]
float fbmRidged(vec3 p) {
  float a = 0.5;
  float f = 1.0;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * (1.0 - abs(snoise(p * f)));
    f *= 2.1;
    a *= 0.5;
  }
  return s;
}

// Periodic domain drift for animated patterns. uTime is wrapped at 1e4 s by setMaterialTime(); every
// frequency here is an integer multiple of 2*PI/1e4 so the wrap is seamless (no pop). Perceived drift
// speed ≈ amp * k * 6.28e-4 noise-units per second.
vec3 loopDrift(float t, float amp, float k) {
  float ph = t * 6.283185307179586e-4 * k;
  return vec3(cos(ph), sin(ph), 0.5 * sin(2.0 * ph)) * amp;
}

// Elliptical "storm" mask around the unit direction c (rx along local east, ry along local north, in
// tangent-plane units); warp jitters the edge. 1 inside, 0 outside, only on the hemisphere facing c.
float ovalSpot(vec3 n, vec3 c, float rx, float ry, float warp) {
  vec3 e = normalize(cross(vec3(0.0, 0.0, 1.0), c));
  vec3 m = cross(c, e);
  vec2 uv = vec2(dot(n, e) / rx, dot(n, m) / ry);
  float d = length(uv) + warp;
  return (1.0 - smoothstep(0.75, 1.05, d)) * step(0.0, dot(n, c));
}

// Craters: returns (height offset, rim mask). freq = lattice cells per unit; a few big, many small.
vec2 craters(vec3 n, float freq, float seed) {
  vec3 p = n * freq + seed;
  vec3 ip = floor(p);
  vec2 acc = vec2(0.0);
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 c = ip + vec3(float(x), float(y), float(z));
        float h = hash13(c);
        vec3 cp = c + 0.5 + 0.35 * (vec3(hash13(c + 1.7), hash13(c + 3.1), hash13(c + 5.3)) - 0.5);
        float r = 0.15 + 0.35 * h * h;
        float d = length(p - cp) / r;
        if (d > 1.15) continue;
        float bowl = -(0.5 + 0.5 * cos(PI * min(d, 1.0))) * 0.6;
        float rim = smoothstep(0.85, 1.0, d) * (1.0 - smoothstep(1.0, 1.15, d)) * 0.35;
        acc += vec2((bowl + rim) * r, rim);
      }
    }
  }
  return acc;
}
// ---- end solarmap planet helpers ---------------------------------------------------------------------
`;

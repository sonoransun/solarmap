// Venus: opaque yellow-white sulphuric cloud deck, zonally stretched fbm with slow periodic drift
// (visual only: no super-rotation is modelled). cA #E8CDA0 cB #D9B77A (plan §Rendering).
// Requires NOISE3D_GLSL + PLANET_COMMON_GLSL before it.

export const VENUS_GLSL = /* glsl */ `
vec3 venusClouds(vec3 n, float t, vec3 cA, vec3 cB, float seed) {
  vec3 p = vec3(n.xy * 1.4, n.z * 4.0) + seed;                 // east-west streaks
  float w = fbm(p + loopDrift(t, 0.6, 24.0));
  float c = fbm(p * 2.0 + 0.8 * w);
  float v = smoothstep(-0.35, 0.45, c + 0.3 * w);
  vec3 col = mix(cB, cA, v);
  // faint dark Y-shaped equatorial feature and darker polar collars
  float yfeat = smoothstep(0.35, 0.75, fbm4(vec3(n.xy * 0.9, n.z * 2.5) + seed + 3.0))
              * (1.0 - smoothstep(0.35, 0.6, abs(n.z)));
  col = mix(col, cB * 0.9, 0.25 * yfeat);
  float polar = smoothstep(0.75, 0.95, abs(n.z));
  col = mix(col, cB * 0.92, 0.35 * polar);
  return col;
}
`;

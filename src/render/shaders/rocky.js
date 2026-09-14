// Rocky surface (Mercury, Mars): albedo fbm, large dark regions, two crater lattices with fake shading,
// optional polar caps. Requires NOISE3D_GLSL + PLANET_COMMON_GLSL before it.
//   Mercury base #B5B2AD dark #6E6B66 (no caps) ; Mars base #C1440E dark #6B2A12 + caps (research §4.3).

export const ROCKY_GLSL = /* glsl */ `
// n: object-space unit normal; cap: polar-cap colour; capStrength 0..1; craterScale scales lattice density.
vec3 rocky(vec3 n, vec3 base, vec3 dark, vec3 cap, float capStrength, float craterScale, float seed) {
  float alb = fbm(n * 3.0 + seed) * 0.5 + 0.5;
  float maria = smoothstep(0.15, 0.55, fbm(n * 1.6 + seed + 11.0));        // large dark plains
  vec2 cr = craters(n, 6.0 * craterScale, seed) + 0.5 * craters(n, 14.0 * craterScale, seed + 9.0);
  float shade = clamp(1.0 + cr.x * 1.5, 0.55, 1.15);                        // bowl / rim shading
  vec3 col = mix(dark, base, clamp(alb * (1.0 - 0.45 * maria), 0.0, 1.0)) * shade + cr.y * 0.15;
  // dust brightening in lowlands (subtle)
  col *= 0.92 + 0.08 * (fbm(n * 5.0 + seed + 4.0) * 0.5 + 0.5);
  // polar caps with a ragged edge
  float edge = abs(n.z) + 0.03 * fbm(n * 8.0 + seed + 2.0);
  col = mix(col, cap, capStrength * smoothstep(0.90, 0.96, edge));
  return col;
}
`;

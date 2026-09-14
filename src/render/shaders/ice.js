// Ice giants (Uranus, Neptune): low-contrast soft bands, bright methane cirrus streaks, optional dark
// spot (Neptune GDS-like), polar hood. Requires NOISE3D_GLSL + PLANET_COMMON_GLSL before it.
//   Uranus cA #9AD6DE cB #7FC4D0 bands 3 warp 0.05 ; Neptune cA #4C6EF5 cB #2F4BC2 cC #8FB3FF bands 3 warp 0.12 + storms.

export const ICE_GLSL = /* glsl */ `
vec3 iceGiant(vec3 n, float t, vec3 cA, vec3 cB, vec3 cC, vec3 cStorm,
              float bands, float warp, float storm, float spot, float seed) {
  float lat = n.z;
  vec3 q = n * 1.6 + seed;
  float w1 = fbm4(q + loopDrift(t, 0.8, 24.0));
  float w2 = fbm4(q * 2.0 + vec3(3.1, 7.7, 0.0) + 0.7 * w1);
  float y = lat * bands + warp * (0.6 * w1 + 0.4 * w2);
  float band = 0.5 + 0.5 * sin(y * PI + 0.6 * sin(y * 1.9 + seed));
  vec3 col = mix(cA, cB, band * 0.8 + 0.1);
  // bright, thin methane cirrus streaks (zonally stretched), scaled by storm activity
  float streaks = smoothstep(0.62, 0.92, fbm4(vec3(q.xy * 1.5, q.z * 5.0) + w2)) * storm;
  col = mix(col, cC, streaks * 0.6);
  // dark spot at lat -20 deg
  vec3 sc = vec3(cos(-0.35) * cos(1.1), cos(-0.35) * sin(1.1), sin(-0.35));
  float sp = ovalSpot(n, sc, 0.24, 0.13, 0.15 * w2) * spot;
  col = mix(col, cStorm, sp * 0.8);
  // faint bright polar hood (Uranus-like when storms are off)
  col = mix(col, cC, 0.18 * smoothstep(0.65, 0.95, -lat) * (1.0 - storm));
  return col * (0.95 + 0.05 * w2);
}
`;

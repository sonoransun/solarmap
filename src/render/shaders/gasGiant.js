// Gas-giant surface (Jupiter, Saturn): domain-warped zonal bands + storm ovals + one great spot.
// Requires NOISE3D_GLSL + PLANET_COMMON_GLSL before it. Palettes (plan §Rendering / research §4.3):
//   Jupiter cA #C8A97E cB #8C5A3C cC #E8D8C0 bands 5 warp 0.35 ; Saturn cA #E3D6A8 cB #C9B37E bands 7 warp 0.15.

export const GAS_GIANT_GLSL = /* glsl */ `
// n: object-space unit normal (n.z = sin latitude); t: seconds (wrapped); storm: oval strength 0..1;
// spot: great-spot strength 0..1 (Jupiter GRS-like oval at lat -22 deg, coloured cStorm).
vec3 gasGiant(vec3 n, float t, vec3 cA, vec3 cB, vec3 cC, vec3 cStorm,
              float bands, float warp, float storm, float spot, float seed) {
  float lat = n.z;
  vec3 q = n * 2.0 + seed;
  float w1 = fbm(q + loopDrift(t, 1.0, 32.0));                  // slow drift, 1e4 s periodic
  float w2 = fbm(q * 2.3 + vec3(5.2, 1.3, 0.0) + w1);           // domain warp (IQ)
  float y = lat * bands + warp * (0.6 * w1 + 0.4 * w2);         // warped latitude
  float band = 0.5 + 0.5 * sin(y * PI + 0.8 * sin(y * 2.7 + seed));
  float belts = 0.5 + 0.5 * sin(y * PI * 3.0 + 1.7 * w2);       // thinner secondary belts
  band = mix(band, belts, 0.22);
  vec3 col = mix(cA, cB, band);
  // bright equatorial zone
  float eq = (1.0 - smoothstep(0.0, 0.16, abs(lat))) * (0.5 + 0.5 * w2);
  col = mix(col, cC, 0.35 * eq);
  // white storm ovals (ridged noise thresholds), stronger at mid latitudes
  float ovals = smoothstep(0.55, 0.9, fbmRidged(q * 4.0 + w2)) * storm * 0.35
              * smoothstep(0.05, 0.25, abs(lat)) * (1.0 - smoothstep(0.6, 0.85, abs(lat)));
  col = mix(col, cC, ovals);
  // great spot: oval at lat -22 deg, lon 0.6 rad in the body frame (fixed to the prime meridian)
  vec3 sc = vec3(cos(-0.384) * cos(0.6), cos(-0.384) * sin(0.6), sin(-0.384));
  float sp = ovalSpot(n, sc, 0.19, 0.10, 0.12 * w2) * spot;
  float swirl = 0.85 + 0.15 * sin(12.0 * abs(dot(n, sc) - 1.0) + 6.0 * w1);   // faint concentric texture
  col = mix(col, cStorm * swirl, sp * 0.85);
  return col * (0.92 + 0.08 * w2);
}
`;

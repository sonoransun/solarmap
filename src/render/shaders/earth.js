// Earth: procedural continents (no real geography), shallow-water tint, vegetation/desert by latitude,
// ice caps, ocean roughness 0.25, city-light mask for the night side; plus the cloud-layer alpha.
// Requires NOISE3D_GLSL + PLANET_COMMON_GLSL before it. Research §4.3 recipe with additions.

export const EARTH_GLSL = /* glsl */ `
// Returns albedo; writes roughness (0.25 ocean … 0.9 land) and a city-light mask (0..1) for the emissive stage.
vec3 earthSurface(vec3 n, float seed, out float rough, out float city) {
  float cont = fbm(n * 1.8 + seed) + 0.35 * fbm(n * 6.0 + seed);     // continents
  float land = smoothstep(0.02, 0.08, cont);
  float lat = abs(n.z);
  float polar = smoothstep(0.86, 0.93, lat + 0.04 * fbm(n * 7.0 + 2.0));   // ragged ice caps
  float shallow = smoothstep(-0.3, 0.02, cont);
  vec3 ocean = mix(vec3(0.02, 0.08, 0.25), vec3(0.03, 0.18, 0.40), shallow);   // shelves lighter
  float veg = smoothstep(0.1, 0.5, fbm(n * 4.0 + 3.0)) * (1.0 - smoothstep(0.55, 0.8, lat));
  float desert = smoothstep(0.15, 0.45, lat) * (1.0 - smoothstep(0.45, 0.6, lat))
               * smoothstep(0.2, 0.6, fbm(n * 3.5 + 5.0));
  vec3 landC = mix(vec3(0.42, 0.34, 0.20), vec3(0.10, 0.32, 0.12), veg);
  landC = mix(landC, vec3(0.62, 0.50, 0.30), desert * (1.0 - veg));
  float mount = smoothstep(0.5, 0.8, fbmRidged(n * 5.0 + seed)) * land;
  landC = mix(landC, vec3(0.40, 0.36, 0.32), 0.5 * mount);
  vec3 col = mix(ocean, landC, land);
  col = mix(col, vec3(0.93, 0.95, 0.98), polar);
  rough = mix(0.25, 0.9, max(land, polar));
  float cityN = smoothstep(0.55, 0.9, fbm(n * 12.0 + 7.0)) * smoothstep(0.3, 0.9, fbm(n * 5.0 + 9.0));
  city = land * (1.0 - polar) * (1.0 - smoothstep(0.7, 0.85, lat)) * cityN;
  return col;
}

// Cloud cover alpha (0..1); the pattern spins with the surface and drifts slowly (1e4 s periodic).
float earthCloudAlpha(vec3 n, float t, float seed) {
  vec3 d = loopDrift(t, 0.35, 20.0);
  float c = fbm(n * 3.0 + seed + d) * 0.5 + 0.5;
  float c2 = fbm(n * 7.0 + seed * 1.7 - d) * 0.5 + 0.5;
  float belt = 0.85 + 0.15 * cos(n.z * 9.0);                          // ITCZ / mid-latitude belts
  return smoothstep(0.42, 0.78, (c * 0.7 + c2 * 0.3) * belt);
}
`;

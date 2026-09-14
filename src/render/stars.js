// Seeded starfield: 10,000 points on a 5,000 AU sphere that follows the camera position every frame (never parallaxes,
// never culled), sizes 1–3 CSS px with subtle colour-temperature tints, plus a LineSegments "streak" object sharing the
// same directions (head + tail per star, attributes aTail / aMag / aColor) that is only visible during warp
// (uStreak > 0.005). Materials come from materials.js (createStarMaterial: sizeAttenuation off; createStreakMaterial:
// uniforms uVelDir, uStreak, uPixelRatio). The sky radius stays inside the camera far plane (2e4 AU).

import { Group, BufferGeometry, Float32BufferAttribute, Points, LineSegments, Vector3 } from 'three';

export const STAR_COUNT = 10000;
export const SKY_RADIUS_AU = 5000;
export const STAR_SEED = 42;
const STREAK_VISIBLE_MIN = 0.005;

/**
 * mulberry32 — small seeded PRNG (Tommy Ettinger, public domain; https://gist.github.com/tommyettinger/46a874533244883189143505d203312c).
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {{ materials: { createStarMaterial: () => import('three').Material, createStreakMaterial: () => import('three').Material },
 *   count?: number, radiusAu?: number, seed?: number }} opts
 */
export function createStars({ materials, count = STAR_COUNT, radiusAu = SKY_RADIUS_AU, seed = STAR_SEED }) {
  const rng = mulberry32(seed);
  const dirs = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const mags = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // uniform on the sphere
    const z = 2 * rng() - 1;
    const phi = 2 * Math.PI * rng();
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    dirs[i * 3] = r * Math.cos(phi);
    dirs[i * 3 + 1] = r * Math.sin(phi);
    dirs[i * 3 + 2] = z;
    // many faint, few bright (px)
    const s = rng();
    sizes[i] = 1 + 2 * s * s * s;
    // brightness with a long faint tail
    const m = rng();
    const mag = 0.35 + 0.65 * m * m;
    mags[i] = mag;
    // colour temperature tint: warm (K/M) ← white → cool (B/A), kept subtle
    const t = rng();
    let cr, cg, cb;
    if (t < 0.35) { const k = t / 0.35; cr = 1.0; cg = 0.82 + 0.16 * k; cb = 0.62 + 0.36 * k; }
    else if (t < 0.8) { cr = 1.0; cg = 0.98; cb = 0.98; }
    else { const k = (t - 0.8) / 0.2; cr = 0.98 - 0.2 * k; cg = 0.98 - 0.1 * k; cb = 1.0; }
    colors[i * 3] = cr * mag; colors[i * 3 + 1] = cg * mag; colors[i * 3 + 2] = cb * mag;
  }

  // --- static sky (Points) -----------------------------------------------------------------------------------------
  const pointsGeom = new BufferGeometry();
  pointsGeom.setAttribute('position', new Float32BufferAttribute(dirs, 3));
  pointsGeom.setAttribute('aSize', new Float32BufferAttribute(sizes, 1));
  pointsGeom.setAttribute('aColor', new Float32BufferAttribute(colors, 3));
  const starMaterial = materials.createStarMaterial();
  const points = new Points(pointsGeom, starMaterial);
  points.name = 'stars';
  points.frustumCulled = false;
  points.renderOrder = -10;

  // --- warp streaks (LineSegments): head (aTail 0) and tail (aTail 1) share the star direction ----------------------
  const segPos = new Float32Array(count * 6);
  const segTail = new Float32Array(count * 2);
  const segMag = new Float32Array(count * 2);
  const segColor = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 2; k++) {
      const v = i * 2 + k;
      segPos[v * 3] = dirs[i * 3]; segPos[v * 3 + 1] = dirs[i * 3 + 1]; segPos[v * 3 + 2] = dirs[i * 3 + 2];
      segTail[v] = k;
      segMag[v] = mags[i];
      segColor[v * 3] = colors[i * 3]; segColor[v * 3 + 1] = colors[i * 3 + 1]; segColor[v * 3 + 2] = colors[i * 3 + 2];
    }
  }
  const streakGeom = new BufferGeometry();
  streakGeom.setAttribute('position', new Float32BufferAttribute(segPos, 3));
  streakGeom.setAttribute('aTail', new Float32BufferAttribute(segTail, 1));
  streakGeom.setAttribute('aMag', new Float32BufferAttribute(segMag, 1));
  streakGeom.setAttribute('aColor', new Float32BufferAttribute(segColor, 3));
  const streakMaterial = materials.createStreakMaterial();
  const streaks = new LineSegments(streakGeom, streakMaterial);
  streaks.name = 'streaks';
  streaks.frustumCulled = false;
  streaks.renderOrder = -9;
  streaks.visible = false;

  const group = new Group();
  group.name = 'sky';
  group.scale.setScalar(radiusAu); // directions are unit vectors; the object is scaled to the sky radius
  group.add(points, streaks);

  /** @param {import('three').Material} m @returns {Record<string, {value: any}>|null} */
  function uniformsOf(m) {
    return m.userData?.uniforms ?? m.uniforms ?? null;
  }

  /** Follow the camera position (call every frame, before render). @param {Vector3} cameraPosition */
  function update(cameraPosition) {
    group.position.copy(cameraPosition);
  }

  /**
   * @param {number} strength uStreak (0 … ~0.6)
   * @param {Vector3|number[]|null} [velDir] unit camera velocity in world space
   */
  function setWarp(strength, velDir) {
    const u = uniformsOf(streakMaterial);
    if (u) {
      if (u.uStreak) u.uStreak.value = strength;
      if (velDir && u.uVelDir) {
        const val = u.uVelDir.value;
        if (velDir.isVector3) {
          if (val.isVector3) val.copy(velDir); else { val[0] = velDir.x; val[1] = velDir.y; val[2] = velDir.z; }
        } else if (val.isVector3) val.set(velDir[0], velDir[1], velDir[2]);
        else { val[0] = velDir[0]; val[1] = velDir[1]; val[2] = velDir[2]; }
      }
    }
    streaks.visible = strength > STREAK_VISIBLE_MIN;
  }

  /** @param {number} pr */
  function setPixelRatio(pr) {
    for (const m of [starMaterial, streakMaterial]) {
      const u = uniformsOf(m);
      if (u && u.uPixelRatio) u.uPixelRatio.value = pr;
    }
  }

  function dispose() {
    pointsGeom.dispose();
    streakGeom.dispose();
    starMaterial.dispose();
    streakMaterial.dispose();
    group.removeFromParent();
  }

  return { group, points, streaks, starMaterial, streakMaterial, update, setWarp, setPixelRatio, dispose };
}

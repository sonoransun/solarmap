// The sky: real stars, warp streaks, named-star labels and the Milky Way, all on spheres that follow the camera
// position every frame (never parallax, never culled). Nothing here imports src/astro: the star data arrive as the
// `sky` bundle built by src/astro/sky.js (createSkyData) and passed down by main.js → createScene({ sky }):
//   dirs  Float32Array N·3  unit vectors in the SCENE frame (ecliptic J2000), BSC5 catalogue first (brightest first)
//                           then a seeded procedural background of fainter points for density;
//   sizes Float32Array N    point diameter, CSS px (1.2–5 px for V 6.5 … −1.5, 1 px floor for the background);
//   rgb   Float32Array N·3  linear colour × intensity (B−V → colour; 0.22 … 1.9, HDR for the brightest);
//   mags, bv, names {index → IAU name}, count, catalogueCount, galPole / galCentre / galY (galactic basis).
// Objects (all inside one Group scaled to SKY_RADIUS_AU, so child positions are unit directions):
//   points   Points, additive, renderOrder −10, depthTest on (planets occlude stars);
//   streaks  LineSegments for every third star (head + tail, aTail 0/1), visible only during warp (uStreak > 0.005);
//   milkyWay inverted sphere at MILKY_WAY_RADIUS_AU / SKY_RADIUS_AU of the group, renderOrder −12, sampling a texture
//            baked once (bakeMilkyWay(renderer), or lazily from the mesh's onBeforeRender on its first visible frame —
//            a nested render into a target, the pattern three's Reflector uses; the material itself is never set
//            invisible, because three skips such objects before onBeforeRender);
//   labels   CSS2DObject per named star (<div class="star-lbl">), shown only when names are enabled AND the camera
//            fov is below NAMES_MAX_FOV_DEG (sky view) — pass the camera to update() so the fov is known.
// The sky radius stays inside the camera far plane (2e4 AU). All per-frame work is uniform writes and one Vector3 copy.

import {
  Group, BufferGeometry, Float32BufferAttribute, Points, LineSegments, Mesh, SphereGeometry,
  WebGLRenderTarget, HalfFloatType, LinearFilter, RepeatWrapping, ClampToEdgeWrapping,
} from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import {
  createSkyStarMaterial, createSkyStreakMaterial, createMilkyWayMaterial, createMilkyWayBakeMaterial,
} from './skyMaterials.js';

/** Radius of the star sphere (AU); inside the 2e4 AU far plane. */
export const SKY_RADIUS_AU = 5000;
/** Radius of the Milky Way sphere (AU): just inside the stars so depth order is explicit (its material writes no depth). */
export const MILKY_WAY_RADIUS_AU = 4900;
/** Named-star labels are shown below this vertical field of view (degrees): the sky view, never the overview. */
export const NAMES_MAX_FOV_DEG = 60;
/** Every Nth star gets a warp streak. */
export const STREAK_EVERY = 3;
/** Baked Milky Way texture size (equirectangular in galactic l, b): 0.35° per texel, 4 MB as RGBA half-float. */
export const MILKY_WAY_BAKE_SIZE = Object.freeze({ w: 1024, h: 512 });
const STREAK_VISIBLE_MIN = 0.005;
/** Point-size boost in narrow fields of view: × sqrt(50° / fov), capped. */
const FOV_SCALE_REF_DEG = 50;
const FOV_SCALE_MAX = 1.8;
const TIME_WRAP_S = 1e4;

/**
 * Fallback sky when no bundle is supplied (keeps the scene alive if the wiring is missing): a few thousand uniform
 * white points. Logged once so the omission is noticed.
 * @param {number} count
 */
function fallbackSky(count) {
  console.warn('[stars] createStars() received no sky bundle: drawing a plain fallback sky. Pass createSkyData() from src/astro/sky.js via createScene({ sky }).');
  const dirs = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const rgb = new Float32Array(count * 3);
  let a = 12345;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; // Numerical Recipes LCG
  for (let i = 0; i < count; i++) {
    const z = 2 * rnd() - 1, phi = 2 * Math.PI * rnd(), r = Math.sqrt(Math.max(0, 1 - z * z));
    dirs[i * 3] = r * Math.cos(phi); dirs[i * 3 + 1] = r * Math.sin(phi); dirs[i * 3 + 2] = z;
    const s = rnd();
    sizes[i] = 1 + 2 * s * s;
    const k = 0.3 + 0.7 * s * s;
    rgb[i * 3] = k; rgb[i * 3 + 1] = k; rgb[i * 3 + 2] = k;
  }
  return { dirs, sizes, rgb, names: {}, count, catalogueCount: 0, galPole: [0, 0, 1], galCentre: [1, 0, 0], galY: [0, 1, 0] };
}

/**
 * @param {{
 *   materials?: object,
 *   sky?: import('../astro/sky.js').SkyData,
 *   radiusAu?: number,
 *   milkyWayRadiusAu?: number,
 * }} opts `materials` (the materials.js module) is accepted for signature compatibility; the sky materials come from
 *   skyMaterials.js.
 */
export function createStars({ sky = null, radiusAu = SKY_RADIUS_AU, milkyWayRadiusAu = MILKY_WAY_RADIUS_AU } = {}) {
  const hasSky = !!(sky && sky.dirs && sky.sizes && sky.rgb);
  const data = hasSky ? sky : fallbackSky(4000);
  const count = data.count ?? data.dirs.length / 3;
  const galY = data.galY ?? crossNorm(data.galPole, data.galCentre);

  // --- static sky (Points) -----------------------------------------------------------------------------------------
  const pointsGeom = new BufferGeometry();
  pointsGeom.setAttribute('position', new Float32BufferAttribute(data.dirs, 3));
  pointsGeom.setAttribute('aSize', new Float32BufferAttribute(data.sizes, 1));
  pointsGeom.setAttribute('aColor', new Float32BufferAttribute(data.rgb, 3));
  const starMaterial = createSkyStarMaterial();
  const points = new Points(pointsGeom, starMaterial);
  points.name = 'stars';
  points.frustumCulled = false;
  points.renderOrder = -10;

  // --- warp streaks (LineSegments): every STREAK_EVERY-th star, head (aTail 0) + tail (aTail 1) ----------------------
  const nStreak = Math.ceil(count / STREAK_EVERY);
  const segPos = new Float32Array(nStreak * 6);
  const segTail = new Float32Array(nStreak * 2);
  const segColor = new Float32Array(nStreak * 6);
  for (let s = 0; s < nStreak; s++) {
    const i = s * STREAK_EVERY;
    for (let k = 0; k < 2; k++) {
      const v = s * 2 + k;
      segPos[v * 3] = data.dirs[i * 3]; segPos[v * 3 + 1] = data.dirs[i * 3 + 1]; segPos[v * 3 + 2] = data.dirs[i * 3 + 2];
      segTail[v] = k;
      segColor[v * 3] = data.rgb[i * 3]; segColor[v * 3 + 1] = data.rgb[i * 3 + 1]; segColor[v * 3 + 2] = data.rgb[i * 3 + 2];
    }
  }
  const streakGeom = new BufferGeometry();
  streakGeom.setAttribute('position', new Float32BufferAttribute(segPos, 3));
  streakGeom.setAttribute('aTail', new Float32BufferAttribute(segTail, 1));
  streakGeom.setAttribute('aColor', new Float32BufferAttribute(segColor, 3));
  const streakMaterial = createSkyStreakMaterial();
  const streaks = new LineSegments(streakGeom, streakMaterial);
  streaks.name = 'streaks';
  streaks.frustumCulled = false;
  streaks.renderOrder = -9;
  streaks.visible = false;

  // --- Milky Way: inverted sphere + baked texture ------------------------------------------------------------------
  const mwGeom = new SphereGeometry(1, 48, 24);
  const mwMaterial = createMilkyWayMaterial({ galPole: data.galPole, galCentre: data.galCentre, galY });
  const milkyWay = new Mesh(mwGeom, mwMaterial);
  milkyWay.name = 'milky-way';
  milkyWay.frustumCulled = false;
  milkyWay.renderOrder = -12;
  milkyWay.scale.setScalar(milkyWayRadiusAu / radiusAu);
  let mwWanted = hasSky; // without a real galactic basis the band would lie along the ecliptic: keep it off
  milkyWay.visible = mwWanted;
  let mwTarget = null;
  let mwBaked = false;

  /**
   * Render the band once into the equirectangular target and bind it. Safe to call at any time with a live
   * WebGLRenderer (also from onBeforeRender: three's render state stacks support nested renders).
   * @param {import('three').WebGLRenderer} renderer
   */
  function bakeMilkyWay(renderer) {
    if (mwBaked || !renderer) return;
    mwBaked = true;
    mwTarget = new WebGLRenderTarget(MILKY_WAY_BAKE_SIZE.w, MILKY_WAY_BAKE_SIZE.h, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false, // a mip chain would show a seam where the longitude derivative wraps
      wrapS: RepeatWrapping,   // seamless in l
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    });
    mwTarget.texture.name = 'solarmap.milkyway';
    const bakeMaterial = createMilkyWayBakeMaterial();
    const quad = new FullScreenQuad(bakeMaterial);
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(mwTarget);
    quad.render(renderer);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    // FullScreenQuad.dispose() would dispose the geometry three shares with every post-processing pass: just drop it.
    bakeMaterial.dispose();
    mwMaterial.uniforms.uMap.value = mwTarget.texture;
  }
  milkyWay.onBeforeRender = function (renderer) {
    if (!mwBaked) bakeMilkyWay(renderer);
  };

  // --- named-star labels (CSS2D) -------------------------------------------------------------------------------------
  /** @type {Array<{ object: CSS2DObject, element: HTMLElement }>} */
  const labels = [];
  const labelGroup = new Group();
  labelGroup.name = 'star-labels';
  const canDom = typeof document !== 'undefined';
  if (canDom && data.names) {
    for (const key of Object.keys(data.names)) {
      const i = Number(key);
      if (!(i >= 0 && i < count)) continue;
      const el = document.createElement('div');
      el.className = 'star-lbl';
      el.textContent = data.names[key];
      el.setAttribute('aria-hidden', 'true');
      el.style.pointerEvents = 'none';
      const obj = new CSS2DObject(el);
      obj.name = 'star-label:' + data.names[key];
      obj.center.set(0, 0.5); // left-middle at the star; the text offset is CSS padding (scene.css)
      obj.position.set(data.dirs[i * 3], data.dirs[i * 3 + 1], data.dirs[i * 3 + 2]);
      labelGroup.add(obj);
      labels.push({ object: obj, element: el });
    }
  }
  let skyOn = true;
  let namesWanted = false;
  let namesShown = null; // tri-state so the first applyNames() always writes
  let fovDeg = NaN; // unknown until update(camera) / setFov(): names stay hidden rather than cluttering the overview

  function applyNames() {
    const on = skyOn && namesWanted && fovDeg < NAMES_MAX_FOV_DEG && labels.length > 0;
    if (on === namesShown) return;
    namesShown = on;
    labelGroup.visible = on;
    for (const l of labels) l.object.visible = on;
  }
  applyNames();

  const group = new Group();
  group.name = 'sky';
  group.scale.setScalar(radiusAu); // directions are unit vectors; the object is scaled to the sky radius
  group.add(milkyWay, points, streaks, labelGroup);

  let time = 0;

  /**
   * Follow the camera (call every frame, before render). Pass the camera itself so the fov is known (labels, point
   * boost); a bare position Vector3 is still accepted.
   * @param {import('three').Camera|Vector3} cameraOrPosition
   * @param {number} [dtSeconds] advances the (optional) twinkle clock
   */
  function update(cameraOrPosition, dtSeconds = 0) {
    const pos = cameraOrPosition.isVector3 ? cameraOrPosition : cameraOrPosition.position;
    group.position.copy(pos);
    if (!cameraOrPosition.isVector3 && cameraOrPosition.fov > 0) setFov(cameraOrPosition.fov);
    if (dtSeconds > 0 && starMaterial.uniforms.uTwinkle.value > 0) {
      time += dtSeconds;
      if (time > TIME_WRAP_S) time -= TIME_WRAP_S;
      starMaterial.uniforms.uTime.value = time;
    }
  }

  /** @param {number} deg vertical field of view (degrees) */
  function setFov(deg) {
    if (!(deg > 0) || deg === fovDeg) return;
    fovDeg = deg;
    starMaterial.uniforms.uFovScale.value = Math.min(FOV_SCALE_MAX, Math.max(1, Math.sqrt(FOV_SCALE_REF_DEG / deg)));
    applyNames();
  }

  /**
   * @param {number} strength uStreak (0 … ~0.6)
   * @param {Vector3|number[]|null} [velDir] unit camera velocity in world space
   */
  function setWarp(strength, velDir) {
    const u = streakMaterial.uniforms;
    u.uStreak.value = strength;
    if (velDir) {
      if (velDir.isVector3) u.uVelDir.value.copy(velDir);
      else u.uVelDir.value.set(velDir[0], velDir[1], velDir[2]);
    }
    streaks.visible = skyOn && strength > STREAK_VISIBLE_MIN;
  }

  /** @param {number} pr */
  function setPixelRatio(pr) {
    starMaterial.uniforms.uPixelRatio.value = pr;
    streakMaterial.uniforms.uPixelRatio.value = pr;
  }

  /** Whole sky on/off (settings.showStars). @param {boolean} on */
  function setVisible(on) {
    skyOn = !!on;
    points.visible = skyOn;
    if (!skyOn) streaks.visible = false;
    applyNames();
  }

  /** settings.showMilkyWay (ignored in fallback mode, where no galactic basis exists). @param {boolean} on */
  function setMilkyWayVisible(on) {
    mwWanted = hasSky && !!on;
    milkyWay.visible = mwWanted; // the mesh carries the toggle; the first visible frame bakes if needed
  }

  /** settings.showStarNames / showConstellationNames. @param {boolean} on */
  function setNamesVisible(on) {
    namesWanted = !!on;
    applyNames();
  }

  /** Twinkle amplitude 0…1 (0 = off; keep off under reduced motion). @param {number} amount */
  function setTwinkle(amount) {
    starMaterial.uniforms.uTwinkle.value = Math.max(0, Math.min(1, amount || 0));
  }

  function dispose() {
    pointsGeom.dispose();
    streakGeom.dispose();
    mwGeom.dispose();
    starMaterial.dispose();
    streakMaterial.dispose();
    mwMaterial.dispose();
    if (mwTarget) mwTarget.dispose();
    for (const l of labels) { l.object.removeFromParent(); l.element.remove(); }
    group.removeFromParent();
  }

  return {
    group, points, streaks, milkyWay, labels, starMaterial, streakMaterial, milkyWayMaterial: mwMaterial,
    count, catalogueCount: data.catalogueCount ?? 0,
    update, setFov, setWarp, setPixelRatio, setVisible, setMilkyWayVisible, setNamesVisible, setTwinkle,
    bakeMilkyWay, get milkyWayBaked() { return mwBaked; }, dispose,
  };
}

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @returns {number[]} unit a × b */
function crossNorm(a, b) {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  const n = Math.hypot(x, y, z) || 1;
  return [x / n, y / n, z / n];
}

// CameraRig: free | follow | skyView | flyby | tour on top of OrbitControls (three r186) and the pure fly-by math in
// src/astro/flyby.js. Implements plan §"Fly-by specification" (/Users/user/.claude/plans/implement-the-features-described-curried-spark.md).
//
// r186 facts honoured here (verified in node_modules/three/examples/jsm/controls/OrbitControls.js):
//  - the controls cache the up quaternion ONCE in the constructor (`this._quat = …setFromUnitVectors(object.up, +Y)`,
//    line 406), so `camera.up.set(0, 0, 1)` MUST precede `new OrbitControls(camera, canvas)` and `camera.up` must never
//    change afterwards (recreate the controls if it does);
//  - with `zoomToCursor` on, `update()` rewrites `controls.target` on every dolly (lines 815–885); follow mode translates
//    camera and target rigidly with the body each frame, so `zoomToCursor` is enabled in free mode only;
//  - `update(deltaTime)` takes seconds and makes autoRotate frame-rate independent (line 932);
//  - `connect(el)` sets `touch-action: none` on the canvas and captures pointers on it (line 508, 1559).
//
// Frame: scene = ecliptic J2000, 1 unit = 1 AU, z = ecliptic north (CLAUDE.md). Physics vectors are plain [x, y, z] arrays
// (flyby.js contract); the camera side uses THREE.Vector3. No per-frame allocations except the store patch (the store
// compares patch values by identity, so a fresh FlybyStatus object is required whenever it changes).

import { MathUtils, Quaternion, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  arcHeight, arrivalOffset, duration, lateralNormal, pathPoint, planProfile, rateCap, trueSpeedC,
} from '../astro/flyby.js';
import { C_AU_S, DEG, LIGHT_TIME_AU_S } from '../astro/constants.js';

/** Ecliptic north — the only camera "up" (CLAUDE.md: z = ecliptic north; plan §Rendering "camera.up.set(0,0,1)"). */
const UP = Object.freeze([0, 0, 1]);

/** Home view (plan §Rendering "polar angle 35° from +Z, 42 AU from the Sun"), animated over 1.2 s (task spec). */
export const HOME = Object.freeze({ distanceAu: 42, polarDeg: 35, azimuthDeg: -90, seconds: 1.2 });
/** OrbitControls tuning (plan §Rendering). */
const DAMPING = 0.08;
/** Follow-mode distance clamps in display radii (plan §Fly-by "Arrival"). */
const FOLLOW_MIN_R = 1.2;
const FOLLOW_MAX_R = 5000;
/** Free-mode clamps: 5e-6 AU ≈ 750 km (inside any planet at k = 1), 4000 AU (< the 5000 AU star sphere). */
const FREE_MIN_AU = 5e-6;
const FREE_MAX_AU = 4000;
/** Spin cap (plan §Fly-by "Follow-mode spin cap"): engage above 40 px projected radius, release below 36 px (hysteresis
 * so the cap does not flap while the user hovers at the threshold). 6°/frame at 60 fps = 360°/s. */
const SPIN_CAP_PX_ON = 40;
const SPIN_CAP_PX_OFF = 36;
const SPIN_CAP_DEG_PER_S = 360;
/** Look blending: slerp the start orientation toward the per-frame look-at over the first 25 % when the initial heading
 * is > 60° off (plan §Fly-by "Look"). */
const LOOK_SLERP_HEADING_RAD = 60 * DEG;
const LOOK_SLERP_MISMATCH_RAD = 1 * DEG;
const LOOK_SLERP_FRACTION = 0.25;
/** Warp streak law (plan §Fly-by "Warp"): uStreak → 0.6·smoothstep(clamp(log10(1 + speedC)/4.2)) with damp λ = 6. */
const STREAK_MAX = 0.6;
const STREAK_LOG_DIV = 4.2;
const STREAK_LAMBDA = 6;
const STREAK_MIN_C = 0.2;
/** Light-speed beat: streak impulse +0.15 damped over ≈0.4 s (plan §Fly-by "Light-speed beat"); λ = 10 → 1.8 % left at 0.4 s. */
const BEAT_IMPULSE = 0.15;
const BEAT_LAMBDA = 10;
/** Sim-rate easing (plan §Fly-by "Sim rate easing"): min-jerk over 0.5 s. */
const RATE_EASE_S = 0.5;
/** Esc mid-flight: decelerate in place over 0.6 s (plan §Fly-by "Arrival"). */
const CANCEL_DECEL_S = 0.6;
/** The coast during a cancel never exceeds this fraction of the remaining chord (keeps "in place" honest at 10³ c). */
const CANCEL_COAST_FRACTION = 0.25;
/** Reduced motion: 250 ms fade → cut → 250 ms fade (plan §Fly-by "Reduced motion"). */
const FADE_S = 0.25;
/** Sky view (plan §Fly-by "Sky view"): camera at body centre + 1.5 R toward the target; fov narrowed so the target's
 * projected radius ≥ 40 px, never below 10°. */
const SKY_OFFSET_R = 1.5;
const SKY_TARGET_PX = 40;
const SKY_MIN_FOV_DEG = 10;
const SKY_PAIR_MARGIN = 1.35;
/** Tour (plan §Fly-by "Tour"). autoRotateSpeed 2.0 = one revolution per 30 s in r186; 0.5 → 2 min/rev. */
export const TOUR_DEFAULT_IDS = Object.freeze([
  'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'mercury', 'venus', 'sun', 'earth',
]);
const TOUR_DWELL_S = 4;
const TOUR_AUTOROTATE_SPEED = 0.5;
/** Largest real-time step fed to the rig (a hidden tab resuming would otherwise jump the flight to its end). */
const MAX_DT = 0.1;

/**
 * Projected radius of a sphere in CSS pixels (plan §Rendering "Markers"; implemented locally per the render contract).
 * @param {number} R sphere radius (AU)
 * @param {number} d camera distance to the centre (AU)
 * @param {number} fovRad vertical field of view
 * @param {number} H viewport height (CSS px)
 * @returns {number}
 */
export function pxRadius(R, d, fovRad, H) {
  return R / Math.max(d, 1.0001 * R) / Math.tan(fovRad / 2) * H / 2;
}

/**
 * Minimum-jerk position profile (Flash & Hogan 1985, J Neurosci 5(7):1688): s(u) = 10u³ − 15u⁴ + 6u⁵, C² at both ends.
 * @param {number} u 0…1
 * @returns {number}
 */
export function minJerk(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const u2 = u * u, u3 = u2 * u;
  return 10 * u3 - 15 * u3 * u + 6 * u3 * u2;
}

/**
 * Streak intensity target for a given speed (plan §Fly-by "Warp").
 * @param {number} speedC true speed in multiples of c
 * @returns {number} 0…0.6
 */
export function streakTarget(speedC) {
  if (!(speedC >= STREAK_MIN_C)) return 0;
  const x = MathUtils.clamp(Math.log10(1 + speedC) / STREAK_LOG_DIV, 0, 1);
  return STREAK_MAX * x * x * (3 - 2 * x);
}

/**
 * @typedef {object} RigUpdate
 * @property {number} speedC        true camera speed in multiples of c (0 outside flights)
 * @property {number} streak        eased warp streak intensity 0…0.6 (0 under reduced motion / min-jerk hops)
 * @property {number[]} velDir      unit camera velocity in world space (reused array; last value kept at rest)
 * @property {boolean} lightspeedBeat  true on the frame the true speed crosses 1 c (either direction)
 * @property {boolean} rateRestored    true on the frame the user's sim rate was put back (fly-by easing or spin cap)
 * @property {string|null} arrived     body id on the frame a fly-by (or a tour leg) arrived
 * @property {boolean} spinCapped      the follow-mode spin cap is currently holding the rate down
 * @property {'on'|'off'|null} spinCapChanged  transition of the spin cap on this frame
 * @property {number|null} spinCapRate  the capped rate (days/s) while spinCapped
 * @property {number} dim              reduced-motion fade amount 0…1 (also delivered through onFade)
 */

/**
 * @typedef {object} CameraRig
 * @property {() => 'free'|'follow'|'skyView'|'flyby'|'tour'} mode
 * @property {(id: string) => void} follow
 * @property {() => void} free
 * @property {(fromId: string, toId: string|string[]) => void} skyView
 * @property {(id: string, opts?: { from?: string|null }) => boolean} flyTo
 * @property {(ids?: string[], opts?: { dwellSeconds?: number }) => void} tour
 * @property {() => boolean} cancel
 * @property {() => void} resetHome
 * @property {(dtReal: number, jdTT: number) => RigUpdate} update
 * @property {import('three/addons/controls/OrbitControls.js').OrbitControls} controls
 * @property {(point: ArrayLike<number>|Vector3) => void} setLookTarget
 * @property {(fn: (dim: number) => void) => () => void} onFade
 * @property {(opts: { position: ArrayLike<number>, target: ArrayLike<number>, seconds?: number }) => void} viewPose
 * @property {(opts: { center: ArrayLike<number>, radius: number, seconds?: number, polarDeg?: number }) => void} frameTopDown
 * @property {() => string|null} followed   id of the followed body (null outside follow mode)
 * @property {() => void} dispose
 */

/**
 * Create the camera rig.
 * @param {object} o
 * @param {import('three').PerspectiveCamera} o.camera  PerspectiveCamera with `up` = (0,0,1) (asserted and fixed here)
 * @param {HTMLCanvasElement} o.canvas                   the WebGL canvas (OrbitControls connects to it)
 * @param {ReturnType<import('../app/state.js').createStore>} o.store
 * @param {(id: string) => {x:number,y:number,z:number,vx:number,vy:number,vz:number}} o.getBodyState  scene-frame state (AU, AU/day)
 * @param {(id: string) => number} o.getDispRadiusAu     displayed radius (R_disp incl. the size exaggeration; Sun uses min(k, 30))
 * @param {(id: string) => number} o.getPeriodDays       sidereal orbital period (any non-positive/NaN value disables rate easing)
 * @param {{ rate: () => number, setRate: (r: number) => void }} o.clock
 * @param {() => boolean} o.isReducedMotion
 * @param {(id: string) => number} [o.getSpinRateDegPerDay]  |Ẇ| in °/day; absent → no spin cap
 * @param {() => number} [o.getViewportHeight]           CSS px; default canvas.clientHeight
 * @returns {CameraRig}
 */
export function createCameraRig({
  camera, canvas, store, getBodyState, getDispRadiusAu, getPeriodDays, clock, isReducedMotion,
  getSpinRateDegPerDay = null, getViewportHeight = null,
}) {
  // r186: OrbitControls derives its up-quaternion in the constructor from camera.up — set +Z first, never change it later.
  if (camera.up.x !== 0 || camera.up.y !== 0 || camera.up.z !== 1) {
    console.warn('createCameraRig: camera.up must be (0,0,1) before OrbitControls is built; fixing it');
    camera.up.set(0, 0, 1);
  }
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = DAMPING;
  controls.screenSpacePanning = true;
  const baseFov = camera.fov;
  const win = typeof window !== 'undefined' ? window : null;

  // ---- state -------------------------------------------------------------------------------------------------------
  /** @type {'free'|'follow'|'skyView'|'flyby'} internal behaviour (the public mode reports 'tour' while a tour runs) */
  let mode = 'free';
  /** @type {string|null} */
  let followId = null;
  /** @type {{ from: string, to: string[] }|null} */
  let sky = null;
  /** @type {object|null} active flight (see launch()) */
  let flight = null;
  /** @type {{ ids: string[], i: number, dwell: number, dwellLeft: number, phase: 'fly'|'dwell' }|null} */
  let tour = null;
  /** @type {{ t: number, seconds: number, p0: Vector3, p1: Vector3, t0: Vector3, t1: Vector3 }|null} animated free pose */
  let pose = null;
  /** @type {{ phase: 'out'|'in', t: number, cut: (() => void)|null }|null} reduced-motion fade */
  let fade = null;
  /** @type {Set<(dim: number) => void>} */
  const fadeListeners = new Set();
  let lastDim = 0;

  // Rate management (fly-by easing and the spin cap share the "user rate" bookkeeping).
  const ease = { active: false, t: 0, r0: 0, r1: 0, userRate: 0, lastSet: NaN, restore: false };
  let beatImpulse = 0;
  let streakBase = 0;
  const spin = { active: false, userRate: 0, applied: 0 };

  // Scratch (allocation-free hot path).
  const sA = [0, 0, 0], sB = [0, 0, 0], sE = [0, 0, 0], sP = [0, 0, 0], sN = [0, 0, 0], sOff = [0, 0, 0];
  const sL = [0, 0, 0], sTmp = [0, 0, 0];
  const vB = new Vector3(), vD = new Vector3(), vL = new Vector3(), vTmp = new Vector3(), vTmp2 = new Vector3();
  const vPrev = new Vector3(), vVel = new Vector3(), vFwd = new Vector3();
  const qLook = new Quaternion(), qTmp = new Quaternion();
  const posePos = new Vector3(), poseTgt = new Vector3();

  /** @type {RigUpdate} reused result object */
  const res = {
    speedC: 0, streak: 0, velDir: [0, 0, 1], lightspeedBeat: false, rateRestored: false, arrived: null,
    spinCapped: false, spinCapChanged: null, spinCapRate: null, dim: 0,
  };
  const patch = { cameraMode: 'free', followed: null, flyby: null };
  let storeMode = null, storeFollowed = undefined, storeFlyby = undefined;

  // ---- helpers -----------------------------------------------------------------------------------------------------
  function viewportH() {
    return getViewportHeight ? getViewportHeight() : (canvas.clientHeight || 0);
  }
  /** @param {string} id @param {number[]} out */
  function bodyPos(id, out) {
    const st = getBodyState(id);
    out[0] = st.x; out[1] = st.y; out[2] = st.z;
    return out;
  }
  /** @param {string} id @param {Vector3} out */
  function bodyVec(id, out) {
    const st = getBodyState(id);
    return out.set(st.x, st.y, st.z);
  }
  function reduced() {
    return !!isReducedMotion();
  }
  function settings() {
    return store.get().settings;
  }
  function publicMode() {
    return tour ? 'tour' : mode;
  }
  function emitFade(dim) {
    if (dim === lastDim) return;
    lastDim = dim;
    res.dim = dim;
    for (const fn of fadeListeners) fn(dim);
  }
  function configureFreeControls() {
    controls.zoomToCursor = true;
    controls.minDistance = FREE_MIN_AU;
    controls.maxDistance = FREE_MAX_AU;
    controls.autoRotate = false;
  }
  function configureFollowControls(id) {
    const R = getDispRadiusAu(id);
    controls.zoomToCursor = false; // r186 rewrites target on cursor zoom; follow needs the target pinned on the body
    controls.minDistance = FOLLOW_MIN_R * R;
    controls.maxDistance = FOLLOW_MAX_R * R;
  }
  function restoreFov() {
    if (camera.fov !== baseFov) {
      camera.fov = baseFov;
      camera.updateProjectionMatrix();
    }
  }
  /** The point the camera is currently looking at, in every mode. @param {number[]} out */
  function currentLookPoint(out) {
    if (mode === 'flyby' && flight) {
      if (flight.phase === 'fly') { out[0] = sL[0]; out[1] = sL[1]; out[2] = sL[2]; return out; }
      // decel / fades: along the forward axis at the remembered look distance
      camera.getWorldDirection(vFwd);
      vTmp.copy(camera.position).addScaledVector(vFwd, flight.lookDist || 1);
      out[0] = vTmp.x; out[1] = vTmp.y; out[2] = vTmp.z; return out;
    }
    if (mode === 'skyView' && sky) { skyLookPoint(vTmp); out[0] = vTmp.x; out[1] = vTmp.y; out[2] = vTmp.z; return out; }
    if (pose) { out[0] = poseTgt.x; out[1] = poseTgt.y; out[2] = poseTgt.z; return out; }
    out[0] = controls.target.x; out[1] = controls.target.y; out[2] = controls.target.z;
    return out;
  }

  // ---- sim-rate easing (fly-by) --------------------------------------------------------------------------------------
  /** Begin easing toward the fly-by rate cap, if the settings and rateCap() ask for it. */
  function beginRateEase(targetId, T) {
    ease.active = false; ease.restore = false;
    if (settings().keepRateDuringFlyby) return;
    const period = getPeriodDays(targetId);
    if (!(period > 0)) return;
    const userRate = clock.rate(); // the spin cap (if any) was released by leaveAll() before launch
    const cap = rateCap(userRate, T, period);
    if (cap == null || !Number.isFinite(cap)) return;
    const capSigned = Math.sign(userRate || 1) * Math.abs(cap);
    if (Math.abs(capSigned) >= Math.abs(userRate)) return;
    ease.active = true; ease.restore = true; ease.t = 0;
    ease.r0 = userRate;
    ease.r1 = capSigned;
    ease.userRate = userRate;
    ease.lastSet = userRate;
  }
  function stepRateEase(dt) {
    if (!ease.active) return;
    if (clock.rate() !== ease.lastSet) { // the user changed the rate mid-flight: leave it alone
      ease.active = false; ease.restore = false; return;
    }
    ease.t += dt;
    const w = minJerk(ease.t / RATE_EASE_S);
    const r = ease.r0 + (ease.r1 - ease.r0) * w;
    clock.setRate(r);
    ease.lastSet = r;
    if (w >= 1) ease.active = false; // hold at the cap; `restore` stays true
  }
  /** Put the user's rate back (arrival or cancel). @returns {boolean} restored */
  function endRateEase() {
    const wasEasing = ease.active;
    ease.active = false;
    if (!ease.restore) return false;
    ease.restore = false;
    if (!wasEasing && clock.rate() !== ease.lastSet) return false; // user touched the rate meanwhile
    clock.setRate(ease.userRate);
    return true;
  }

  // ---- spin cap (follow) ---------------------------------------------------------------------------------------------
  function releaseSpinCap(restore) {
    if (!spin.active) return false;
    spin.active = false;
    res.spinCapChanged = 'off';
    if (restore && clock.rate() === spin.applied) { clock.setRate(spin.userRate); return true; }
    return false;
  }
  function updateSpinCap(id) {
    if (!getSpinRateDegPerDay || !settings().spinCap) { if (releaseSpinCap(true)) res.rateRestored = true; return; }
    const degPerDay = Math.abs(getSpinRateDegPerDay(id));
    if (!(degPerDay > 0)) { if (releaseSpinCap(true)) res.rateRestored = true; return; }
    const cap = SPIN_CAP_DEG_PER_S / degPerDay; // days/s such that spin ≤ 360°/s (6°/frame at 60 fps)
    const R = getDispRadiusAu(id);
    const px = pxRadius(R, camera.position.distanceTo(vB), camera.fov * DEG, viewportH());
    const rate = clock.rate();
    if (!spin.active) {
      if (px > SPIN_CAP_PX_ON && Math.abs(rate) > cap) {
        spin.active = true; spin.userRate = rate; spin.applied = Math.sign(rate) * cap;
        clock.setRate(spin.applied);
        res.spinCapChanged = 'on';
      }
    } else if (rate !== spin.applied) {
      // The user changed the rate while capped: re-evaluate against the new wish.
      if (Math.abs(rate) > cap && px > SPIN_CAP_PX_OFF) {
        spin.userRate = rate; spin.applied = Math.sign(rate) * cap; clock.setRate(spin.applied);
      } else {
        spin.active = false; res.spinCapChanged = 'off';
      }
    } else if (px < SPIN_CAP_PX_OFF) {
      if (releaseSpinCap(true)) res.rateRestored = true;
    } else if (Math.abs(spin.applied) !== cap) { // followed body / spin rate changed under us
      spin.applied = Math.sign(spin.applied) * cap; clock.setRate(spin.applied);
    }
    res.spinCapped = spin.active;
    res.spinCapRate = spin.active ? spin.applied : null;
  }

  // ---- mode transitions ----------------------------------------------------------------------------------------------
  /** Leave whatever is running (no animation); rates and fov restored; controls left disabled for the caller to decide. */
  function leaveAll({ keepTour = false } = {}) {
    if (flight) {
      if (endRateEase()) res.rateRestored = true;
      flight = null;
    }
    if (fade) { fade = null; emitFade(0); }
    if (releaseSpinCap(true)) res.rateRestored = true;
    if (!keepTour) endTour();
    restoreFov();
    sky = null;
    pose = null;
    followId = null;
    controls.autoRotate = false;
  }

  function follow(id) {
    if (!id || !getBodyState(id)) return;
    const wasFlying = mode === 'flyby';
    leaveAll({ keepTour: true });
    mode = 'follow';
    followId = id;
    bodyVec(id, vB);
    controls.target.copy(vB);
    configureFollowControls(id);
    controls.enabled = true;
    if (!wasFlying) {
      // Entering from a free pose keeps the camera where it is; resync the spherical state once.
      controls.update();
    }
  }

  function free() {
    const lookAtSky = mode === 'skyView' && sky;
    if (lookAtSky) { skyLookPoint(vTmp); controls.target.copy(vTmp); }
    leaveAll();
    mode = 'free';
    configureFreeControls();
    controls.enabled = true;
    controls.update();
  }

  /** @param {Vector3} out */
  function skyLookPoint(out) {
    out.set(0, 0, 0);
    for (let i = 0; i < sky.to.length; i++) out.add(bodyVec(sky.to[i], vTmp2));
    return out.multiplyScalar(1 / sky.to.length);
  }

  function skyView(fromId, toId) {
    const to = Array.isArray(toId) ? toId.filter((t) => !!getBodyState(t)) : (getBodyState(toId) ? [toId] : []);
    if (!getBodyState(fromId) || !to.length) return;
    leaveAll();
    mode = 'skyView';
    sky = { from: fromId, to };
    controls.enabled = false;
    updateSky();
  }

  function updateSky() {
    const from = bodyVec(sky.from, vTmp);
    const look = skyLookPoint(vL);
    vD.copy(look).sub(from);
    const dist = vD.length();
    if (dist > 0) vD.multiplyScalar(1 / dist); else vD.set(1, 0, 0);
    camera.position.copy(from).addScaledVector(vD, SKY_OFFSET_R * getDispRadiusAu(sky.from));
    camera.lookAt(look);
    // fov: every target's projected radius ≥ 40 px (but ≥ 10°); pairs also fit their angular spread with a margin.
    const H = viewportH();
    let tanHalf = Math.tan(baseFov * DEG / 2);
    let spread = 0;
    for (let i = 0; i < sky.to.length; i++) {
      const id = sky.to[i];
      const b = bodyVec(id, vTmp2);
      const d = Math.max(b.distanceTo(camera.position), 1e-12);
      if (H > 0) tanHalf = Math.min(tanHalf, getDispRadiusAu(id) * H / (2 * SKY_TARGET_PX * d));
      if (sky.to.length > 1) {
        vTmp2.sub(camera.position).normalize();
        spread = Math.max(spread, vTmp2.angleTo(vD));
      }
    }
    let fov = 2 * Math.atan(tanHalf) / DEG;
    if (spread > 0) fov = Math.max(fov, 2 * spread * SKY_PAIR_MARGIN / DEG);
    fov = MathUtils.clamp(fov, SKY_MIN_FOV_DEG, baseFov);
    if (Math.abs(fov - camera.fov) > 1e-3) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }

  // ---- fly-by --------------------------------------------------------------------------------------------------------
  /**
   * @param {string} id destination body
   * @param {{ from?: string|null }} [opts] departure body override (the departure pose tracks that body's motion)
   * @returns {boolean} false when the destination is invalid
   */
  function flyTo(id, opts = {}) {
    if (!id || !getBodyState(id)) return false;
    // Departure pose: A tracks the body we are attached to (follow / sky view / dwell), else fixed.
    let fromId = opts.from !== undefined ? opts.from : null;
    if (fromId === null) {
      if (mode === 'follow' && followId) fromId = followId;
      else if (mode === 'skyView' && sky) fromId = sky.from;
    }
    currentLookPoint(sL);
    const L0 = [sL[0], sL[1], sL[2]];
    const p = camera.position;
    const A0 = [p.x, p.y, p.z];
    let fromOffset = null;
    if (fromId && getBodyState(fromId)) {
      bodyPos(fromId, sTmp);
      fromOffset = [A0[0] - sTmp[0], A0[1] - sTmp[1], A0[2] - sTmp[2]];
    } else {
      fromId = null;
    }
    qTmp.copy(camera.quaternion);
    // A flight already running is abandoned in place (its rate easing restored); the new one starts from rest.
    leaveAll({ keepTour: true });
    mode = 'flyby';
    controls.enabled = false;
    controls.autoRotate = false;
    const rDisp = getDispRadiusAu(id);
    const fovRad = camera.fov * DEG;

    // Launch geometry: E = B + arrivalOffset, D = |E − A| at launch.
    bodyPos(id, sB);
    departure(fromId, fromOffset, A0, sA);
    arrival(id, sA, sB, rDisp, fovRad, sE);
    const D = Math.hypot(sE[0] - sA[0], sE[1] - sA[1], sE[2] - sA[2]);
    if (reduced()) {
      flight = {
        kind: 'fade', phase: 'fadeOut', target: id, from: fromId, fromOffset, A0, L0, rDisp, D, T: 2 * FADE_S,
        t: 0, tau: 0, speedC: 0, lookDist: Math.hypot(L0[0] - A0[0], L0[1] - A0[1], L0[2] - A0[2]),
      };
      fade = { phase: 'out', t: 0 };
      emitFade(0);
      return true;
    }
    const T = duration(D);
    const profile = planProfile({ D, T, rDisp });
    const H = arcHeight(D, rDisp);
    // Heading test for the quaternion blend: current forward vs direction to the destination, plus any mismatch between
    // the actual orientation and lookAt(A, L0) (e.g. right after setLookTarget) so the first frame never snaps.
    camera.getWorldDirection(vFwd);
    vD.set(sB[0] - A0[0], sB[1] - A0[1], sB[2] - A0[2]);
    const heading = vD.lengthSq() > 0 ? vFwd.angleTo(vD) : 0;
    vL.set(L0[0], L0[1], L0[2]);
    camera.lookAt(vL);
    qLook.copy(camera.quaternion);
    camera.quaternion.copy(qTmp);
    const mismatch = qTmp.angleTo(qLook);
    const slerp = heading > LOOK_SLERP_HEADING_RAD || mismatch > LOOK_SLERP_MISMATCH_RAD;
    flight = {
      kind: profile.kind, phase: 'fly', target: id, from: fromId, fromOffset, A0, L0, rDisp, D, T, H, profile,
      t: 0, tau: 0, speedC: 0, prevSpeedC: 0, beatArmed: false, slerp, q0: slerp ? qTmp.clone() : null,
      lookDist: Math.hypot(L0[0] - A0[0], L0[1] - A0[1], L0[2] - A0[2]),
      started: false, decel: null,
    };
    vPrev.copy(camera.position);
    beginRateEase(id, T);
    return true;
  }

  /** A(t): the departure body's current position plus the launch offset, or the fixed launch point. */
  function departure(fromId, fromOffset, A0, out) {
    if (fromId && fromOffset) {
      bodyPos(fromId, out);
      out[0] += fromOffset[0]; out[1] += fromOffset[1]; out[2] += fromOffset[2];
    } else {
      out[0] = A0[0]; out[1] = A0[1]; out[2] = A0[2];
    }
    return out;
  }
  /** E(t) = B(t) + arrivalOffset (Sun handled by flyby.js via the departure direction). */
  function arrival(id, A, B, rDisp, fovRad, out) {
    const off = arrivalOffset({ bodyPos: B, departurePos: A, rDisp, fovRad, up: UP }, sOff);
    out[0] = B[0] + off[0]; out[1] = B[1] + off[1]; out[2] = B[2] + off[2];
    return out;
  }

  function updateFlight(dt) {
    const f = flight;
    if (f.phase === 'decel') { updateDecel(dt); return; }
    if (f.kind === 'fade') { updateFadeFlight(dt); return; }
    f.t += dt;
    const tau = Math.min(1, f.t / f.T);
    f.tau = tau;
    const s = f.profile.s(tau);
    bodyPos(f.target, sB);
    departure(f.from, f.fromOffset, f.A0, sA);
    arrival(f.target, sA, sB, f.rDisp, camera.fov * DEG, sE);
    lateralNormal(sA, sE, UP, sN);
    const P = pathPoint(sA, sE, s, f.H, sN, sP);
    // Look point L = lerp(L0, B, s); roll-free look-at with up = +Z.
    sL[0] = f.L0[0] + (sB[0] - f.L0[0]) * s;
    sL[1] = f.L0[1] + (sB[1] - f.L0[1]) * s;
    sL[2] = f.L0[2] + (sB[2] - f.L0[2]) * s;
    camera.position.set(P[0], P[1], P[2]);
    vL.set(sL[0], sL[1], sL[2]);
    camera.lookAt(vL);
    if (f.slerp && tau < LOOK_SLERP_FRACTION) {
      const w = minJerk(tau / LOOK_SLERP_FRACTION);
      qLook.copy(camera.quaternion);
      camera.quaternion.slerpQuaternions(f.q0, qLook, w);
    }
    f.lookDist = Math.hypot(sL[0] - P[0], sL[1] - P[1], sL[2] - P[2]);
    // Speed, beat, streaks, velocity direction.
    const speedC = trueSpeedC(f.profile, tau, f.D, f.H);
    f.speedC = speedC;
    res.speedC = speedC;
    if (f.kind === 'warp' && f.started && tau < 1) {
      if ((f.prevSpeedC < 1 && speedC >= 1) || (f.prevSpeedC >= 1 && speedC < 1)) res.lightspeedBeat = true;
    }
    f.prevSpeedC = speedC;
    f.started = true;
    vVel.copy(camera.position).sub(vPrev);
    if (vVel.lengthSq() > 0) {
      vVel.normalize();
      res.velDir[0] = vVel.x; res.velDir[1] = vVel.y; res.velDir[2] = vVel.z;
    }
    vPrev.copy(camera.position);
    stepRateEase(dt);
    if (tau >= 1) arrive();
  }

  function arrive() {
    const id = flight.target;
    if (endRateEase()) res.rateRestored = true;
    flight = null;
    follow(id);
    controls.update(); // resync the spherical state once (research §3.4)
    res.arrived = id;
    if (tour) {
      tour.phase = 'dwell';
      tour.dwellLeft = tour.dwell;
      controls.autoRotate = !reduced();
      controls.autoRotateSpeed = TOUR_AUTOROTATE_SPEED;
    }
  }

  function updateFadeFlight(dt) {
    const f = flight;
    f.t += dt;
    if (f.phase === 'fadeOut') {
      emitFade(Math.min(1, f.t / FADE_S));
      if (f.t >= FADE_S) {
        // Cut to the arrival pose, then keep following while the fade-in runs.
        bodyPos(f.target, sB);
        departure(f.from, f.fromOffset, f.A0, sA);
        arrival(f.target, sA, sB, f.rDisp, camera.fov * DEG, sE);
        camera.position.set(sE[0], sE[1], sE[2]);
        vL.set(sB[0], sB[1], sB[2]);
        camera.lookAt(vL);
        vPrev.copy(camera.position);
        fade = { phase: 'in', t: 0 };
        arrive();
      }
    }
  }

  function updateFade(dt) {
    if (!fade) return;
    fade.t += dt;
    if (fade.phase === 'in') {
      emitFade(Math.max(0, 1 - fade.t / FADE_S));
      if (fade.t >= FADE_S) fade = null;
    }
  }

  /** Esc mid-flight: decelerate in place over 0.6 s, then free with the target on the current look point. */
  function beginDecel() {
    const f = flight;
    const speedAu = f.speedC * C_AU_S; // AU per real second
    const remaining = Math.hypot(sE[0] - camera.position.x, sE[1] - camera.position.y, sE[2] - camera.position.z);
    // v(t) = v0·(1 − minJerk(t/0.6)) travels v0·0.3 s; clamp the coast to a fraction of the remaining chord.
    const vMax = CANCEL_COAST_FRACTION * remaining / (CANCEL_DECEL_S / 2);
    const v0 = Math.min(speedAu, vMax);
    f.decel = { t: 0, v0 };
    f.phase = 'decel';
    vVel.set(res.velDir[0], res.velDir[1], res.velDir[2]);
    f.lookDist = Math.max(f.lookDist, 10 * f.rDisp);
  }

  function updateDecel(dt) {
    const f = flight;
    const d = f.decel;
    d.t += dt;
    const u = Math.min(1, d.t / CANCEL_DECEL_S);
    const v = d.v0 * (1 - minJerk(u));
    camera.position.addScaledVector(vVel, v * dt);
    res.speedC = v / C_AU_S;
    f.speedC = res.speedC;
    if (u >= 1) {
      camera.getWorldDirection(vFwd);
      vTmp.copy(camera.position).addScaledVector(vFwd, f.lookDist);
      flight = null;
      mode = 'free';
      controls.target.copy(vTmp);
      configureFreeControls();
      controls.enabled = true;
      controls.update();
      res.speedC = 0;
    }
  }

  /**
   * Esc: cancel a flight (decelerate in place), a tour, a sky view or a pose animation.
   * @returns {boolean} true when something was cancelled
   */
  function cancel() {
    if (fade && flight && flight.kind === 'fade') { // reduced-motion flight: finish the cut immediately
      flight.t = FADE_S; endTour(); updateFadeFlight(0); fade = null; emitFade(0); return true;
    }
    if (mode === 'flyby' && flight) {
      endTour();
      if (flight.phase === 'decel') return true;
      if (endRateEase()) res.rateRestored = true;
      beginDecel();
      return true;
    }
    if (tour) { endTour(); return true; } // dwelling: stay in follow mode, autoRotate off
    if (pose) { finishPose(); return true; }
    if (mode === 'skyView') { free(); return true; }
    return false;
  }

  // ---- tour ----------------------------------------------------------------------------------------------------------
  function onTourInput() { cancel(); }
  function tourStart(ids, { dwellSeconds = TOUR_DWELL_S } = {}) {
    endTour();
    const list = (ids && ids.length ? ids : TOUR_DEFAULT_IDS).filter((id) => !!getBodyState(id));
    if (!list.length) return;
    tour = { ids: list, i: 0, dwell: dwellSeconds, dwellLeft: 0, phase: 'fly' };
    canvas.addEventListener('pointerdown', onTourInput);
    canvas.addEventListener('wheel', onTourInput, { passive: true });
    if (win) win.addEventListener('keydown', onTourInput);
    flyTo(list[0]);
  }
  function endTour() {
    if (!tour) return;
    tour = null;
    controls.autoRotate = false;
    canvas.removeEventListener('pointerdown', onTourInput);
    canvas.removeEventListener('wheel', onTourInput);
    if (win) win.removeEventListener('keydown', onTourInput);
  }
  function updateTourDwell(dt) {
    if (!tour || tour.phase !== 'dwell') return;
    tour.dwellLeft -= dt;
    if (tour.dwellLeft > 0) return;
    tour.i += 1;
    if (tour.i >= tour.ids.length) { endTour(); return; }
    tour.phase = 'fly';
    flyTo(tour.ids[tour.i]);
  }

  // ---- animated free poses (home, event framings) --------------------------------------------------------------------
  function viewPose({ position, target, seconds = HOME.seconds }) {
    currentLookPoint(sTmp);
    leaveAll();
    mode = 'free';
    configureFreeControls();
    controls.enabled = false;
    pose = {
      t: 0, seconds: reduced() ? 0 : seconds,
      p0: new Vector3().copy(camera.position),
      p1: new Vector3(position[0], position[1], position[2]),
      t0: new Vector3(sTmp[0], sTmp[1], sTmp[2]),
      t1: new Vector3(target[0], target[1], target[2]),
    };
    updatePose(0);
  }
  function updatePose(dt) {
    pose.t += dt;
    const w = pose.seconds > 0 ? minJerk(pose.t / pose.seconds) : 1;
    posePos.lerpVectors(pose.p0, pose.p1, w);
    poseTgt.lerpVectors(pose.t0, pose.t1, w);
    camera.position.copy(posePos);
    camera.lookAt(poseTgt);
    if (w >= 1) finishPose();
  }
  function finishPose() {
    if (!pose) return;
    controls.target.copy(pose.t1);
    camera.position.copy(pose.p1);
    pose = null;
    controls.enabled = true;
    controls.update();
  }
  function resetHome() {
    const polar = HOME.polarDeg * DEG, az = HOME.azimuthDeg * DEG, d = HOME.distanceAu;
    viewPose({
      position: [d * Math.sin(polar) * Math.cos(az), d * Math.sin(polar) * Math.sin(az), d * Math.cos(polar)],
      target: [0, 0, 0],
      seconds: HOME.seconds,
    });
  }
  /** Top-down framing of a bounding sphere (Events "View" for oppositions / conjunctions / parades). */
  function frameTopDown({ center, radius, seconds = HOME.seconds, polarDeg = 20 }) {
    const halfV = camera.fov * DEG / 2;
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    const dist = Math.max(radius, 1e-6) / Math.sin(Math.min(halfV, halfH)) * 1.05;
    const polar = polarDeg * DEG, az = HOME.azimuthDeg * DEG;
    viewPose({
      position: [
        center[0] + dist * Math.sin(polar) * Math.cos(az),
        center[1] + dist * Math.sin(polar) * Math.sin(az),
        center[2] + dist * Math.cos(polar),
      ],
      target: [center[0], center[1], center[2]],
      seconds,
    });
  }
  function setLookTarget(point) {
    if (point && point.isVector3) controls.target.copy(point);
    else controls.target.set(point[0], point[1], point[2]);
  }

  // ---- per-frame update ----------------------------------------------------------------------------------------------
  /**
   * @param {number} dtReal real seconds since the last frame
   * @param {number} jdTT   current ephemeris time (the body states are read through getBodyState for this instant)
   * @returns {RigUpdate}
   */
  function update(dtReal, jdTT) { // eslint-disable-line no-unused-vars
    const dt = Math.min(Math.max(dtReal || 0, 0), MAX_DT);
    res.lightspeedBeat = false; res.rateRestored = false; res.arrived = null; res.spinCapChanged = null;
    res.speedC = 0;

    if (mode === 'flyby' && flight) {
      updateFlight(dt);
    }
    if (mode === 'follow' && followId) {
      // Rigid translation with the body BEFORE controls.update() (plan §Fly-by "Arrival").
      bodyVec(followId, vB);
      vD.copy(vB).sub(controls.target);
      camera.position.add(vD);
      controls.target.copy(vB);
      updateSpinCap(followId);
      updateTourDwell(dt);
      if (mode === 'follow') controls.update(dt);
    } else if (mode === 'skyView' && sky) {
      updateSky();
    } else if (mode === 'free') {
      if (pose) updatePose(dt); else controls.update(dt);
    }
    updateFade(dt);

    // Streaks: eased toward the speed law; none under reduced motion or on min-jerk hops.
    const inWarp = mode === 'flyby' && flight && !reduced() && (flight.kind === 'warp' || flight.phase === 'decel');
    streakBase = MathUtils.damp(streakBase, inWarp ? streakTarget(res.speedC) : 0, STREAK_LAMBDA, dt);
    if (streakBase < 1e-4) streakBase = 0;
    if (res.lightspeedBeat) beatImpulse += BEAT_IMPULSE;
    beatImpulse = MathUtils.damp(beatImpulse, 0, BEAT_LAMBDA, dt);
    if (beatImpulse < 1e-4) beatImpulse = 0;
    res.streak = Math.min(1, streakBase + beatImpulse);
    if (!spin.active) { res.spinCapped = false; res.spinCapRate = null; }

    syncStore();
    return res;
  }

  /** Push cameraMode / followed / flyby to the store (a fresh FlybyStatus object whenever a flight is running). */
  function syncStore() {
    const pm = publicMode();
    const fol = mode === 'follow' ? followId : null;
    let write = false;
    if (pm !== storeMode) { patch.cameraMode = pm; storeMode = pm; write = true; }
    if (fol !== storeFollowed) { patch.followed = fol; storeFollowed = fol; write = true; }
    if (flight && flight.phase !== 'decel') {
      bodyPos(flight.target, sTmp);
      const lightMin = Math.hypot(sTmp[0] - camera.position.x, sTmp[1] - camera.position.y, sTmp[2] - camera.position.z)
        * LIGHT_TIME_AU_S / 60;
      patch.flyby = {
        target: flight.target, from: flight.from, tau: flight.tau, speedC: flight.speedC,
        lightMinutesToTarget: lightMin, kind: flight.kind === 'fade' ? 'minjerk' : flight.kind,
      };
      storeFlyby = patch.flyby; write = true;
    } else if (storeFlyby !== null) {
      patch.flyby = null; storeFlyby = null; write = true;
    }
    if (write) store.set(patch);
  }

  function onFade(fn) {
    fadeListeners.add(fn);
    return () => fadeListeners.delete(fn);
  }

  function dispose() {
    endTour();
    fadeListeners.clear();
    controls.dispose();
  }

  configureFreeControls();
  controls.update();

  // Public transitions sync the store immediately so UI code reading store.get() right after a call sees the new mode.
  return {
    mode: publicMode,
    follow: (id) => { follow(id); syncStore(); },
    free: () => { free(); syncStore(); },
    skyView: (fromId, toId) => { skyView(fromId, toId); syncStore(); },
    flyTo: (id, opts) => { const ok = flyTo(id, opts); syncStore(); return ok; },
    tour: (ids, opts) => { tourStart(ids, opts); syncStore(); },
    cancel: () => { const did = cancel(); syncStore(); return did; },
    resetHome: () => { resetHome(); syncStore(); },
    update,
    controls,
    setLookTarget,
    onFade,
    viewPose: (o) => { viewPose(o); syncStore(); },
    frameTopDown: (o) => { frameTopDown(o); syncStore(); },
    dispose,
    /** @returns {string|null} */
    followed: () => (mode === 'follow' ? followId : null),
  };
}

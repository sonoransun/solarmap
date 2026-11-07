// CameraRig: free | follow | skyView | flyby on top of OrbitControls (three r186) and the pure fly-by / glide math in
// src/astro/flyby.js. Implements plan §"Fly-by specification" (/Users/user/.claude/plans/implement-the-features-described-curried-spark.md)
// and the shared contracts §"Camera rig API additions": every change of view is an animated glide (position about a
// pivot with the direction slerped and the log distance lerped, orientation slerped, fov eased in zoom space) and
// nothing cuts except under reduced motion.
//
// r186 facts honoured here (verified in node_modules/three/examples/jsm/controls/OrbitControls.js):
//  - the controls cache the up quaternion ONCE in the constructor (`this._quat = …setFromUnitVectors(object.up, +Y)`,
//    line 406), so `camera.up.set(0, 0, 1)` MUST precede `new OrbitControls(camera, canvas)` and `camera.up` must never
//    change afterwards (recreate the controls if it does);
//  - with `zoomToCursor` on, `update()` rewrites `controls.target` on every dolly (lines 815–885); follow mode translates
//    camera and target rigidly with the body each frame, so `zoomToCursor` is enabled in free mode only;
//  - damping is applied once per update() CALL (`spherical += delta·f`, lines 717–718; `delta *= 1 − f`, 801–804) and
//    is NOT scaled by the deltaTime argument, so the inertia would differ between 60 and 120 Hz: dampingForFrame()
//    rescales the factor every frame (flyby.js);
//  - `update(deltaTime)` takes seconds and makes autoRotate frame-rate independent (lines 932–940:
//    angle = 2π/60·autoRotateSpeed·dt, i.e. autoRotateSpeed 1 = 6°/s); autoRotate pauses while a drag is in progress
//    (line 709, `state === NONE`);
//  - the damping residuals live in `_sphericalDelta`, `_panOffset`, `_scale` (lines 411–414): a glide that starts right
//    after a drag flushes them, or the controls would replay the leftover inertia when they resume;
//  - `update()` ignores `enabled` (only the input handlers check it), so the rig calls it only when it wants a resync;
//  - `connect(el)` sets `touch-action: none` on the canvas and captures pointers on it (line 508, 1559) — only while
//    enabled, which is why picking.js tracks pointer ids at window level.
//
// Frame: scene = ecliptic J2000, 1 unit = 1 AU, z = ecliptic north (CLAUDE.md). Physics vectors are plain [x, y, z]
// arrays (flyby.js contract); the camera side uses THREE.Vector3. No per-frame allocations: after construction the
// only objects created are store patches (the store compares values by identity, throttled to ≤ 20 Hz for the flight
// status), a flight record per flyTo() and queued signals (all user- or story-triggered, never per frame).
//
// Sim rate: the rig never writes the clock. While a fly-by rate cap or the follow-mode spin cap binds it REPORTS a
// ceiling (RigUpdate.rateCap, days per second, unsigned); main.js feeds sign(wish)·min(|wish|, rateCap) into the one
// rate ramp (astro/clock.js createRateRamp), so every rate change — user, story, cap engage, cap release — goes through
// the same easing and there is exactly one writer. `clock.rate()` passed in here must therefore return the USER'S WISH
// (the rate last asked for), not the eased or capped value the clock is running at.

import { MathUtils, Quaternion, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  arcHeight, arrivalOffset, duration, lateralNormal, pathPoint, planProfile, trueSpeedC,
  glideDuration, zoomFromFov, fovFromZoom, boundingSphere, skyFitFovRad, dampingForFrame, cancelDecelSeconds,
  RATE_PERIOD_FRACTION, SKY_MIN_FOV_RAD, SKY_MAX_FOV_RAD, SUN_EPSILON_AU,
} from '../astro/flyby.js';
import { C_AU_S, DEG, LIGHT_TIME_AU_S } from '../astro/constants.js';

/** Ecliptic north — the only camera "up" (CLAUDE.md: z = ecliptic north; plan §Rendering "camera.up.set(0,0,1)"). */
const UP = Object.freeze([0, 0, 1]);

/** Home view (plan §Rendering "polar angle 35° from +Z, 42 AU from the Sun"). `seconds` is the legacy fixed length kept
 *  for callers that want it; resetHome() itself uses the glide duration law (0.8–2.2 s by distance and turn). */
export const HOME = Object.freeze({ distanceAu: 42, polarDeg: 35, azimuthDeg: -90, seconds: 1.2 });
/** OrbitControls damping per 60 Hz frame (plan §Rendering); rescaled per frame by dampingForFrame(). */
const DAMPING = 0.08;
/** Follow-mode distance clamps in display radii (plan §Fly-by "Arrival"). */
const FOLLOW_MIN_R = 1.2;
const FOLLOW_MAX_R = 5000;
/** Free-mode clamps: 5e-6 AU ≈ 750 km (inside any planet at k = 1), 4000 AU (< the 5000 AU star sphere). */
const FREE_MIN_AU = 5e-6;
const FREE_MAX_AU = 4000;
/** Spin cap (plan §Fly-by "Follow-mode spin cap"): engage above 40 px projected radius, release below 36 px, and bind
 *  only when the wish exceeds the cap by 10 % (SPIN_CAP_BIND_FACTOR): Earth at the default 1 d/s spins 360.985°/day,
 *  0.27 % over the 360°/s cap, which used to toast "Time slowed" on every Earth arrival for nothing. 360°/s = 6°/frame
 *  at 60 fps. */
const SPIN_CAP_PX_ON = 40;
const SPIN_CAP_PX_OFF = 36;
const SPIN_CAP_DEG_PER_S = 360;
const SPIN_CAP_BIND_FACTOR = 1.1;
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
/** Reduced motion: 250 ms fade → cut → 250 ms fade (plan §Fly-by "Reduced motion"). */
const FADE_S = 0.25;
/** Sky view (plan §Fly-by "Sky view"; contracts): camera at body centre + 1.5 R toward the target; entry glide 1.0 s,
 *  exit 0.8 s; the fit fov follows the moving targets with an exponential damp (λ = 6 → 0.5 s to settle, so a clock
 *  jump re-fits smoothly instead of snapping); setSkyFov default 0.6 s. */
const SKY_OFFSET_R = 1.5;
const SKY_ENTER_S = 1.0;
const SKY_EXIT_S = 0.8;
const SKY_FOV_LAMBDA = 6;
const SKY_FOV_SET_S = 0.6;
/** Leaving sky view: the orbit centre is put this many display radii ahead (the target centroid is AU away and would
 *  make a drag swing the camera across the system). */
const SKY_EXIT_PIVOT_R = 10;
/** Follow entry: approach from beyond 5000 R over 1.2 s (contracts); an entry that only needs a turn uses the glide
 *  law; already aimed within 1° at the right distance and fov → instant hand-over. */
const FOLLOW_APPROACH_S = 1.2;
const AIM_TOLERANCE_RAD = 1 * DEG;
/** Leaving follow / sky view: the rigid translation with the body fades out over 0.8 s instead of stopping dead. */
const RELEASE_S = 0.8;
/** Fly-by launched from a narrowed fov (sky view): the fov eases back to base over min(1 s, 35 % of the flight). */
const FLY_FOV_EASE_MAX_S = 1.0;
const FLY_FOV_EASE_FRACTION = 0.35;
/** Fov restore after a cancel (short, independent of the controls). */
const FOV_RESTORE_S = 0.5;
/** Dwell (contracts orbitDwell): autoRotate eased in/out over 1.5 s; elevation drift bounces between 10° and 170° of
 *  polar angle. r186: autoRotateSpeed 1 = 6°/s. */
const DWELL_EASE_S = 1.5;
const DWELL_POLAR_MIN_RAD = 10 * DEG;
const DWELL_POLAR_MAX_RAD = 170 * DEG;
const AUTOROTATE_DEG_PER_S_PER_UNIT = 6;
/** Store throttles: flight status every 50 ms of flight time (20 Hz; τ resolution 0.05/T ≤ 0.034 for the shortest
 *  1.5 s flight) plus the launch frame; sky fov when it changed by ≥ 0.5 %. */
const FLYBY_STORE_S = 0.05;
const SKY_STORE_FOV_REL = 0.005;
/** Degenerate pivot guard (AU): a glide whose camera sits on its pivot gets this distance instead of log(0). */
const MIN_PIVOT_AU = 1e-9;
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
 * @property {boolean} rateRestored    true on the frame a binding rate cap (fly-by or spin) was lifted: the wish applies again
 * @property {string|null} arrived     body id on the frame a fly-by arrived
 * @property {boolean} poseDone        true on the frame a viewPose / frameTopDown / frameBodies / dollyTo / follow approach / exitSkyView finished
 * @property {boolean} skyReady        true on the frame a sky-view entry finished (the view is settled on the targets)
 * @property {number|null} rateCap     ceiling on |sim rate| in days/s that main.js must apply this frame (fly-by cap or
 *                                     spin cap, whichever is lower); null = the user's wish applies unchanged
 * @property {boolean} spinCapped      the follow-mode spin cap is currently binding
 * @property {'on'|'off'|null} spinCapChanged  transition of the spin cap on this frame
 * @property {number|null} spinCapRate  the signed capped rate (days/s) while spinCapped
 * @property {number} dim              reduced-motion fade amount 0…1 (also delivered through onFade)
 */

/**
 * @typedef {{ type: 'arrived'|'poseDone'|'skyReady'|'cancelled', id: string|null }} RigSignal
 */

/**
 * @typedef {object} CameraRig
 * @property {() => 'free'|'follow'|'skyView'|'flyby'} mode
 * @property {(id: string, opts?: { seconds?: number|null }) => boolean} follow  attach to a body; animated approach / turn when needed
 * @property {() => boolean} free        leave follow / sky view / a glide with animation (fov restore, release blend); decelerates a flight
 * @property {(fromId: string, toIds: string|string[], opts?: { fovDeg?: number|null, lock?: boolean, animateS?: number|null }) => boolean} skyView
 * @property {(fovDeg: number, seconds?: number) => boolean} setSkyFov
 * @property {(seconds?: number) => boolean} exitSkyView
 * @property {(id: string, opts?: { from?: string|null }) => boolean} flyTo
 * @property {() => false} tour          compatibility stub: the story engine replaced the rig tour (always false)
 * @property {() => boolean} cancel      Esc: decelerate a flight, stop a glide in place, leave sky view / dwell / follow
 * @property {() => void} resetHome
 * @property {(opts: { position: ArrayLike<number>, target: ArrayLike<number>, seconds?: number|null }) => void} viewPose
 * @property {(opts: { center: ArrayLike<number>, radius: number, seconds?: number|null, polarDeg?: number }) => void} frameTopDown
 * @property {(ids: string[], opts?: { includeSun?: boolean, polarDeg?: number, seconds?: number|null, margin?: number }) => boolean} frameBodies
 * @property {(distanceAu: number, seconds?: number|null) => boolean} dollyTo
 * @property {(opts?: { degPerS?: number, elevationDriftDeg?: number }) => boolean} orbitDwell
 * @property {() => void} stopDwell
 * @property {(fn: (sig: RigSignal) => void) => () => void} onSignal
 * @property {(dtReal: number, jdTT: number) => RigUpdate} update
 * @property {import('three/addons/controls/OrbitControls.js').OrbitControls} controls
 * @property {(point: ArrayLike<number>|Vector3) => void} setLookTarget
 * @property {(fn: (dim: number) => void) => () => void} onFade
 * @property {() => string|null} followed   id of the followed body (null outside follow mode)
 * @property {() => number} baseFovDeg
 * @property {() => void} dispose
 */

/**
 * Create the camera rig.
 * @param {object} o
 * @param {import('three').PerspectiveCamera} o.camera  PerspectiveCamera with `up` = (0,0,1) (asserted and fixed here)
 * @param {HTMLCanvasElement} o.canvas                   the WebGL canvas (OrbitControls connects to it)
 * @param {ReturnType<import('../app/state.js').createStore>} o.store
 * @param {(id: string) => {x:number,y:number,z:number,vx:number,vy:number,vz:number}} o.getBodyState  scene-frame state (AU, AU/day)
 * @param {(id: string) => number} o.getDispRadiusAu     displayed radius (R_disp incl. the size exaggeration; Sun uses min(k, 30));
 *                                                       re-read every frame, so a sizeK change is picked up at once
 * @param {(id: string) => number|null} o.getPeriodDays  sidereal orbital period in days; null / 0 / NaN = no fly-by rate
 *                                                       cap (pass null for the Sun — a body at the origin is never capped anyway)
 * @param {{ rate: () => number }} o.clock               rate() = the USER'S requested sim rate (days/s, signed); the rig
 *                                                       never calls setRate (an old `setRate` member is ignored)
 * @param {() => boolean} o.isReducedMotion
 * @param {(id: string) => number} [o.getSpinRateDegPerDay]  |Ẇ| in °/day; absent → no spin cap
 * @param {() => number} [o.getViewportHeight]           CSS px; default canvas.clientHeight
 * @param {() => number} [o.getSafeInsetBottom]         CSS px covered by UI at the bottom of the viewport (the story caption
 *   bar); sky views and top-down framings centre their subject in the remaining area so captions never cover it
 * @returns {CameraRig}
 */
export function createCameraRig({
  camera, canvas, store, getBodyState, getDispRadiusAu, getPeriodDays, clock, isReducedMotion,
  getSpinRateDegPerDay = null, getViewportHeight = null, getSafeInsetBottom = null,
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
  const zBase = zoomFromFov(baseFov * DEG);

  // ---- state -------------------------------------------------------------------------------------------------------
  /** @type {'free'|'follow'|'skyView'|'flyby'} */
  let mode = 'free';
  /** @type {string|null} */
  let followId = null;
  /** display radius the follow limits were last configured for (NaN outside follow) */
  let followR = NaN;
  /** @type {object|null} active flight (see flyTo()) */
  let flight = null;
  /** @type {{ phase: 'out'|'in', t: number }|null} reduced-motion fade */
  let fade = null;
  /** @type {Set<(dim: number) => void>} */
  const fadeListeners = new Set();
  /** @type {Set<(sig: RigSignal) => void>} */
  const signalListeners = new Set();
  /** @type {RigSignal[]} signals queued for the next update() */
  const signalQueue = [];
  let lastDim = 0;

  /** Animated transition (startGlide); `glide` points at this record while one runs. */
  const glideState = {
    t: 0, seconds: 0, kind: 'pose', id: /** @type {string|null} */ (null), lerpPos: false,
    end: /** @type {((g: typeof glideState) => void)|null} */ (null), done: /** @type {((g: typeof glideState) => void)|null} */ (null),
    /** body the START pose rides with (the one the camera was attached to), and that body's position at launch */
    anchorId: /** @type {string|null} */ (null), anchor0: new Vector3(),
    /** body the END pose rides with (for the release blend when the glide is cancelled late) */
    endBody: /** @type {string|null} */ (null),
    p0: new Vector3(), q0: new Quaternion(), l0: new Vector3(), n0: new Vector3(), d0: 1, z0: 0,
    p1: new Vector3(), l1: new Vector3(), fov1: baseFov,
  };
  let glide = null;
  /** Independent fov ease (runs with the controls enabled). */
  const fovGlideState = { t: 0, seconds: 0, z0: 0, z1: 0, target: baseFov };
  let fovGlide = null;
  /** Rigid-translation fade-out after leaving a body. */
  const releaseState = { id: /** @type {string|null} */ (null), t: 0, prev: new Vector3() };
  let release = null;
  /** Follow dwell (orbitDwell). */
  const dwellState = { degPerS: 0, elevRadPerS: 0, t: 0, phase: /** @type {'in'|'on'|'out'} */ ('in') };
  let dwell = null;
  /** Sky view record. */
  const skyState = {
    from: '', to: /** @type {string[]} */ ([]), fovDeg: /** @type {number|null} */ (null), locked: false, ready: false,
    dir: new Vector3(), lookDist: 1, fitFrozenDeg: NaN,
  };
  let sky = null;
  /** @type {{dist: number, rDisp: number, offAxisRad: number}[]} scratch for skyFitFovRad (grown once per new size) */
  const skyTargets = [];

  // Rate caps: advisory only (see the header). Fly-by cap from the launch; spin cap from the follow geometry.
  const flyCap = { active: false, cap: 0 };
  const spin = { engaged: false, binding: false, cap: 0 };
  let beatImpulse = 0;
  let streakBase = 0;

  // Glide parameters shared between the launching call and the per-frame end-pose evaluators.
  const approachDir = new Vector3();
  let approachDist = 0;
  let dollyDist = 0;
  const vPoseP1 = new Vector3(), vPoseL1 = new Vector3();
  const vSafeDir = new Vector3(), vSafeUp = new Vector3();
  const bsScratch = { center: [0, 0, 0], radius: 0 };

  // Scratch (allocation-free hot path).
  const sA = [0, 0, 0], sB = [0, 0, 0], sE = [0, 0, 0], sP = [0, 0, 0], sN = [0, 0, 0], sOff = [0, 0, 0];
  const sL = [0, 0, 0], sTmp = [0, 0, 0];
  const vB = new Vector3(), vD = new Vector3(), vL = new Vector3(), vTmp = new Vector3(), vTmp2 = new Vector3();
  const vPrev = new Vector3(), vVel = new Vector3(), vFwd = new Vector3();
  const vPivot = new Vector3(), vN1 = new Vector3(), vDir = new Vector3(), vOff = new Vector3(), vAxis = new Vector3();
  const vP0 = new Vector3(), vL0 = new Vector3(), vCross = new Vector3();
  /** Reused option bags for the pure helpers (no per-frame allocation). */
  const arrivalOpts = { bodyPos: sB, departurePos: sA, rDisp: 0, fovRad: 0, up: UP };
  const skyFitOpts = { targets: skyTargets, count: 0, H: 0, baseFovRad: baseFov * DEG };
  const vFrom = new Vector3(), vSkyPos = new Vector3(), vSkyLook = new Vector3(), vSkyDir = new Vector3();
  const qLook = new Quaternion(), qTmp = new Quaternion(), qSlerp = new Quaternion();

  /** @type {RigUpdate} reused result object */
  const res = {
    speedC: 0, streak: 0, velDir: [0, 0, 1], lightspeedBeat: false, rateRestored: false, arrived: null,
    poseDone: false, skyReady: false, rateCap: null,
    spinCapped: false, spinCapChanged: null, spinCapRate: null, dim: 0,
  };
  const patch = { cameraMode: 'free', followed: null, flyby: null, sky: null };
  let storeMode = null, storeFollowed = undefined, storeFlyby = undefined, storeSky = undefined;
  let storeT = -1;

  // ---- helpers -----------------------------------------------------------------------------------------------------
  function viewportH() {
    return getViewportHeight ? getViewportHeight() : (canvas.clientHeight || 0);
  }
  /**
   * Pitch (radians) that lifts a centred subject by half the bottom inset: tan δ = (inset / H) · tan(fov / 2), so the
   * subject lands at the centre of the uncovered part of the viewport (0 without an inset).
   * @param {number} fovDeg vertical field of view the pose ends with
   * @returns {number}
   */
  function safePitchRad(fovDeg) {
    const inset = getSafeInsetBottom ? getSafeInsetBottom() : 0;
    const H = viewportH();
    if (!(inset > 0) || !(H > 0) || !(fovDeg > 0)) return 0;
    return Math.atan((Math.min(inset, 0.6 * H) / H) * Math.tan(fovDeg * DEG / 2));
  }
  /**
   * Move a look point DOWN the screen (in place) by the safe-area pitch, so the subject at the original look point
   * appears above the covered strip: look ← look − up_screen · |look − pos| · tan δ, with up_screen the camera's
   * screen-up direction for that view (ecliptic north projected ⟂ the view ray; skipped when the ray is polar).
   * @param {Vector3} pos camera position @param {Vector3} look look point (modified) @param {number} fovDeg
   */
  function offsetLookForSafeArea(pos, look, fovDeg) {
    const delta = safePitchRad(fovDeg);
    if (delta === 0) return look;
    vSafeDir.copy(look).sub(pos);
    const dist = vSafeDir.length();
    if (!(dist > 0)) return look;
    vSafeDir.multiplyScalar(1 / dist);
    vSafeUp.set(UP[0], UP[1], UP[2]).addScaledVector(vSafeDir, -vSafeDir.z); // UP − (UP·dir) dir
    const l = vSafeUp.length();
    if (l < 1e-6) return look;
    vSafeUp.multiplyScalar(1 / l);
    return look.addScaledVector(vSafeUp, -dist * Math.tan(delta));
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
  function wish() {
    return clock.rate();
  }
  /** Angle between two vectors as atan2(|a × b|, a · b) (CLAUDE.md: never acos for small angles). */
  function angleVec(a, b) {
    vCross.crossVectors(a, b);
    return Math.atan2(vCross.length(), a.dot(b));
  }
  function emitFade(dim) {
    if (dim === lastDim) return;
    lastDim = dim;
    res.dim = dim;
    for (const fn of fadeListeners) fn(dim);
  }
  /** Queue a signal for the next update() (RigUpdate flags + onSignal listeners fire there, never re-entrantly). */
  function signal(type, id = null) {
    signalQueue.push({ type, id });
  }
  function flushSignals() {
    for (let i = 0; i < signalQueue.length; i++) {
      const s = signalQueue[i];
      if (s.type === 'poseDone') res.poseDone = true;
      else if (s.type === 'skyReady') res.skyReady = true;
      for (const fn of signalListeners) fn(s);
    }
    signalQueue.length = 0;
  }
  function configureFreeControls() {
    controls.zoomToCursor = true;
    controls.minDistance = FREE_MIN_AU;
    controls.maxDistance = FREE_MAX_AU;
    controls.autoRotate = false;
  }
  function configureFollowControls(id) {
    const R = getDispRadiusAu(id);
    followR = R;
    controls.zoomToCursor = false; // r186 rewrites target on cursor zoom; follow needs the target pinned on the body
    controls.minDistance = FOLLOW_MIN_R * R;
    controls.maxDistance = FOLLOW_MAX_R * R;
  }
  /** r186 keeps the damping residuals in private fields (OrbitControls.js 411–414); drop them before a glide. */
  function flushControlsInertia() {
    controls._sphericalDelta?.set(0, 0, 0);
    controls._panOffset?.set(0, 0, 0);
    if (typeof controls._scale === 'number') controls._scale = 1;
  }
  /** @param {number} deg */
  function setFov(deg) {
    if (Math.abs(deg - camera.fov) > 1e-7) {
      camera.fov = deg;
      camera.updateProjectionMatrix();
    }
  }
  function fovIsBase() {
    return Math.abs(camera.fov - baseFov) <= 1e-7;
  }
  function clampSkyFov(deg) {
    return MathUtils.clamp(deg, SKY_MIN_FOV_RAD / DEG, SKY_MAX_FOV_RAD / DEG);
  }
  /** The point the camera is currently looking at, in every mode. @param {number[]} out */
  function currentLookPoint(out) {
    if (glide) { out[0] = vPivot.x; out[1] = vPivot.y; out[2] = vPivot.z; return out; }
    if (mode === 'flyby' && flight) {
      if (flight.phase === 'fly') { out[0] = sL[0]; out[1] = sL[1]; out[2] = sL[2]; return out; }
      // decel / fades: along the forward axis at the remembered look distance
      camera.getWorldDirection(vFwd);
      vTmp.copy(camera.position).addScaledVector(vFwd, flight.lookDist || 1);
      out[0] = vTmp.x; out[1] = vTmp.y; out[2] = vTmp.z; return out;
    }
    if (mode === 'skyView' && sky) { skyPose(vSkyPos, vSkyLook); out[0] = vSkyLook.x; out[1] = vSkyLook.y; out[2] = vSkyLook.z; return out; }
    out[0] = controls.target.x; out[1] = controls.target.y; out[2] = controls.target.z;
    return out;
  }
  /** The body the camera currently rides with (follow / sky view), else null. Read BEFORE leaveAll(). */
  function attachedBody() {
    if (mode === 'follow' && followId) return followId;
    if (mode === 'skyView' && sky) return sky.from;
    return null;
  }
  /** Hand the camera to OrbitControls in free mode with the orbit centre at `target`, no animation. */
  function handToFreeControls(target) {
    mode = 'free';
    controls.target.copy(target);
    configureFreeControls();
    controls.enabled = true;
    controls.update();
  }

  // ---- glides ------------------------------------------------------------------------------------------------------
  /**
   * Start an animated transition (min-jerk over `seconds`, cut under reduced motion). Each frame `end(g)` fills the END
   * pose for that instant (g.p1 position, g.l1 look point, g.fov1 degrees) so it can track moving bodies.
   * Default ("pivot") model — poses, follow approaches, dollies: the camera position is blended about the pivot
   * lerp(l0, l1): its direction from the pivot is slerped and its log distance lerped (constant perceived zoom rate,
   * no pass through the target, no whip pan); the orientation slerps from the start quaternion to the roll-free
   * look-at of the pivot. "lerpPosition" model — sky-view entry, where the look point jumps from the observer body to
   * targets AU away while the camera itself moves only a few radii: the position lerps p0 → p1 and the orientation
   * slerps q0 → the end pose's look-at (the pivot model would send the camera on a detour to the geometric-mean
   * distance). In both the fov is lerped in zoom space. `done(g)` runs on the last frame.
   * Moving endpoints: the START pose rides with `anchorId` (the body the camera was attached to: a planet moves
   * ≈ 400 Earth radii per second of real time at 1 d/s, so a start pose fixed in space would see it dash away in the
   * first frames), exactly as the fly-by's departure point A(t) does (plan §Fly-by path).
   * The caller has captured the start look point into sTmp via currentLookPoint() BEFORE changing any state.
   * @param {{ seconds: number, kind: string, id?: string|null, lerpPosition?: boolean, anchorId?: string|null,
   *   endBody?: string|null, end: (g: typeof glideState) => void, done: (g: typeof glideState) => void }} o
   */
  function startGlide({ seconds, kind, id = null, lerpPosition = false, anchorId = null, endBody = null, end, done }) {
    const g = glideState;
    g.anchorId = anchorId && getBodyState(anchorId) ? anchorId : null;
    if (g.anchorId) bodyVec(g.anchorId, g.anchor0);
    g.endBody = endBody;
    g.l0.set(sTmp[0], sTmp[1], sTmp[2]);
    g.p0.copy(camera.position);
    g.q0.copy(camera.quaternion);
    g.n0.copy(g.p0).sub(g.l0);
    g.d0 = g.n0.length();
    if (g.d0 > MIN_PIVOT_AU) g.n0.multiplyScalar(1 / g.d0);
    else { g.d0 = MIN_PIVOT_AU; camera.getWorldDirection(g.n0).negate(); }
    g.z0 = zoomFromFov(camera.fov * DEG);
    g.t = 0;
    g.seconds = reduced() ? 0 : Math.max(0, seconds || 0);
    g.kind = kind; g.id = id; g.lerpPos = lerpPosition; g.end = end; g.done = done;
    flushControlsInertia();
    fovGlide = null;
    glide = g;
    stepGlide(0);
  }
  function stepGlide(dt) {
    const g = glide;
    g.t += dt;
    const w = g.seconds > 0 ? minJerk(g.t / g.seconds) : 1;
    g.end(g);
    // Start pose for this frame: translated with the anchor body since launch.
    vP0.copy(g.p0); vL0.copy(g.l0);
    if (g.anchorId) {
      bodyVec(g.anchorId, vTmp2).sub(g.anchor0);
      vP0.add(vTmp2); vL0.add(vTmp2);
    }
    vN1.copy(g.p1).sub(g.l1);
    let d1 = vN1.length();
    if (d1 > MIN_PIVOT_AU) vN1.multiplyScalar(1 / d1); else { d1 = MIN_PIVOT_AU; vN1.copy(g.n0); }
    if (g.lerpPos) {
      camera.position.lerpVectors(vP0, g.p1, w);
      // End orientation for this frame: the roll-free look from p1 to l1 (lookAt reads the world position, so set it briefly).
      vTmp.copy(camera.position);
      camera.position.copy(g.p1);
      camera.lookAt(g.l1);
      qLook.copy(camera.quaternion);
      camera.position.copy(vTmp);
      camera.quaternion.slerpQuaternions(g.q0, qLook, w);
      camera.getWorldDirection(vFwd); // current look point estimate (for cancel / currentLookPoint)
      vPivot.copy(camera.position).addScaledVector(vFwd, g.d0 + (d1 - g.d0) * w);
    } else {
      vPivot.lerpVectors(vL0, g.l1, w);
      qTmp.setFromUnitVectors(g.n0, vN1);
      qSlerp.identity().slerp(qTmp, w);
      vDir.copy(g.n0).applyQuaternion(qSlerp);
      const d = Math.exp(Math.log(g.d0) + (Math.log(d1) - Math.log(g.d0)) * w);
      camera.position.copy(vPivot).addScaledVector(vDir, d);
      camera.lookAt(vPivot);
      if (w < 1) {
        qLook.copy(camera.quaternion);
        camera.quaternion.slerpQuaternions(g.q0, qLook, w);
      }
    }
    if (w < 1) {
      setFov(fovFromZoom(g.z0 + (zoomFromFov(g.fov1 * DEG) - g.z0) * w) / DEG);
      return;
    }
    camera.position.copy(g.p1);
    camera.lookAt(g.l1);
    setFov(g.fov1);
    glide = null;
    g.done(g);
  }
  /** Esc during a glide: stay exactly here; the current pivot becomes the orbit centre (no snap to the end pose). */
  function stopGlideInPlace() {
    const g = glide;
    glide = null;
    if (mode === 'follow' && followId && g.kind === 'dolly') { // the pivot never left the body: keep following
      attachFollow(followId);
      return;
    }
    const w = g.seconds > 0 ? minJerk(g.t / g.seconds) : 1;
    const riding = w < 0.5 ? g.anchorId : g.endBody; // whose motion the camera mostly carries right now
    vTmp.copy(vPivot);
    if (g.kind === 'sky' && sky) { // the pivot is the far target centroid: orbit a near point ahead instead
      camera.getWorldDirection(vFwd);
      vTmp.copy(camera.position).addScaledVector(vFwd, Math.min(camera.position.distanceTo(vPivot), SKY_EXIT_PIVOT_R * getDispRadiusAu(sky.from)));
    }
    sky = null; followId = null; followR = NaN; dwell = null; controls.autoRotate = false;
    handToFreeControls(vTmp);
    beginRelease(riding);
    if (!fovIsBase()) startFovGlide(baseFov, FOV_RESTORE_S);
  }
  /** Glide law input for a static end pose (p1, l1, fov1) from the current pose; call BEFORE changing state. */
  function autoGlideSeconds(p1, l1, fov1Deg) {
    currentLookPoint(sTmp);
    vTmp.set(sTmp[0], sTmp[1], sTmp[2]);
    const d0 = Math.max(camera.position.distanceTo(vTmp), MIN_PIVOT_AU);
    const d1 = Math.max(p1.distanceTo(l1), MIN_PIVOT_AU);
    camera.getWorldDirection(vFwd);
    vTmp2.copy(l1).sub(p1);
    const turn = vTmp2.lengthSq() > 0 ? angleVec(vFwd, vTmp2) : 0;
    const zoomDecades = Math.abs(Math.log10(d1 / d0)) + Math.abs(zoomFromFov(fov1Deg * DEG) - zoomFromFov(camera.fov * DEG)) / Math.LN10;
    return glideDuration({ travelAu: camera.position.distanceTo(p1), turnRad: turn, zoomDecades });
  }
  function startFovGlide(targetDeg, seconds) {
    if (Math.abs(camera.fov - targetDeg) <= 1e-7) { fovGlide = null; return; }
    if (reduced() || !(seconds > 0)) { fovGlide = null; setFov(targetDeg); return; }
    const f = fovGlideState;
    f.t = 0; f.seconds = seconds; f.z0 = zoomFromFov(camera.fov * DEG); f.z1 = zoomFromFov(targetDeg * DEG); f.target = targetDeg;
    fovGlide = f;
  }
  function stepFovGlide(dt) {
    if (!fovGlide) return;
    const f = fovGlide;
    f.t += dt;
    const w = minJerk(f.t / f.seconds);
    if (w >= 1) { setFov(f.target); fovGlide = null; return; }
    setFov(fovFromZoom(f.z0 + (f.z1 - f.z0) * w) / DEG);
  }
  function beginRelease(id) {
    if (reduced() || !id || !getBodyState(id)) { release = null; return; }
    release = releaseState;
    release.id = id; release.t = 0;
    bodyVec(id, release.prev);
  }
  /** Free mode after leaving a body: keep translating with it by a weight that eases 1 → 0 (no dead stop). */
  function stepRelease(dt) {
    if (!release) return;
    release.t += dt;
    const w = 1 - minJerk(release.t / RELEASE_S);
    bodyVec(release.id, vB);
    vD.copy(vB).sub(release.prev);
    release.prev.copy(vB);
    if (w <= 0) { release = null; return; }
    camera.position.addScaledVector(vD, w);
    controls.target.addScaledVector(vD, w);
  }

  // ---- rate caps (advisory) ----------------------------------------------------------------------------------------
  /** Fly-by rate cap (plan §Fly-by "Sim rate easing"): |rate|·T must not exceed P/50, so the ceiling is P/(50·T). */
  function beginFlyCap(id, T) {
    flyCap.active = false; flyCap.cap = 0;
    if (settings().keepRateDuringFlyby) return;
    const period = getPeriodDays(id);
    if (!(period > 0) || !Number.isFinite(period)) return; // the Sun (null) or an unknown body: no cap
    bodyPos(id, sTmp);
    if (Math.hypot(sTmp[0], sTmp[1], sTmp[2]) < SUN_EPSILON_AU) return; // a body at the origin does not move: nothing to protect
    flyCap.cap = period / (RATE_PERIOD_FRACTION * T);
    flyCap.active = true;
  }
  /** Arrival or cancel: lift the fly-by cap; report rateRestored when it was holding the wish down. */
  function endFlyCap() {
    if (!flyCap.active) return;
    flyCap.active = false;
    if (Math.abs(wish()) > flyCap.cap) res.rateRestored = true;
  }
  function disengageSpinCap() {
    if (spin.binding) { res.spinCapChanged = 'off'; res.rateRestored = true; }
    spin.engaged = false; spin.binding = false;
  }
  function updateSpinCap(id) {
    if (!getSpinRateDegPerDay || !settings().spinCap) { disengageSpinCap(); return; }
    const degPerDay = Math.abs(getSpinRateDegPerDay(id));
    if (!(degPerDay > 0)) { disengageSpinCap(); return; }
    const cap = SPIN_CAP_DEG_PER_S / degPerDay; // days/s such that the body spins ≤ 360°/s (6°/frame at 60 fps)
    const px = pxRadius(getDispRadiusAu(id), camera.position.distanceTo(vB), camera.fov * DEG, viewportH());
    if (!spin.engaged) { if (px > SPIN_CAP_PX_ON) spin.engaged = true; } else if (px < SPIN_CAP_PX_OFF) spin.engaged = false;
    const w = Math.abs(wish());
    const wasBinding = spin.binding;
    if (!spin.engaged) spin.binding = false;
    else if (!spin.binding) { if (w > cap * SPIN_CAP_BIND_FACTOR) spin.binding = true; } // 10 % hysteresis on engage
    else if (w <= cap) spin.binding = false; // the user slowed down below the cap by themselves
    spin.cap = cap;
    if (spin.binding && !wasBinding) res.spinCapChanged = 'on';
    if (!spin.binding && wasBinding) { res.spinCapChanged = 'off'; res.rateRestored = true; }
    res.spinCapped = spin.binding;
    res.spinCapRate = spin.binding ? Math.sign(wish() || 1) * cap : null;
    if (spin.binding) res.rateCap = res.rateCap == null ? cap : Math.min(res.rateCap, cap);
  }

  // ---- mode transitions ----------------------------------------------------------------------------------------------
  /** Drop whatever is running, instantly and silently (callers animate the way INTO the next state). */
  function leaveAll() {
    if (flight) { endFlyCap(); flight = null; }
    if (fade) { fade = null; emitFade(0); }
    disengageSpinCap();
    glide = null; fovGlide = null; release = null; dwell = null;
    controls.autoRotate = false;
    sky = null;
    followId = null;
    followR = NaN;
  }

  /** Attach to the body the camera is already aimed at: pin the orbit centre and resync the controls once (research §3.4). */
  function attachFollow(id) {
    bodyVec(id, vB);
    controls.target.copy(vB);
    configureFollowControls(id);
    controls.enabled = true;
    controls.update();
  }
  function approachEnd(g) {
    const R = getDispRadiusAu(followId);
    approachDist = MathUtils.clamp(approachDist, FOLLOW_MIN_R * R, FOLLOW_MAX_R * R); // sizeK may change mid-glide
    bodyVec(followId, g.l1);
    g.p1.copy(g.l1).addScaledVector(approachDir, approachDist);
    g.fov1 = baseFov;
  }
  function finishApproach(g) {
    attachFollow(followId);
    signal('poseDone', g.id);
  }
  /**
   * @param {string} id
   * @param {{ seconds?: number|null }} [opts] approach length (default: 1.2 s from beyond 5000 R, else the glide law)
   * @returns {boolean}
   */
  function follow(id, { seconds = null } = {}) {
    if (!id || !getBodyState(id)) return false;
    bodyVec(id, vB);
    const R = getDispRadiusAu(id);
    vTmp.copy(camera.position).sub(vB);
    const d0 = vTmp.length();
    camera.getWorldDirection(vFwd);
    vD.copy(vB).sub(camera.position);
    const aim = vD.lengthSq() > 0 ? angleVec(vFwd, vD) : 0;
    const inRange = d0 >= FOLLOW_MIN_R * R && d0 <= FOLLOW_MAX_R * R;
    const anchor = attachedBody();
    currentLookPoint(sTmp);
    leaveAll();
    mode = 'follow';
    followId = id;
    if (inRange && aim < AIM_TOLERANCE_RAD && fovIsBase()) {
      attachFollow(id);
      signal('poseDone', id);
      return true;
    }
    // Approach glide: keep the world direction body → camera, ease the distance into range (log), turn toward the body.
    if (d0 > MIN_PIVOT_AU) approachDir.copy(vTmp).multiplyScalar(1 / d0); else approachDir.copy(vFwd).negate();
    approachDist = MathUtils.clamp(d0, FOLLOW_MIN_R * R, FOLLOW_MAX_R * R);
    const zoomDecades = Math.log10(approachDist / Math.max(d0, MIN_PIVOT_AU)) + (zBase - zoomFromFov(camera.fov * DEG)) / Math.LN10;
    const byLaw = glideDuration({ turnRad: aim, zoomDecades });
    const s = seconds != null ? seconds : (inRange ? byLaw : Math.max(FOLLOW_APPROACH_S, byLaw));
    controls.enabled = false;
    startGlide({ seconds: s, kind: 'approach', id, anchorId: anchor, endBody: id, end: approachEnd, done: finishApproach });
    return true;
  }

  /** Public free(): leave the current state WITH animation (fov restore, release blend); a flight decelerates. */
  function free() {
    if (mode === 'flyby' && flight) return cancel();
    let did = false;
    if (glide) { stopGlideInPlace(); did = true; } // a follow dolly re-attaches; the follow branch below then leaves
    if (mode === 'skyView') return exitSkyView(SKY_EXIT_S, false) || did;
    if (mode === 'follow') {
      const id = followId;
      leaveAll();
      handToFreeControls(controls.target); // the orbit centre stays on the body's last position
      beginRelease(id);
      if (!fovIsBase()) startFovGlide(baseFov, FOV_RESTORE_S);
      return true;
    }
    if (!fovIsBase()) { startFovGlide(baseFov, FOV_RESTORE_S); return true; }
    return did;
  }

  // ---- sky view --------------------------------------------------------------------------------------------------------
  /** Centroid of the sky targets. @param {Vector3} out */
  function skyLookPoint(out) {
    out.set(0, 0, 0);
    for (let i = 0; i < sky.to.length; i++) out.add(bodyVec(sky.to[i], vTmp2));
    return out.multiplyScalar(1 / sky.to.length);
  }
  /** Camera position (body centre + 1.5 R toward the look direction) and look point for this instant. */
  function skyPose(outPos, outLook) {
    bodyVec(sky.from, vFrom);
    skyLookPoint(outLook);
    if (sky.locked) vSkyDir.copy(sky.dir);
    else {
      vSkyDir.copy(outLook).sub(vFrom);
      const l = vSkyDir.length();
      if (l > 0) vSkyDir.multiplyScalar(1 / l); else vSkyDir.set(1, 0, 0);
    }
    outPos.copy(vFrom).addScaledVector(vSkyDir, SKY_OFFSET_R * getDispRadiusAu(sky.from));
    if (sky.locked) outLook.copy(outPos).addScaledVector(vSkyDir, sky.lookDist);
  }
  /** Fit-rule fov (degrees) seen from `pos` along `axis` (flyby.js skyFitFovRad). */
  function skyFitDeg(pos, axis) {
    const n = sky.to.length;
    while (skyTargets.length < n) skyTargets.push({ dist: 0, rDisp: 0, offAxisRad: 0 });
    for (let i = 0; i < n; i++) {
      const id = sky.to[i];
      const t = skyTargets[i];
      bodyVec(id, vTmp2).sub(pos);
      t.dist = vTmp2.length();
      t.rDisp = getDispRadiusAu(id);
      t.offAxisRad = n > 1 && t.dist > 0 ? angleVec(vTmp2, axis) : 0;
    }
    skyFitOpts.count = n; skyFitOpts.H = viewportH();
    return skyFitFovRad(skyFitOpts) / DEG;
  }
  /** The fov the sky view wants right now: explicit, frozen (locked), or the fit rule. */
  function skyTargetFovDeg(pos, axis) {
    if (sky.fovDeg != null) return sky.fovDeg;
    if (sky.locked) {
      if (Number.isNaN(sky.fitFrozenDeg)) sky.fitFrozenDeg = skyFitDeg(pos, axis);
      return sky.fitFrozenDeg;
    }
    return skyFitDeg(pos, axis);
  }
  function skyEnd(g) {
    skyPose(g.p1, g.l1);
    g.fov1 = skyTargetFovDeg(g.p1, vSkyDir);
    offsetLookForSafeArea(g.p1, g.l1, g.fov1);
  }
  function finishSkyEnter() {
    sky.ready = true;
    signal('skyReady', sky.from);
  }
  /**
   * @param {string} fromId observer body
   * @param {string|string[]} toIds target(s)
   * @param {{ fovDeg?: number|null, lock?: boolean, animateS?: number|null }} [opts] explicit fov (else the fit rule), lock
   *   the look direction at entry (retrograde loops drift across a fixed field), entry glide length (default: 1.0 s when
   *   the camera is already near the observer, else the glide law for the travel, up to 2.2 s from the home view)
   * @returns {boolean}
   */
  function skyView(fromId, toIds, { fovDeg = null, lock = false, animateS = null } = {}) {
    const to = Array.isArray(toIds) ? toIds.filter((t) => !!getBodyState(t)) : (getBodyState(toIds) ? [toIds] : []);
    if (!getBodyState(fromId) || !to.length) return false;
    const travel = camera.position.distanceTo(bodyVec(fromId, vTmp));
    const seconds = animateS != null ? animateS : Math.max(SKY_ENTER_S, glideDuration({ travelAu: travel }));
    const anchor = attachedBody();
    currentLookPoint(sTmp);
    leaveAll();
    mode = 'skyView';
    sky = skyState;
    sky.from = fromId; sky.to = to; sky.locked = !!lock; sky.ready = false; sky.fitFrozenDeg = NaN;
    sky.fovDeg = fovDeg != null && Number.isFinite(fovDeg) ? clampSkyFov(fovDeg) : null;
    if (sky.locked) {
      bodyVec(fromId, vFrom);
      skyLookPoint(vTmp2).sub(vFrom);
      sky.lookDist = Math.max(vTmp2.length(), MIN_PIVOT_AU);
      sky.dir.copy(vTmp2).multiplyScalar(1 / sky.lookDist);
    }
    controls.enabled = false;
    startGlide({ seconds, kind: 'sky', id: fromId, lerpPosition: true, anchorId: anchor, endBody: fromId, end: skyEnd, done: finishSkyEnter });
    return true;
  }
  function updateSky(dt) {
    skyPose(vSkyPos, vSkyLook);
    camera.position.copy(vSkyPos);
    offsetLookForSafeArea(vSkyPos, vSkyLook, camera.fov);
    camera.lookAt(vSkyLook);
    if (fovGlide || sky.fovDeg != null) return; // an explicit fov is held (or being eased to)
    const zFit = zoomFromFov(skyTargetFovDeg(vSkyPos, vSkyDir) * DEG);
    const z = MathUtils.damp(zoomFromFov(camera.fov * DEG), zFit, SKY_FOV_LAMBDA, dt);
    setFov(fovFromZoom(z) / DEG);
  }
  /**
   * @param {number} fovDeg target vertical fov, clamped to 0.25°…100° (becomes the explicit fov: the fit rule stops)
   * @param {number} [seconds] ease length
   * @returns {boolean}
   */
  function setSkyFov(fovDeg, seconds = SKY_FOV_SET_S) {
    if (mode !== 'skyView' || !sky || !Number.isFinite(fovDeg)) return false;
    sky.fovDeg = clampSkyFov(fovDeg);
    if (!glide) startFovGlide(sky.fovDeg, seconds); // mid-entry the glide picks the new target up by itself
    return true;
  }
  /**
   * Leave sky view with animation: the camera stays, the fov eases back over `seconds`, the orbit centre goes a few
   * radii ahead and the translation with the observer body fades out.
   * @param {number} [seconds] @param {boolean} [announce] queue 'poseDone' (false when called from cancel)
   * @returns {boolean}
   */
  function exitSkyView(seconds = SKY_EXIT_S, announce = true) {
    if (mode !== 'skyView' || !sky) return false;
    const from = sky.from;
    currentLookPoint(sTmp);
    vTmp.set(sTmp[0], sTmp[1], sTmp[2]);
    camera.getWorldDirection(vFwd);
    vTmp.copy(camera.position).addScaledVector(vFwd, Math.min(camera.position.distanceTo(vTmp), SKY_EXIT_PIVOT_R * getDispRadiusAu(from)));
    leaveAll();
    handToFreeControls(vTmp);
    startFovGlide(baseFov, seconds);
    beginRelease(from);
    if (announce) signal('poseDone', from);
    return true;
  }

  // ---- fly-by --------------------------------------------------------------------------------------------------------
  /**
   * @param {string} id destination body
   * @param {{ from?: string|null }} [opts] departure body override (the departure pose tracks that body's motion)
   * @returns {boolean} false when the destination is invalid
   */
  function flyTo(id, opts = {}) {
    if (!id || !getBodyState(id)) return false;
    // Departure pose: A tracks the body we are attached to (follow / sky view), else fixed.
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
    const fov0 = camera.fov;
    // A flight already running is abandoned in place (its cap lifted); the new one starts from rest.
    leaveAll();
    mode = 'flyby';
    controls.enabled = false;
    const rDisp = getDispRadiusAu(id);
    const fovRad = baseFov * DEG; // the arrival is framed for the normal fov; a narrowed launch fov eases there in flight

    // Launch geometry: E = B + arrivalOffset, D = |E − A| at launch.
    bodyPos(id, sB);
    departure(fromId, fromOffset, A0, sA);
    arrival(id, sA, sB, rDisp, fovRad, sE);
    const D = Math.hypot(sE[0] - sA[0], sE[1] - sA[1], sE[2] - sA[2]);
    const lookDist = Math.hypot(L0[0] - A0[0], L0[1] - A0[1], L0[2] - A0[2]);
    if (reduced()) {
      flight = {
        kind: 'fade', phase: 'fadeOut', target: id, from: fromId, fromOffset, A0, L0, rDisp, D, T: 2 * FADE_S,
        t: 0, tau: 0, speedC: 0, lookDist, fov0, z0: zoomFromFov(fov0 * DEG), fovS: 0,
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
    const heading = vD.lengthSq() > 0 ? angleVec(vFwd, vD) : 0;
    vL.set(L0[0], L0[1], L0[2]);
    camera.lookAt(vL);
    qLook.copy(camera.quaternion);
    camera.quaternion.copy(qTmp);
    const mismatch = qTmp.angleTo(qLook);
    const slerp = heading > LOOK_SLERP_HEADING_RAD || mismatch > LOOK_SLERP_MISMATCH_RAD;
    flight = {
      kind: profile.kind, phase: 'fly', target: id, from: fromId, fromOffset, A0, L0, rDisp, D, T, H, profile,
      t: 0, tau: 0, speedC: 0, prevSpeedC: 0, slerp, q0: slerp ? qTmp.clone() : null,
      lookDist, started: false, decel: null,
      fov0, z0: zoomFromFov(fov0 * DEG), fovS: Math.min(FLY_FOV_EASE_MAX_S, FLY_FOV_EASE_FRACTION * T),
    };
    vPrev.copy(camera.position);
    beginFlyCap(id, T);
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
  /** E(t) = B(t) + arrivalOffset (Sun handled by flyby.js via the departure direction). A and B are the sA / sB
   *  scratch arrays bound in arrivalOpts, so nothing is allocated per frame. */
  function arrival(id, A, B, rDisp, fovRad, out) {
    arrivalOpts.bodyPos = B; arrivalOpts.departurePos = A; arrivalOpts.rDisp = rDisp; arrivalOpts.fovRad = fovRad;
    const off = arrivalOffset(arrivalOpts, sOff);
    out[0] = B[0] + off[0]; out[1] = B[1] + off[1]; out[2] = B[2] + off[2];
    return out;
  }
  /** Fov launched away from base (sky view) eases back during the first fovS seconds of the flight: no pop. */
  function stepFlightFov(f) {
    if (f.fov0 === baseFov) return;
    if (f.t >= f.fovS) { setFov(baseFov); return; }
    setFov(fovFromZoom(f.z0 + (zBase - f.z0) * minJerk(f.t / f.fovS)) / DEG);
  }

  function updateFlight(dt) {
    const f = flight;
    if (f.phase === 'decel') { updateDecel(dt); return; }
    if (f.kind === 'fade') { updateFadeFlight(dt); return; }
    f.t += dt;
    const tau = Math.min(1, f.t / f.T);
    f.tau = tau;
    const s = f.profile.s(tau);
    const rDisp = getDispRadiusAu(f.target); // re-read: a sizeK change mid-flight re-plans the arrival offset
    f.rDisp = rDisp;
    bodyPos(f.target, sB);
    departure(f.from, f.fromOffset, f.A0, sA);
    arrival(f.target, sA, sB, rDisp, baseFov * DEG, sE);
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
    stepFlightFov(f);
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
    if (tau >= 1) arrive();
  }

  function arrive() {
    const id = flight.target;
    endFlyCap();
    flight = null;
    mode = 'follow';
    followId = id;
    setFov(baseFov);
    attachFollow(id); // the camera already looks at B (L = B at s = 1), so the resync moves nothing
    res.arrived = id;
    signal('arrived', id);
  }

  function updateFadeFlight(dt) {
    const f = flight;
    f.t += dt;
    if (f.phase === 'fadeOut') {
      emitFade(Math.min(1, f.t / FADE_S));
      if (f.t >= FADE_S) {
        // Cut to the arrival pose, then keep following while the fade-in runs.
        const rDisp = getDispRadiusAu(f.target);
        bodyPos(f.target, sB);
        departure(f.from, f.fromOffset, f.A0, sA);
        arrival(f.target, sA, sB, rDisp, baseFov * DEG, sE);
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

  /** Esc mid-flight: decelerate in place (cancelDecelSeconds keeps v continuous), then free with the look point ahead. */
  function beginDecel() {
    const f = flight;
    const speedAu = f.speedC * C_AU_S; // AU per real second
    const remaining = Math.hypot(sE[0] - camera.position.x, sE[1] - camera.position.y, sE[2] - camera.position.z);
    f.decel = { t: 0, v0: speedAu, seconds: cancelDecelSeconds(speedAu, remaining) };
    f.phase = 'decel';
    vVel.set(res.velDir[0], res.velDir[1], res.velDir[2]);
    f.lookDist = Math.max(f.lookDist, 10 * f.rDisp);
  }

  function updateDecel(dt) {
    const f = flight;
    const d = f.decel;
    d.t += dt;
    f.t += dt;
    stepFlightFov(f);
    const u = d.seconds > 0 ? Math.min(1, d.t / d.seconds) : 1;
    const v = d.v0 * (1 - minJerk(u));
    camera.position.addScaledVector(vVel, v * dt);
    res.speedC = v / C_AU_S;
    f.speedC = res.speedC;
    if (u >= 1) {
      camera.getWorldDirection(vFwd);
      vTmp.copy(camera.position).addScaledVector(vFwd, f.lookDist);
      flight = null;
      handToFreeControls(vTmp);
      res.speedC = 0;
      if (!fovIsBase()) startFovGlide(baseFov, FOV_RESTORE_S);
    }
  }

  /**
   * Esc: decelerate a flight in place, stop a glide where it is, leave sky view / the dwell / follow mode (animated).
   * @returns {boolean} true when something was cancelled
   */
  function cancel() {
    if (fade && flight && flight.kind === 'fade') { // reduced-motion flight: finish the cut immediately
      flight.t = FADE_S; updateFadeFlight(0); fade = null; emitFade(0); signal('cancelled'); return true;
    }
    if (mode === 'flyby' && flight) {
      if (flight.phase === 'decel') return true;
      endFlyCap();
      beginDecel();
      signal('cancelled', flight.target);
      return true;
    }
    if (glide) { const id = glide.id; stopGlideInPlace(); signal('cancelled', id); return true; }
    if (mode === 'skyView') { const id = sky ? sky.from : null; exitSkyView(SKY_EXIT_S, false); signal('cancelled', id); return true; }
    if (dwell && dwell.phase !== 'out') { stopDwell(); return true; }
    if (mode === 'follow') { const id = followId; free(); signal('cancelled', id); return true; }
    return false;
  }

  // ---- follow: per frame, spin cap, dwell ----------------------------------------------------------------------------
  /** sizeK changed under us: refresh the limits; inside 1.2 R the controls push the camera out this frame, beyond
   *  5000 R ease in instead of letting the clamp teleport. @returns {boolean} true when an approach glide took over */
  function refreshFollowLimits(id) {
    const R = getDispRadiusAu(id);
    if (R === followR) return false;
    configureFollowControls(id);
    const d = camera.position.distanceTo(vB);
    if (d <= controls.maxDistance) return false;
    approachDir.copy(camera.position).sub(vB).multiplyScalar(1 / d);
    approachDist = FOLLOW_MAX_R * R;
    currentLookPoint(sTmp);
    controls.enabled = false;
    startGlide({ seconds: FOLLOW_APPROACH_S, kind: 'approach', id, anchorId: id, endBody: id, end: approachEnd, done: finishApproach });
    return true;
  }
  /** Rotate the camera about the body's horizontal axis: positive = larger polar angle (toward the ecliptic and on). */
  function elevationDrift(angle) {
    vOff.copy(camera.position).sub(controls.target);
    const r = vOff.length();
    if (!(r > 0)) return;
    const polar = Math.atan2(Math.hypot(vOff.x, vOff.y), vOff.z);
    const next = polar + angle;
    if (next < DWELL_POLAR_MIN_RAD || next > DWELL_POLAR_MAX_RAD) { dwell.elevRadPerS = -dwell.elevRadPerS; return; }
    vAxis.set(-vOff.y, vOff.x, 0); // up × offset
    if (vAxis.lengthSq() < 1e-30) return; // on the pole: no azimuth
    vAxis.normalize();
    qTmp.setFromAxisAngle(vAxis, angle);
    vOff.applyQuaternion(qTmp);
    camera.position.copy(controls.target).add(vOff);
  }
  function updateDwell(dt) {
    if (!dwell) { controls.autoRotate = false; return; }
    dwell.t += dt;
    let w = 1;
    if (dwell.phase === 'in') { w = minJerk(dwell.t / DWELL_EASE_S); if (w >= 1) dwell.phase = 'on'; }
    else if (dwell.phase === 'out') {
      w = 1 - minJerk(dwell.t / DWELL_EASE_S);
      if (w <= 0) { dwell = null; controls.autoRotate = false; return; }
    }
    controls.autoRotate = true;
    controls.autoRotateSpeed = dwell.degPerS * w / AUTOROTATE_DEG_PER_S_PER_UNIT;
    if (dwell.elevRadPerS !== 0) elevationDrift(dwell.elevRadPerS * w * dt);
  }
  /**
   * @param {{ degPerS?: number, elevationDriftDeg?: number }} [opts] azimuth rate and polar-angle drift (°/s)
   * @returns {boolean} false outside follow mode or under reduced motion
   */
  function orbitDwell({ degPerS = 4, elevationDriftDeg = 0 } = {}) {
    if (mode !== 'follow' || reduced()) return false;
    const d = dwellState;
    d.degPerS = degPerS; d.elevRadPerS = elevationDriftDeg * DEG; d.t = 0; d.phase = 'in';
    dwell = d;
    return true;
  }
  function stopDwell() {
    if (!dwell || dwell.phase === 'out') return;
    dwell.phase = 'out';
    dwell.t = 0;
  }
  function updateFollow(dt) {
    // Rigid translation with the body BEFORE controls.update() (plan §Fly-by "Arrival").
    bodyVec(followId, vB);
    vD.copy(vB).sub(controls.target);
    camera.position.add(vD);
    controls.target.copy(vB);
    if (refreshFollowLimits(followId)) return;
    updateSpinCap(followId);
    updateDwell(dt);
    controls.update(dt);
  }

  // ---- animated free poses (home, event framings, dolly) -------------------------------------------------------------
  function poseEnd(g) {
    g.p1.copy(vPoseP1);
    g.l1.copy(vPoseL1);
    g.fov1 = baseFov;
  }
  function finishFreeGlide(g) {
    handToFreeControls(g.l1);
    signal('poseDone', g.id);
  }
  /**
   * @param {{ position: ArrayLike<number>, target: ArrayLike<number>, seconds?: number|null }} o
   *   seconds: explicit length (0 = cut); null/undefined = the glide law from the pose distance (0.8–2.2 s)
   */
  function viewPose({ position, target, seconds = null }) {
    vPoseP1.set(position[0], position[1], position[2]);
    vPoseL1.set(target[0], target[1], target[2]);
    const s = seconds == null ? autoGlideSeconds(vPoseP1, vPoseL1, baseFov) : seconds;
    const anchor = attachedBody();
    currentLookPoint(sTmp);
    leaveAll();
    mode = 'free';
    configureFreeControls();
    controls.enabled = false;
    startGlide({ seconds: s, kind: 'pose', anchorId: anchor, end: poseEnd, done: finishFreeGlide });
  }
  function resetHome() {
    const polar = HOME.polarDeg * DEG, az = HOME.azimuthDeg * DEG, d = HOME.distanceAu;
    viewPose({
      position: [d * Math.sin(polar) * Math.cos(az), d * Math.sin(polar) * Math.sin(az), d * Math.cos(polar)],
      target: [0, 0, 0],
      seconds: null,
    });
  }
  /** Top-down framing of a bounding sphere (Events "View" for oppositions / conjunctions / parades), always for the
   *  BASE fov (a narrowed sky-view fov eases back during the glide). */
  function frameTopDown({ center, radius, seconds = null, polarDeg = 20 }) {
    const halfV = baseFov * DEG / 2;
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    const dist = Math.max(radius, 1e-6) / Math.sin(Math.min(halfV, halfH)) * 1.05;
    const polar = polarDeg * DEG, az = HOME.azimuthDeg * DEG;
    vTmp.set(
      center[0] + dist * Math.sin(polar) * Math.cos(az),
      center[1] + dist * Math.sin(polar) * Math.sin(az),
      center[2] + dist * Math.cos(polar),
    );
    vTmp2.set(center[0], center[1], center[2]);
    offsetLookForSafeArea(vTmp, vTmp2, baseFov); // keep the subject clear of the caption bar
    viewPose({
      position: [vTmp.x, vTmp.y, vTmp.z],
      target: [vTmp2.x, vTmp2.y, vTmp2.z],
      seconds,
    });
  }
  /**
   * Frame a set of bodies from above the ecliptic: bounding sphere (Ritter) of their positions, the Sun included by
   * default, radius × margin, floored at 40 display radii of the largest body so a single body still gets a view.
   * @param {string[]} ids
   * @param {{ includeSun?: boolean, polarDeg?: number, seconds?: number|null, margin?: number }} [opts]
   * @returns {boolean}
   */
  function frameBodies(ids, { includeSun = true, polarDeg = 20, seconds = null, margin = 1.25 } = {}) {
    const list = (ids || []).filter((id) => !!getBodyState(id));
    if (!list.length && !includeSun) return false;
    const pts = list.map((id) => bodyPos(id, [0, 0, 0]));
    if (includeSun) pts.push([0, 0, 0]);
    const bs = boundingSphere(pts, bsScratch);
    let rMax = 0;
    for (const id of list) rMax = Math.max(rMax, getDispRadiusAu(id));
    const radius = Math.max(bs.radius * margin, 40 * rMax, 1e-5);
    frameTopDown({ center: bs.center, radius, seconds, polarDeg });
    return true;
  }
  function dollyEnd(g) {
    if (mode === 'follow' && followId) bodyVec(followId, g.l1); else g.l1.copy(controls.target);
    g.p1.copy(g.l1).addScaledVector(g.n0, dollyDist);
    g.fov1 = baseFov;
  }
  /**
   * Ease along the current view ray to `distanceAu` from the orbit centre (free) or the followed body (follow).
   * @param {number} distanceAu @param {number|null} [seconds] null = the glide law from the zoom ratio
   * @returns {boolean} false while flying, in sky view, during another glide or for a bad distance
   */
  function dollyTo(distanceAu, seconds = null) {
    if (!(distanceAu > 0) || mode === 'flyby' || mode === 'skyView' || glide) return false;
    const inFollow = mode === 'follow' && !!followId;
    if (inFollow) bodyVec(followId, vTmp); else vTmp.copy(controls.target);
    const d0 = Math.max(camera.position.distanceTo(vTmp), MIN_PIVOT_AU);
    if (inFollow) {
      const R = getDispRadiusAu(followId);
      dollyDist = MathUtils.clamp(distanceAu, FOLLOW_MIN_R * R, FOLLOW_MAX_R * R);
    } else {
      dollyDist = MathUtils.clamp(distanceAu, FREE_MIN_AU, FREE_MAX_AU);
    }
    const s = seconds == null ? glideDuration({ zoomDecades: Math.log10(dollyDist / d0) }) : seconds;
    currentLookPoint(sTmp);
    controls.enabled = false;
    startGlide({
      seconds: s, kind: 'dolly', id: inFollow ? followId : null, anchorId: inFollow ? followId : null, endBody: inFollow ? followId : null,
      end: dollyEnd, done: inFollow ? finishApproach : finishFreeGlide,
    });
    return true;
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
    res.poseDone = false; res.skyReady = false; res.rateCap = null;
    res.speedC = 0;
    // Same inertia at every frame rate (r186 damps per call; see the header).
    controls.dampingFactor = dampingForFrame(DAMPING, dt);

    if (glide) {
      stepGlide(dt);
    } else if (mode === 'flyby' && flight) {
      updateFlight(dt);
    } else if (mode === 'follow' && followId) {
      updateFollow(dt);
    } else if (mode === 'skyView' && sky) {
      updateSky(dt);
    } else if (mode === 'free') {
      stepRelease(dt);
      controls.update(dt);
    }
    stepFovGlide(dt);
    updateFade(dt);

    // Rate ceiling for main.js: the fly-by cap while it binds (the spin cap added its own in updateSpinCap).
    if (flyCap.active && Math.abs(wish()) > flyCap.cap) {
      res.rateCap = res.rateCap == null ? flyCap.cap : Math.min(res.rateCap, flyCap.cap);
    }

    // Streaks: eased toward the speed law; none under reduced motion or on min-jerk hops.
    const inWarp = mode === 'flyby' && flight && !reduced() && (flight.kind === 'warp' || flight.phase === 'decel');
    streakBase = MathUtils.damp(streakBase, inWarp ? streakTarget(res.speedC) : 0, STREAK_LAMBDA, dt);
    if (streakBase < 1e-4) streakBase = 0;
    if (res.lightspeedBeat) beatImpulse += BEAT_IMPULSE;
    beatImpulse = MathUtils.damp(beatImpulse, 0, BEAT_LAMBDA, dt);
    if (beatImpulse < 1e-4) beatImpulse = 0;
    res.streak = Math.min(1, streakBase + beatImpulse);
    if (!spin.binding) { res.spinCapped = false; res.spinCapRate = null; }

    flushSignals();
    syncStore();
    return res;
  }

  /** Push cameraMode / followed / flyby / sky to the store (fresh objects only when something changed, throttled). */
  function syncStore() {
    const fol = mode === 'follow' ? followId : null;
    let write = false;
    if (mode !== storeMode) { patch.cameraMode = mode; storeMode = mode; write = true; }
    if (fol !== storeFollowed) { patch.followed = fol; storeFollowed = fol; write = true; }
    if (flight && flight.phase !== 'decel') {
      const due = storeFlyby == null || storeFlyby.target !== flight.target || flight.t - storeT >= FLYBY_STORE_S;
      if (due) {
        bodyPos(flight.target, sTmp);
        const lightMin = Math.hypot(sTmp[0] - camera.position.x, sTmp[1] - camera.position.y, sTmp[2] - camera.position.z)
          * LIGHT_TIME_AU_S / 60;
        patch.flyby = {
          target: flight.target, from: flight.from, tau: flight.tau, speedC: flight.speedC,
          lightMinutesToTarget: lightMin, kind: flight.kind === 'fade' ? 'minjerk' : flight.kind,
        };
        storeFlyby = patch.flyby; storeT = flight.t; write = true;
      }
    } else if (storeFlyby !== null) {
      patch.flyby = null; storeFlyby = null; storeT = -1; write = true;
    }
    if (mode === 'skyView' && sky) {
      const fovDeg = camera.fov;
      const s = storeSky;
      if (!s || s.from !== sky.from || s.to !== sky.to || s.locked !== sky.locked
        || Math.abs(s.fovDeg - fovDeg) > SKY_STORE_FOV_REL * fovDeg) {
        patch.sky = { from: sky.from, to: sky.to, fovDeg, locked: sky.locked };
        storeSky = patch.sky; write = true;
      }
    } else if (storeSky !== null) {
      patch.sky = null; storeSky = null; write = true;
    }
    if (write) store.set(patch);
  }

  function onFade(fn) {
    fadeListeners.add(fn);
    return () => fadeListeners.delete(fn);
  }
  function onSignal(fn) {
    signalListeners.add(fn);
    return () => signalListeners.delete(fn);
  }

  function dispose() {
    fadeListeners.clear();
    signalListeners.clear();
    signalQueue.length = 0;
    controls.dispose();
  }

  configureFreeControls();
  controls.update();

  // Public transitions sync the store immediately so UI code reading store.get() right after a call sees the new mode.
  return {
    mode: () => mode,
    follow: (id, opts) => { const ok = follow(id, opts); syncStore(); return ok; },
    free: () => { const did = free(); syncStore(); return did; },
    skyView: (fromId, toIds, opts) => { const ok = skyView(fromId, toIds, opts); syncStore(); return ok; },
    setSkyFov: (fovDeg, seconds) => setSkyFov(fovDeg, seconds),
    exitSkyView: (seconds) => { const did = exitSkyView(seconds); syncStore(); return did; },
    flyTo: (id, opts) => { const ok = flyTo(id, opts); syncStore(); return ok; },
    /** Compatibility stub: the rig tour is gone (the story engine plays tours). Always false. */
    tour: () => false,
    cancel: () => { const did = cancel(); syncStore(); return did; },
    resetHome: () => { resetHome(); syncStore(); },
    update,
    controls,
    setLookTarget,
    onFade,
    onSignal,
    viewPose: (o) => { viewPose(o); syncStore(); },
    frameTopDown: (o) => { frameTopDown(o); syncStore(); },
    frameBodies: (ids, opts) => { const ok = frameBodies(ids, opts); syncStore(); return ok; },
    dollyTo: (distanceAu, seconds) => { const ok = dollyTo(distanceAu, seconds); syncStore(); return ok; },
    orbitDwell: (opts) => orbitDwell(opts),
    stopDwell,
    dispose,
    /** @returns {string|null} */
    followed: () => (mode === 'follow' ? followId : null),
    baseFovDeg: () => baseFov,
  };
}

// One body on screen: anchor (positioned in AU) → spin (quaternion from the body→ecliptic 3×3) → mesh (unit sphere with
// the pole on local +Z, scaled (a, a, c)·k) + optional atmosphere shell, Earth clouds, Saturn rings, CSS2D label and a
// debug overlay (spin axis, prime-meridian great circle, sub-solar dot).
//
// r186 facts honoured here (plan §Orientation › Rendering, critique engineering section):
// - SphereGeometry(1, 64, 32).rotateX(π/2): three builds the sphere with poles on ±Y and the u = 0 seam on −X
//   (src/geometries/SphereGeometry.js: vertex.x = −r·cos φ); the active R_x(π/2) maps +Y → +Z, leaving ±X in place, so
//   the pole is local +Z and the seam stays on −X (u = 0.5, the prime meridian of an equirectangular map, is on +X).
// - The orientation matrix is row-major body→ecliptic: column 3 = spin axis, column 1 = prime meridian. Matrix4.set()
//   takes row-major arguments, so the 3×3 is copied verbatim and Quaternion.setFromRotationMatrix gives the spin.
// - Log depth: the atmosphere/cloud/ring materials (materials.js) are depthWrite:false so the ~5-ulp float32 gap between
//   a planet and its 1.02 R shell never z-fights; layering is by renderOrder (mesh 0, rings/clouds 1, atmosphere 2).
// - Sun sprites: Sprite.scale is the full quad width in world units (sprite.glsl: scale *= −mvPosition.z with
//   sizeAttenuation on), so a sprite of diameter D CSS px at distance d needs scale = D·2·tan(fov/2)·d/H.

import {
  Object3D, Mesh, SphereGeometry, RingGeometry, Matrix4, Quaternion, Vector3, BufferGeometry,
  Float32BufferAttribute, Line, LineLoop, LineBasicMaterial, MeshBasicMaterial, MathUtils,
} from 'three';
import { createLabel } from './labels.js';

/** IAU 2012 astronomical unit, km (https://ssd.jpl.nasa.gov/astro_par.html). */
export const AU_KM = 149597870.7;
/** Bodies that get a fresnel atmosphere shell (plan §Rendering › Bodies). */
const ATMOSPHERE_IDS = new Set(['earth', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
const ATMOSPHERE_SCALE = 1.02;
const CLOUD_SCALE = 1.006;
/** Projected-radius threshold (px) for the 128×64 LOD sphere and for drawing the mesh at all. */
const LOD_HI_PX = 300;
const MESH_MIN_PX = 0.35;
/** Sun corona sprite diameters in Sun radii and the on-screen minimum of the glare (CSS px). */
const CORONA_DIAM_R = 3.5;
const GLARE_DIAM_R = 8;
const GLARE_MIN_PX = 28;

const _m4 = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();
const _v2 = new Vector3();
const _sunDir = new Vector3();
const _scale = new Vector3();

let shared = null;
/**
 * Shared unit spheres, pole on +Z (created lazily so importing this module never touches the GPU or DOM).
 * @returns {{ lo: SphereGeometry, hi: SphereGeometry }}
 */
export function getSharedGeometries() {
  if (!shared) {
    shared = {
      lo: new SphereGeometry(1, 64, 32).rotateX(Math.PI / 2),
      hi: new SphereGeometry(1, 128, 64).rotateX(Math.PI / 2),
    };
  }
  return shared;
}

/**
 * Copy a row-major 3×3 (flat 9-array as in astro/vec.js, or nested rows) into a quaternion.
 * @param {number[]|number[][]} m
 * @param {Quaternion} q
 */
export function quaternionFromMat3(m, q) {
  if (m.length === 9) {
    _m4.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
  } else {
    _m4.set(m[0][0], m[0][1], m[0][2], 0, m[1][0], m[1][1], m[1][2], 0, m[2][0], m[2][1], m[2][2], 0, 0, 0, 0, 1);
  }
  q.setFromRotationMatrix(_m4);
  return q;
}

/**
 * The custom uniforms of a materials.js material (userData.uniforms) or a ShaderMaterial's own uniforms.
 * @param {import('three').Material|null|undefined} material
 * @returns {Record<string, {value: any}>|null}
 */
function uniformsOf(material) {
  if (!material) return null;
  return material.userData?.uniforms ?? material.uniforms ?? null;
}

/**
 * Set a vec3 uniform if the material declares it (value may be a Vector3 or a plain array).
 * @param {Record<string, {value: any}>|null} u
 * @param {string} name
 * @param {Vector3} v
 */
function setVec3(u, name, v) {
  if (!u) return;
  const uni = u[name];
  if (!uni) return;
  const val = uni.value;
  if (val && val.isVector3) val.copy(v);
  else if (val && val.length >= 3) { val[0] = v.x; val[1] = v.y; val[2] = v.z; }
}

/**
 * @typedef {object} BodyDef
 * @property {string} id
 * @property {string} name
 * @property {number} radiusEqKm
 * @property {number} radiusPolarKm
 * @property {number} colour
 * @property {number} priority
 * @property {number} [siderealOrbitDays]
 * @property {{ innerKm: number, outerKm: number }} [rings]
 */

/**
 * @param {BodyDef} bodyDef
 * @param {object} materials  the materials.js module (createPlanetMaterial, createSunMaterial, createCoronaSprites,
 *   createAtmosphereMaterial, createEarthCloudMaterial, createRingMaterial, setMaterialTime)
 */
export function createBodyView(bodyDef, materials) {
  const id = bodyDef.id;
  const isSun = id === 'sun';
  const geo = getSharedGeometries();
  const polarRatio = bodyDef.radiusPolarKm > 0 ? bodyDef.radiusPolarKm / bodyDef.radiusEqKm : 1;

  const anchor = new Object3D();
  anchor.name = 'body:' + id;
  const spin = new Object3D();
  spin.name = 'spin:' + id;
  anchor.add(spin);

  const ownedMaterials = [];
  const ownedGeometries = [];

  // --- surface mesh -------------------------------------------------------------------------------------------------
  const surfaceMaterial = isSun ? materials.createSunMaterial() : materials.createPlanetMaterial(id);
  ownedMaterials.push(surfaceMaterial);
  const mesh = new Mesh(geo.lo, surfaceMaterial);
  mesh.name = 'mesh:' + id;
  mesh.renderOrder = 0;
  mesh.frustumCulled = false; // the scaled unit sphere at AU distances: skip the bounding-sphere test (9 draws)
  spin.add(mesh);

  // --- Sun corona sprites ---------------------------------------------------------------------------------------
  let corona = null;
  let glare = null;
  if (isSun) {
    const sprites = materials.createCoronaSprites();
    corona = sprites.corona;
    glare = sprites.glare;
    corona.name = 'corona';
    glare.name = 'glare';
    corona.renderOrder = 3;
    glare.renderOrder = 3;
    corona.frustumCulled = false;
    glare.frustumCulled = false;
    anchor.add(corona, glare);
    ownedMaterials.push(corona.material, glare.material);
  }

  // --- atmosphere shell -------------------------------------------------------------------------------------------
  let atmosphere = null;
  if (!isSun && ATMOSPHERE_IDS.has(id) && typeof materials.createAtmosphereMaterial === 'function') {
    const m = materials.createAtmosphereMaterial(id);
    ownedMaterials.push(m);
    atmosphere = new Mesh(geo.lo, m);
    atmosphere.name = 'atmosphere:' + id;
    atmosphere.renderOrder = 2;
    atmosphere.frustumCulled = false;
    spin.add(atmosphere);
  }

  // --- Earth clouds (spin with the surface; slow FBM drift lives in the material) ------------------------------------
  let clouds = null;
  if (id === 'earth' && typeof materials.createEarthCloudMaterial === 'function') {
    const m = materials.createEarthCloudMaterial();
    ownedMaterials.push(m);
    clouds = new Mesh(geo.lo, m);
    clouds.name = 'clouds:earth';
    clouds.renderOrder = 1;
    clouds.frustumCulled = false;
    spin.add(clouds);
  }

  // --- rings (Saturn): annulus in the equatorial (local xy) plane, radii in planet radii ------------------------------
  let rings = null;
  let ringInnerR = 0;
  let ringOuterR = 0;
  if (bodyDef.rings && typeof materials.createRingMaterial === 'function') {
    ringInnerR = bodyDef.rings.innerKm / bodyDef.radiusEqKm;
    ringOuterR = bodyDef.rings.outerKm / bodyDef.radiusEqKm;
    const rg = new RingGeometry(ringInnerR, ringOuterR, 256, 1);
    ownedGeometries.push(rg);
    const m = materials.createRingMaterial({ innerR: ringInnerR, outerR: ringOuterR });
    ownedMaterials.push(m);
    rings = new Mesh(rg, m);
    rings.name = 'rings:' + id;
    rings.renderOrder = 1;
    rings.frustumCulled = false;
    spin.add(rings);
  }

  // --- label ---------------------------------------------------------------------------------------------------------
  const labelHandle = createLabel(bodyDef);
  anchor.add(labelHandle.object);

  // --- debug overlay (lazy) -----------------------------------------------------------------------------------------
  /** @type {{ group: Object3D, dot: Mesh, materials: import('three').Material[], geometries: BufferGeometry[] }|null} */
  let debug = null;
  let debugOn = false;
  function buildDebug() {
    const group = new Object3D();
    group.name = 'debug:' + id;
    const mats = [];
    const geoms = [];
    // spin axis: local +Z (column 3 of the orientation matrix), ±1.5 R
    const axisGeom = new BufferGeometry();
    axisGeom.setAttribute('position', new Float32BufferAttribute([0, 0, -1.5, 0, 0, 1.5], 3));
    const axisMat = new LineBasicMaterial({ color: 0x7aa2ff, depthTest: true, transparent: true, opacity: 0.95 });
    const axis = new Line(axisGeom, axisMat);
    axis.renderOrder = 5;
    axis.frustumCulled = false;
    geoms.push(axisGeom); mats.push(axisMat);
    group.add(axis);
    // prime meridian: the great circle through local +X (column 1) and the pole, drawn just above the surface
    const M = 128;
    const pm = new Float32Array(M * 3);
    for (let i = 0; i < M; i++) {
      const t = (i / M) * Math.PI * 2;
      pm[i * 3] = Math.cos(t) * 1.005;
      pm[i * 3 + 1] = 0;
      pm[i * 3 + 2] = Math.sin(t) * 1.005;
    }
    const pmGeom = new BufferGeometry();
    pmGeom.setAttribute('position', new Float32BufferAttribute(pm, 3));
    const pmMat = new LineBasicMaterial({ color: 0xffb454, depthTest: true, transparent: true, opacity: 0.9 });
    const meridian = new LineLoop(pmGeom, pmMat);
    meridian.renderOrder = 5;
    meridian.frustumCulled = false;
    geoms.push(pmGeom); mats.push(pmMat);
    group.add(meridian);
    // equator hint (faint) helps read the tilt
    const eqGeom = new BufferGeometry();
    const eq = new Float32Array(M * 3);
    for (let i = 0; i < M; i++) {
      const t = (i / M) * Math.PI * 2;
      eq[i * 3] = Math.cos(t) * 1.003;
      eq[i * 3 + 1] = Math.sin(t) * 1.003;
      eq[i * 3 + 2] = 0;
    }
    eqGeom.setAttribute('position', new Float32BufferAttribute(eq, 3));
    const eqMat = new LineBasicMaterial({ color: 0x8b93a7, depthTest: true, transparent: true, opacity: 0.45 });
    const equator = new LineLoop(eqGeom, eqMat);
    equator.renderOrder = 5;
    equator.frustumCulled = false;
    geoms.push(eqGeom); mats.push(eqMat);
    group.add(equator);
    spin.add(group);
    // sub-solar dot: a child of the anchor (world-aligned), positioned from the Sun direction each frame
    const dotGeom = new SphereGeometry(1, 12, 8);
    const dotMat = new MeshBasicMaterial({ color: 0xffffff, depthTest: true });
    const dot = new Mesh(dotGeom, dotMat);
    dot.name = 'subsolar:' + id;
    dot.renderOrder = 5;
    dot.frustumCulled = false;
    geoms.push(dotGeom); mats.push(dotMat);
    anchor.add(dot);
    debug = { group, dot, materials: mats, geometries: geoms };
  }

  /** @param {boolean} on */
  function setDebug(on) {
    debugOn = !!on;
    if (debugOn && !debug) buildDebug();
    if (debug) {
      debug.group.visible = debugOn;
      debug.dot.visible = debugOn && !isSun;
    }
  }

  // --- per-frame update -------------------------------------------------------------------------------------------
  let hiLod = false;
  let lastR = -1;

  /**
   * @param {object} args
   * @param {{x:number,y:number,z:number}|number[]} args.pos  heliocentric position, AU (state object or [x,y,z])
   * @param {number[]|number[][]|null|undefined} args.mat3   body→ecliptic rotation, row-major
   * @param {number} args.dispRadiusAu  displayed equatorial radius (AU) = radiusEq·k (Sun: ·min(k, 30))
   * @param {number} args.pxRadius      projected display radius in CSS px
   * @param {number} args.tSeconds      animation time for uTime
   * @param {import('three').PerspectiveCamera} [args.camera]  matrixWorldInverse must be current (for view-space uniforms)
   * @param {number} [args.viewportH]   CSS px (Sun glare clamp)
   * @param {number[]|{x:number,y:number,z:number}} [args.sunDir]  optional unit vector body→Sun (world); default −pos/|pos|
   */
  function update({ pos, mat3, dispRadiusAu, pxRadius, tSeconds, camera, viewportH, sunDir }) {
    const px = pos.x !== undefined ? pos.x : pos[0];
    const py = pos.y !== undefined ? pos.y : pos[1];
    const pz = pos.z !== undefined ? pos.z : pos[2];
    anchor.position.set(px, py, pz);
    if (mat3) quaternionFromMat3(mat3, spin.quaternion);

    const a = dispRadiusAu;
    const c = a * polarRatio;
    if (a !== lastR) {
      lastR = a;
      mesh.scale.set(a, a, c);
      if (atmosphere) atmosphere.scale.set(a * ATMOSPHERE_SCALE, a * ATMOSPHERE_SCALE, c * ATMOSPHERE_SCALE);
      if (clouds) clouds.scale.set(a * CLOUD_SCALE, a * CLOUD_SCALE, c * CLOUD_SCALE);
      if (rings) rings.scale.set(a, a, a);
      if (debug) {
        debug.group.scale.set(a, a, c);
        debug.dot.scale.setScalar(a * 0.03);
      }
      if (corona) corona.scale.setScalar(CORONA_DIAM_R * a);
    }

    // visibility / LOD
    const drawMesh = pxRadius > MESH_MIN_PX;
    spin.visible = drawMesh;
    if (drawMesh) {
      const wantHi = pxRadius > LOD_HI_PX;
      if (wantHi !== hiLod) {
        hiLod = wantHi;
        const g = wantHi ? geo.hi : geo.lo;
        mesh.geometry = g;
        if (atmosphere) atmosphere.geometry = g;
        if (clouds) clouds.geometry = g;
      }
    }

    // Sun direction (world): Sun at the origin ⇒ −pos normalised
    let haveSun = false;
    if (!isSun) {
      if (sunDir) {
        if (sunDir.x !== undefined) _sunDir.set(sunDir.x, sunDir.y, sunDir.z); else _sunDir.set(sunDir[0], sunDir[1], sunDir[2]);
        haveSun = _sunDir.lengthSq() > 0;
      } else {
        _sunDir.set(-px, -py, -pz);
        haveSun = _sunDir.lengthSq() > 0;
      }
      if (haveSun) _sunDir.normalize();
    }

    // material uniforms
    const setTime = typeof materials.setMaterialTime === 'function';
    if (setTime) materials.setMaterialTime(surfaceMaterial, tSeconds);
    if (isSun) {
      // Close up, the photosphere is the subject: ease the HDR level down so bloom stops clipping the disc to
      // white and the granulation stays readable. Far away the full HDR level keeps the glow and bloom.
      const u = uniformsOf(surfaceMaterial);
      if (u && u.uIntensity) {
        const t = Math.min(1, Math.max(0, (pxRadius - 30) / 320));
        u.uIntensity.value = 1 - 0.62 * t * t * (3 - 2 * t);
      }
    }
    if (haveSun && camera) {
      _v.copy(_sunDir).transformDirection(camera.matrixWorldInverse); // view space, unit
      setVec3(uniformsOf(surfaceMaterial), 'uSunDirView', _v);
      if (atmosphere) {
        setVec3(uniformsOf(atmosphere.material), 'uSunDirView', _v);
        if (setTime) materials.setMaterialTime(atmosphere.material, tSeconds);
      }
      if (clouds) {
        setVec3(uniformsOf(clouds.material), 'uSunDirView', _v);
        if (setTime) materials.setMaterialTime(clouds.material, tSeconds);
      }
      if (rings) {
        const u = uniformsOf(rings.material);
        if (u) {
          _q.copy(spin.quaternion).invert();
          _v2.copy(_sunDir).applyQuaternion(_q); // ring object space (= spin frame)
          setVec3(u, 'uSunDirObj', _v2);
          setVec3(u, 'uLightDirObj', _v2);
          setVec3(u, 'uSunDirView', _v);
          _v2.copy(camera.position).sub(anchor.position).applyQuaternion(_q).divideScalar(a); // planet radii
          setVec3(u, 'uCamPosObj', _v2);
          if (setTime) materials.setMaterialTime(rings.material, tSeconds);
        }
      }
    }

    // Sun glare: keep ≥ 28 CSS px on screen so it glows from afar
    if (isSun && camera) {
      const d = camera.position.distanceTo(anchor.position);
      const tanHalf = Math.tan(MathUtils.DEG2RAD * camera.fov * 0.5);
      const H = viewportH || 1;
      const minScale = GLARE_MIN_PX * 2 * tanHalf * d / H;
      glare.scale.setScalar(Math.max(GLARE_DIAM_R * a, minScale));
      mesh.visible = drawMesh;
    }

    // debug sub-solar dot: surface point in the direction of the Sun (oblateness applied in the spin frame)
    if (debugOn && debug && haveSun) {
      _q.copy(spin.quaternion).invert();
      _scale.set(a, a, c).multiplyScalar(1.01);
      _v.copy(_sunDir).applyQuaternion(_q).multiply(_scale).applyQuaternion(spin.quaternion);
      debug.dot.position.copy(_v);
    }
  }

  function dispose() {
    labelHandle.dispose();
    for (const m of ownedMaterials) m?.dispose?.();
    for (const g of ownedGeometries) g.dispose();
    if (debug) {
      for (const m of debug.materials) m.dispose();
      for (const g of debug.geometries) g.dispose();
    }
    anchor.removeFromParent();
  }

  return {
    id,
    def: bodyDef,
    anchor,
    spin,
    mesh,
    atmosphere,
    clouds,
    rings,
    corona,
    glare,
    label: labelHandle.object,
    labelHandle,
    ringInnerR,
    ringOuterR,
    update,
    setDebug,
    dispose,
  };
}

// Atmosphere: ONE FrontSide shell at uShell·R (per body, 1.03–1.08), additive, depthWrite off, depthTest on. The
// front shell lies in front of the planet (so the haze is drawn OVER the disc, brightening toward the limb) and in
// front of whatever is behind the planet (so the halo ring outside the disc is drawn too); a BackSide shell can only
// ever render the halo because the disc's depth rejects it, which is what produced the old "clipped, limb-peaking"
// rims. The ray through each fragment is marched analytically through an exponential atmosphere:
//
//   density ρ(h) = exp(−h / H),  h = r − 1  (H = scale height in planet radii; Earth ≈ 8 km / 6378 km ≈ 0.0013 for
//   the pressure scale height — the visual look uses a larger H, ≈ 0.02 for Earth, because the eye integrates the
//   blue skylight over many scale heights of forward-scattered light; the per-body H/density values in materials.js
//   are stylised, chosen so the day-side limb saturates while the disc centre keeps a faint haze),
//   column = ∫ ρ ds along the chord through the shell (stopping at the planet when the ray hits it),
//   τ = density · column / H (so τ = density at the disc centre and ≈ √(2π/H) · density at the grazing limb),
//   light = 1 − exp(−τ) (Beer–Lambert saturation: thick atmospheres go cream instead of blowing out),
//   lit fraction: each sample is sunlit unless it lies on the night side of the terminator plane AND inside the
//   planet's shadow cylinder (edge softened by uTerminatorSoft), so the upper atmosphere stays lit past the
//   terminator — the twilight arc — and a Gaussian band around N·L = 0 blends the colour toward uTwilightColor;
//   night limb: a small fraction uNightGlow of the colour stays on the unlit limb (airglow / twilight ring).
// Geometry is done in "planet units" (the unit sphere is the planet surface): bodyView.js supplies the camera
// position uCamPosObj = S⁻¹ R⁻¹ (cam − centre) and the Sun direction uSunDirObj in that frame (S = (a, a, c)
// display scale, R = spin). The closest-approach point is formed as O − (O·D)D BEFORE any squared length, so the
// march stays accurate in float32 when the camera is thousands of radii away. Cost: 12 exp per fragment on a thin
// shell — only the close-up fills many pixels.
// r186 chunk rules per CLAUDE.md: log depth + tone mapping + colour space.

export const ATMOSPHERE_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uShell;        // shell radius / planet radius
varying vec3 vP;             // fragment position in planet units
void main() {
  vP = position * uShell;    // unit-sphere geometry scaled by (a, a, c)·uShell by the mesh → position·uShell in planet units
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const ATMOSPHERE_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;           // scattering colour (linear)
uniform vec3 uTwilightColor;   // sunset tint near the terminator (linear)
uniform float uScaleHeight;    // H, planet radii
uniform float uDensity;        // optical depth of the vertical column
uniform float uShell;          // shell radius / planet radius
uniform float uTerminatorSoft; // softness of the shadow-cylinder edge, planet radii
uniform float uTwilight;       // 0..1 strength of the sunset tint
uniform float uNightGlow;      // fraction of the colour kept on the night limb
uniform float uIntensity;      // overall gain (0 disables)
uniform vec3 uSunDirObj;       // unit, planet frame, body -> Sun
uniform vec3 uCamPosObj;       // camera position, planet units
varying vec3 vP;
const int SAMPLES = 12;
void main() {
  vec3 O = uCamPosObj;
  vec3 D = normalize(vP - O);
  float s0 = -dot(O, D);                       // distance along the ray to the closest approach
  vec3 Pc = O + s0 * D;                        // closest point to the planet centre (small numbers: safe in float32)
  float b2 = dot(Pc, Pc);
  float Rs2 = uShell * uShell;
  if (b2 >= Rs2 - 1e-6) discard;               // outside the shell silhouette (numerical safety)
  float hs = sqrt(Rs2 - b2);
  float tIn = max(-hs, -s0);                   // shell entry (or the camera itself when inside the shell), relative to Pc
  float tOut = (b2 < 1.0) ? -sqrt(1.0 - b2) : hs;   // the planet's surface, or the far side of the shell
  float len = tOut - tIn;
  if (len <= 0.0) discard;
  float ds = len / float(SAMPLES);
  float top = uShell - 1.0;
  float col = 0.0;
  float lit = 0.0;
  float tw = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float t = tIn + (float(i) + 0.5) * ds;
    vec3 P = Pc + t * D;
    float r = length(P);
    float h = r - 1.0;
    // exponential density, faded to exactly 0 at the shell top so the silhouette never shows an edge
    float rho = exp(-h / uScaleHeight) * (1.0 - smoothstep(0.7 * top, top, h)) * ds;
    float along = dot(P, uSunDirObj);
    float q = length(P - along * uSunDirObj);
    float day = (along >= 0.0) ? 1.0 : smoothstep(1.0 - uTerminatorSoft, 1.0 + uTerminatorSoft, q);
    float mu = along / max(r, 1e-6);
    float band = exp(-mu * mu / (2.0 * 0.15 * 0.15));
    col += rho;
    lit += rho * day;
    tw += rho * day * band;
  }
  if (col <= 0.0) discard;
  float tau = uDensity * col / uScaleHeight;
  float sat = 1.0 - exp(-tau);
  float dayFrac = lit / col;
  float twFrac = tw / max(lit, 1e-6);
  vec3 tint = mix(uColor, uTwilightColor, twFrac * uTwilight);
  vec3 rgb = tint * sat * dayFrac + uColor * sat * uNightGlow * (1.0 - dayFrac);
  gl_FragColor = vec4(rgb * uIntensity, 1.0);   // additive blending (SRC_ALPHA, ONE): rgb is what is added
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

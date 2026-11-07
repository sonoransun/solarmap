// Ecliptic grid as ONE analytic disc (CircleGeometry in the XY plane, z = ecliptic north) instead of a 200 AU square
// plane + LineLoops + LineSegments: a radial-gradient plane hint that fades out by uFadeAu (45 AU, just past Neptune),
// four distance rings (uRings, AU) and twelve spokes every 30° of ecliptic longitude (the zodiac's 30° signs, which is
// why 12), all drawn as anti-aliased lines with screen-space derivatives (fwidth) — 1.5 device px wide, with no
// moiré at grazing angles because the smoothstep widens with the derivative. Opacities: plane uPlane (0.05), rings
// uRing (0.10), spokes uSpoke (0.05). Normal blending with analytic alpha; depthWrite off so planets drawn later
// cover it, renderOrder −1 so orbit lines (5) draw on top.

export const GRID_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vXY;
void main() {
  vXY = position.xy;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const GRID_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform vec4 uRings;
uniform float uFadeAu;
uniform float uPlane;
uniform float uRing;
uniform float uSpoke;
varying vec2 vXY;
void main() {
  float r = length(vXY);
  // plane hint: quadratic radial gradient, 0 by uFadeAu
  float g = 1.0 - smoothstep(0.0, uFadeAu, r);
  float plane = g * g;
  // lines keep full strength to 30 AU and fade out by uFadeAu
  float lineFade = 1.0 - smoothstep(0.66 * uFadeAu, uFadeAu, r);
  // rings: distance to each radius in AU, 1.5 px wide via the screen-space derivative of r
  float fw = max(fwidth(r), 1e-6);
  float ring = 0.0;
  for (int i = 0; i < 4; i++) {
    float R = uRings[i];
    ring = max(ring, 1.0 - smoothstep(0.0, 1.5 * fw, abs(r - R)));
  }
  // spokes: arc distance (AU) to the nearest 30° meridian; continuous across sector boundaries and the ±π seam
  float th = r > 1e-6 ? atan(vXY.y, vXY.x) : 0.0;   // atan(0, 0) is undefined in GLSL: guard the Sun's own pixel
  float sector = 0.5235987755982988;
  float dth = abs(mod(th + 0.5 * sector, sector) - 0.5 * sector);
  float arc = dth * r;
  float fwa = max(fwidth(arc), 1e-6);
  float spoke = (1.0 - smoothstep(0.0, 1.5 * fwa, arc)) * smoothstep(0.25, 0.6, r) * (1.0 - smoothstep(0.55 * uFadeAu, 0.9 * uFadeAu, r));
  float a = uPlane * plane + uRing * ring * lineFade + uSpoke * spoke * lineFade;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Photographic surface maps. Equirectangular 2K images from Solar System Scope (CC BY 4.0,
// https://www.solarsystemscope.com/textures/ — "You may use, adapt, and share these textures for any purpose,
// even commercially", attribution required; see the About panel and LICENSES.md).
//
// Loading is asynchronous and optional: the scene starts with the procedural materials and each body is upgraded
// in place as its image arrives, so first paint never waits on 7 MB of imagery.
import { TextureLoader, SRGBColorSpace, RepeatWrapping, ClampToEdgeWrapping, LinearMipmapLinearFilter } from 'three';

/** Files shipped in public/textures (copied to the site root by Vite). */
export const TEXTURE_FILES = Object.freeze({
  mercury: { map: '2k_mercury.jpg' },
  venus: { map: '2k_venus_atmosphere.jpg', surface: '2k_venus_surface.jpg' },
  earth: { map: '2k_earth_daymap.jpg', night: '2k_earth_nightmap.jpg', clouds: '2k_earth_clouds.jpg' },
  mars: { map: '2k_mars.jpg' },
  jupiter: { map: '2k_jupiter.jpg' },
  saturn: { map: '2k_saturn.jpg', ring: '2k_saturn_ring_alpha.png' },
  uranus: { map: '2k_uranus.jpg' },
  neptune: { map: '2k_neptune.jpg' },
  sun: { map: '2k_sun.jpg' },
});

/** Attribution shown in the About panel. */
export const TEXTURE_CREDIT = Object.freeze({
  title: 'Solar System Scope planetary texture maps',
  licence: 'CC BY 4.0',
  url: 'https://www.solarsystemscope.com/textures/',
  note: 'Compiled from NASA elevation and imagery data (Messenger, Magellan, Blue Marble, Viking, Cassini, Voyager).',
});

/**
 * @param {object} [opts]
 * @param {string} [opts.basePath]      where the images live, relative to the page (Vite copies public/ to the root)
 * @param {number} [opts.anisotropy]    renderer.capabilities.getMaxAnisotropy()
 * @param {(id: string, kind: string, tex: import('three').Texture) => void} [opts.onLoad] upgrade hook per image
 * @returns {{ get(id: string, kind?: string): import('three').Texture|null, load(): Promise<void>, dispose(): void, files: typeof TEXTURE_FILES }}
 */
export function createTextureSet({ basePath = './textures/', anisotropy = 8, onLoad = null } = {}) {
  const loader = new TextureLoader();
  /** @type {Map<string, import('three').Texture>} */
  const cache = new Map();
  let disposed = false;

  function configure(tex, kind) {
    // Colour maps carry sRGB data; the ring strip is a 1-D lookup along its width.
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = anisotropy;
    tex.generateMipmaps = true;
    tex.minFilter = LinearMipmapLinearFilter;
    if (kind === 'ring') {
      tex.wrapS = ClampToEdgeWrapping;
      tex.wrapT = ClampToEdgeWrapping;
    } else {
      tex.wrapS = RepeatWrapping;      // equirectangular: wraps in longitude
      tex.wrapT = ClampToEdgeWrapping; // clamped at the poles
    }
    return tex;
  }

  function one(id, kind, file) {
    return new Promise((resolve) => {
      loader.load(
        basePath + file,
        (tex) => {
          if (disposed) { tex.dispose(); resolve(null); return; }
          configure(tex, kind);
          cache.set(`${id}:${kind}`, tex);
          onLoad?.(id, kind, tex);
          resolve(tex);
        },
        undefined,
        () => { console.warn(`[textures] could not load ${file}; keeping the procedural surface for ${id}`); resolve(null); },
      );
    });
  }

  return {
    files: TEXTURE_FILES,
    get(id, kind = 'map') { return cache.get(`${id}:${kind}`) ?? null; },
    /** Load every image; resolves when all have settled (failures are non-fatal). */
    async load() {
      const jobs = [];
      // Order matters only for perceived quality: the bodies a viewer is most likely to be looking at come first.
      const order = ['earth', 'saturn', 'jupiter', 'mars', 'sun', 'venus', 'mercury', 'uranus', 'neptune'];
      for (const id of order) {
        const spec = TEXTURE_FILES[id];
        if (!spec) continue;
        for (const [kind, file] of Object.entries(spec)) {
          if (kind === 'surface') continue; // Venus' surface map is only used by the "surface" debug view
          jobs.push(one(id, kind, file));
        }
      }
      await Promise.all(jobs);
    },
    dispose() {
      disposed = true;
      for (const tex of cache.values()) tex.dispose();
      cache.clear();
    },
  };
}

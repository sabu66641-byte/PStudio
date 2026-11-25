(function(root, factory) {
  'use strict';
  const api = factory();
  if (root) root.PStudioRenderingEnvironment = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function() {
  'use strict';

  const WATER_DEFAULTS = Object.freeze({
    day: Object.freeze({ reflection: '#a4cbdc', shallow: '#65d9bf', deep: '#08727d', foam: '#e3fff6', absorption: 0.19 }),
    dusk: Object.freeze({ reflection: '#d89c99', shallow: '#b87577', deep: '#264a63', foam: '#fff0df', absorption: 0.14 }),
    night: Object.freeze({ reflection: '#526b8f', shallow: '#274f68', deep: '#071f38', foam: '#a9c2df', absorption: 0.25 }),
    studio: Object.freeze({ reflection: '#bdc8d5', shallow: '#7da4aa', deep: '#244a62', foam: '#eff6f8', absorption: 0.17 })
  });

  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  const color = (value, fallback) => (
    typeof value === 'string' && value.trim()
      ? value.trim()
      : Number.isFinite(value) ? value : fallback
  );
  function normalizedDirection(x, y, z, fallback) {
    let dx = Number(x), dy = Number(y), dz = Number(z);
    if (![dx, dy, dz].every(Number.isFinite)) [dx, dy, dz] = fallback;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-6) {
      const fallbackLength = Math.hypot(...fallback) || 1;
      dx = fallback[0] / fallbackLength;
      dy = fallback[1] / fallbackLength;
      dz = fallback[2] / fallbackLength;
    } else {
      dx /= length;
      dy /= length;
      dz /= length;
    }
    return Object.freeze([dx, dy, dz]);
  }

  /**
   * Creates one immutable scene-environment state shared by water, clouds,
   * volumetric fog, contact shadows and the renderer's sky/lighting path.
   * This is deliberately GPU-independent and performs no per-frame work.
   */
  function resolvePStudioEnvironmentState(profile = {}) {
    const name = ['day', 'dusk', 'night', 'studio'].includes(String(profile.name))
      ? String(profile.name)
      : 'day';
    const water = WATER_DEFAULTS[name];
    const lightX = clamp(profile.lightX, -1, 1, -0.35);
    const lightY = clamp(profile.lightY, -1, 1, -0.89);
    const lightZ = clamp(profile.lightZ, -1, 1, -0.28);
    const sunDirection = normalizedDirection(
      profile.skySunX, profile.skySunY, profile.skySunZ,
      [-lightX, -lightY, -lightZ]
    );
    const lightDirection = normalizedDirection(
      -lightX, -lightY, -lightZ,
      sunDirection
    );
    const cloudBase = clamp(profile.cloudBase, -500, 10000, 54);
    const cloudTop = Math.max(cloudBase + 1, clamp(profile.cloudTop, -499, 12000, 108));

    return Object.freeze({
      name,
      sunDirection,
      lightDirection,
      sunColor: color(profile.atmosphereSunColor, color(profile.lightColor, '#fff0d7')),
      fogColor: color(profile.fogColor, '#c7dfea'),
      fogAmbientColor: color(profile.hemisphereSky, color(profile.fogColor, '#d9eeff')),
      fogDensity: clamp(profile.fogDensity, 0, 0.08, 0.0018),
      fogHeightFalloff: clamp(profile.fogHeightFalloff, 0, 0.2, 0.018),
      fogBaseHeight: clamp(profile.fogBaseHeight, -10000, 10000, 0),
      fogAnisotropy: clamp(profile.fogAnisotropy, 0, 0.88, 0.42),
      cloudDensity: clamp(profile.cloudDensity, 0, 2, 0.78),
      cloudCoverage: clamp(profile.cloudCoverage, 0, 1, 0.48),
      cloudDetail: clamp(profile.cloudDetail, 0, 1, 0.58),
      cloudBase,
      cloudTop,
      atmosphereStrength: clamp(profile.atmosphereStrength, 0, 1, 0.96),
      waterReflectionTint: color(profile.waterReflectionTint, water.reflection),
      waterShallow: color(profile.waterShallow, water.shallow),
      waterDeep: color(profile.waterDeep, water.deep),
      waterFoam: color(profile.waterFoam, water.foam),
      waterAbsorption: clamp(profile.waterAbsorption, 0, 2, water.absorption)
    });
  }

  return Object.freeze({
    resolvePStudioEnvironmentState,
    waterDefaults: WATER_DEFAULTS
  });
});

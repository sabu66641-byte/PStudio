(function(root, factory) {
  'use strict';
  const api = factory();
  if (root) root.PStudioSceneEnvironment = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function() {
  'use strict';

  const PRESETS = Object.freeze({
    day: Object.freeze({
      label: '昼',
      skyTop: '#347CB7',
      skyMid: '#79BCE0',
      horizon: '#D7EDF7',
      ground: '#89977A',
      fogColor: '#B9D9E8',
      fogNear: 55,
      fogFar: 1450,
      lightColor: '#FFF1D6',
      lightIntensity: 2.35,
      lightX: -0.35,
      lightY: -0.89,
      lightZ: -0.28,
      hemisphereSky: '#D9EEFF',
      hemisphereGround: '#68725C',
      hemisphereIntensity: 0.95,
      environmentIntensity: 0.8,
      sunX: 0.72,
      sunY: 0.29,
      sunRadius: 17,
      sunGlow: 0.55,
      skySunX: 0.35, skySunY: 0.89, skySunZ: 0.28,
      skyTurbidity: 2.2, skyRayleigh: 2.15, skyMieCoefficient: 0.0048, skyMieDirectionalG: 0.82,
      atmosphereSunColor: '#FFF4DF', moonDirectionX: 0, moonDirectionY: 1, moonDirectionZ: 0, moonIntensity: 0,
      fogDensity: 0.0018, fogHeightFalloff: 0.018, fogBaseHeight: 0, fogAnisotropy: 0.42
    }),
    dusk: Object.freeze({
      label: '夕方',
      skyTop: '#34345F',
      skyMid: '#B65F67',
      horizon: '#F0B17D',
      ground: '#665365',
      fogColor: '#BB897E',
      fogNear: 45,
      fogFar: 1100,
      lightColor: '#FFC08C',
      lightIntensity: 1.55,
      lightX: -0.89,
      lightY: -0.12,
      lightZ: -0.44,
      hemisphereSky: '#C5A0B8',
      hemisphereGround: '#43394D',
      hemisphereIntensity: 0.62,
      environmentIntensity: 0.58,
      sunX: 0.77,
      sunY: 0.43,
      sunRadius: 23,
      sunGlow: 0.9,
      skySunX: 0.89, skySunY: 0.12, skySunZ: 0.44,
      skyTurbidity: 8.2, skyRayleigh: 2.25, skyMieCoefficient: 0.018, skyMieDirectionalG: 0.88,
      atmosphereSunColor: '#FFB06F', moonDirectionX: 0, moonDirectionY: 1, moonDirectionZ: 0, moonIntensity: 0,
      fogDensity: 0.0032, fogHeightFalloff: 0.012, fogBaseHeight: 0, fogAnisotropy: 0.58
    }),
    night: Object.freeze({
      label: '夜',
      skyTop: '#030817',
      skyMid: '#0B1930',
      horizon: '#1B2A43',
      ground: '#09111F',
      fogColor: '#27344A',
      fogNear: 35,
      fogFar: 900,
      lightColor: '#A8C7F4',
      lightIntensity: 0.72,
      lightX: -0.38,
      lightY: -0.88,
      lightZ: -0.27,
      hemisphereSky: '#52698F',
      hemisphereGround: '#151C2A',
      hemisphereIntensity: 0.28,
      environmentIntensity: 0.3,
      sunX: 0.8,
      sunY: 0.25,
      sunRadius: 0,
      sunGlow: 0,
      skySunX: -0.18, skySunY: -0.52, skySunZ: 0.84,
      skyTurbidity: 2.8, skyRayleigh: 1.12, skyMieCoefficient: 0.0012, skyMieDirectionalG: 0.78,
      atmosphereSunColor: '#9DBBEA', moonDirectionX: 0.38, moonDirectionY: 0.88, moonDirectionZ: 0.27, moonIntensity: 0.78,
      fogDensity: 0.00085, fogHeightFalloff: 0.024, fogBaseHeight: 0, fogAnisotropy: 0.28
    }),
    studio: Object.freeze({
      label: 'スタジオ',
      skyTop: '#414B5B',
      skyMid: '#788493',
      horizon: '#ADB8C4',
      ground: '#58616D',
      fogColor: '#8B96A4',
      fogNear: 85,
      fogFar: 1650,
      lightColor: '#FFF8EA',
      lightIntensity: 2.1,
      lightX: -0.42,
      lightY: -0.82,
      lightZ: -0.38,
      hemisphereSky: '#E1E9F2',
      hemisphereGround: '#46505D',
      hemisphereIntensity: 1.0,
      environmentIntensity: 1.05,
      sunX: 0.5,
      sunY: 0.28,
      sunRadius: 0,
      sunGlow: 0,
      skySunX: 0.42, skySunY: 0.82, skySunZ: 0.38,
      skyTurbidity: 2.0, skyRayleigh: 1.95, skyMieCoefficient: 0.0042, skyMieDirectionalG: 0.8,
      atmosphereSunColor: '#FFF8EA', moonDirectionX: 0, moonDirectionY: 1, moonDirectionZ: 0, moonIntensity: 0,
      fogDensity: 0.0011, fogHeightFalloff: 0.02, fogBaseHeight: 0, fogAnisotropy: 0.34
    })
  });

  function normalizePreset(value) {
    const name = String(value || 'day').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(PRESETS, name) ? name : 'day';
  }

  function getPreset(value) {
    const name = normalizePreset(value);
    return Object.assign({ name }, PRESETS[name]);
  }

  function listPresets() {
    return Object.keys(PRESETS).map(name => ({ name, label: PRESETS[name].label }));
  }

  return Object.freeze({ normalizePreset, getPreset, listPresets });
});

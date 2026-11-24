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
      skyTop: '#1C5A92',
      skyMid: '#438FC3',
      horizon: '#CDE5EF',
      ground: '#313B3D',
      fogColor: '#C7DFEA',
      fogNear: 82,
      fogFar: 1900,
      lightColor: '#FFF5E2',
      lightIntensity: 2.55,
      lightX: -0.35,
      lightY: -0.89,
      lightZ: -0.28,
      hemisphereSky: '#E0F1FF',
      hemisphereGround: '#78846F',
      hemisphereIntensity: 1.02,
      environmentIntensity: 0.92,
      starBrightness: 1,
      moonGlow: 0,
      sunX: 0.72,
      sunY: 0.29,
      sunRadius: 17,
      sunGlow: 0.76,
      sunIntensity: 1.24,
      sunAngularRadius: 0.28,
      sunColor: '#FFF7E5',
      cloudDensity: 1.08,
      cloudCoverage: 0.56,
      cloudDetail: 0.94,
      cloudBase: 38,
      cloudTop: 168,
      skySunX: 0.35, skySunY: 0.89, skySunZ: 0.28,
      skyTurbidity: 2.05, skyRayleigh: 2.6, skyMieCoefficient: 0.0042, skyMieDirectionalG: 0.82,
      skyExposure: 0.56, twilightStrength: 0,
      atmosphereSunColor: '#FFF7E5', moonDirectionX: 0, moonDirectionY: 1, moonDirectionZ: 0, moonIntensity: 0, moonPhase: 0.5,
      fogDensity: 0.00145, fogHeightFalloff: 0.016, fogBaseHeight: 0, fogAnisotropy: 0.5
    }),
    dusk: Object.freeze({
      label: '夕方',
      skyTop: '#171B42',
      skyMid: '#5F355F',
      horizon: '#F7AD79',
      ground: '#252133',
      fogColor: '#C58A7E',
      fogNear: 48,
      fogFar: 1180,
      lightColor: '#FFB28A',
      lightIntensity: 1.52,
      lightX: 0.60,
      lightY: -0.008,
      lightZ: 0.80,
      hemisphereSky: '#C5A0B8',
      hemisphereGround: '#43394D',
      hemisphereIntensity: 0.56,
      environmentIntensity: 0.56,
      starBrightness: 1,
      moonGlow: 0,
      sunX: 0.77,
      sunY: 0.43,
      sunRadius: 18,
      sunGlow: 0.72,
      sunIntensity: 1.42,
      sunAngularRadius: 1.55,
      sunColor: '#FFB27A',
      cloudDensity: 0.88,
      cloudCoverage: 0.50,
      cloudDetail: 1,
      cloudBase: 42,
      cloudTop: 148,
      skySunX: -0.60, skySunY: 0.008, skySunZ: -0.80,
      skyTurbidity: 5.2, skyRayleigh: 2.95, skyMieCoefficient: 0.0092, skyMieDirectionalG: 0.84,
      skyExposure: 0.52, twilightStrength: 1,
      atmosphereSunColor: '#FFB27A', moonDirectionX: 0, moonDirectionY: 1, moonDirectionZ: 0, moonIntensity: 0, moonPhase: 0.5, moonColor: '#C7DCFF',
      fogDensity: 0.0018, fogHeightFalloff: 0.014, fogBaseHeight: 0, fogAnisotropy: 0.54
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
      lightColor: '#B7D0FA',
      lightIntensity: 1.08,
      lightX: -0.38,
      lightY: -0.88,
      lightZ: -0.27,
      hemisphereSky: '#52698F',
      hemisphereGround: '#151C2A',
      hemisphereIntensity: 0.42,
      environmentIntensity: 0.44,
      starBrightness: 1.5,
      moonGlow: 1.08,
      sunX: 0.8,
      sunY: 0.25,
      sunRadius: 0,
      sunGlow: 0,
      sunIntensity: 0,
      sunAngularRadius: 1.2,
      sunColor: '#A8C7F4',
      cloudDensity: 0,
      cloudCoverage: 0.48,
      cloudDetail: 0.7,
      cloudBase: 54,
      cloudTop: 108,
      skySunX: -0.18, skySunY: -0.52, skySunZ: 0.84,
      skyTurbidity: 2.8, skyRayleigh: 1.12, skyMieCoefficient: 0.0012, skyMieDirectionalG: 0.78,
      skyExposure: 0.45, twilightStrength: 0,
      atmosphereSunColor: '#B4CFFF', moonDirectionX: 0.38, moonDirectionY: 0.88, moonDirectionZ: 0.27, moonIntensity: 1.32, moonPhase: 0.84, moonColor: '#C7DCFF',
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
      starBrightness: 1,
      moonGlow: 0,
      sunX: 0.5,
      sunY: 0.28,
      sunRadius: 0,
      sunGlow: 0,
      sunIntensity: 0,
      sunAngularRadius: 1.2,
      sunColor: '#FFF8EA',
      cloudDensity: 0,
      cloudCoverage: 0.4,
      cloudDetail: 0.7,
      cloudBase: 54,
      cloudTop: 108,
      skySunX: 0.42, skySunY: 0.82, skySunZ: 0.38,
      skyTurbidity: 2.0, skyRayleigh: 1.95, skyMieCoefficient: 0.0042, skyMieDirectionalG: 0.8,
      skyExposure: 0.45, twilightStrength: 0,
      atmosphereSunColor: '#FFF8EA', moonDirectionX: 0, moonDirectionY: 1, moonDirectionZ: 0, moonIntensity: 0, moonPhase: 0.5,
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

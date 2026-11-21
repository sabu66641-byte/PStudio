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
      lightX: -0.48,
      lightY: -0.82,
      lightZ: -0.31,
      hemisphereSky: '#D9EEFF',
      hemisphereGround: '#68725C',
      hemisphereIntensity: 0.95,
      environmentIntensity: 0.8,
      sunX: 0.72,
      sunY: 0.29,
      sunRadius: 17,
      sunGlow: 0.55
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
      lightX: -0.78,
      lightY: -0.48,
      lightZ: -0.36,
      hemisphereSky: '#C5A0B8',
      hemisphereGround: '#43394D',
      hemisphereIntensity: 0.62,
      environmentIntensity: 0.58,
      sunX: 0.77,
      sunY: 0.43,
      sunRadius: 23,
      sunGlow: 0.9
    }),
    night: Object.freeze({
      label: '夜',
      skyTop: '#08152D',
      skyMid: '#20385D',
      horizon: '#52617C',
      ground: '#1C2638',
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
      sunRadius: 8,
      sunGlow: 0.16
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
      lightX: -0.62,
      lightY: -0.72,
      lightZ: -0.31,
      hemisphereSky: '#E1E9F2',
      hemisphereGround: '#46505D',
      hemisphereIntensity: 1.0,
      environmentIntensity: 1.05,
      sunX: 0.5,
      sunY: 0.28,
      sunRadius: 0,
      sunGlow: 0
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

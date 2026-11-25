const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const presets = require(path.join(root, 'static', 'pstudio_scene_environment.js'));
const environment = require(path.join(root, 'static', 'pstudio_rendering_environment.js'));
const renderer = fs.readFileSync(path.join(root, 'static/pstudio_3d_engine.js'), 'utf8');
const fx = fs.readFileSync(path.join(root, 'static/pstudio_environment_fx.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');

test('shared environment state normalizes all four scene presets without mutating presets', () => {
  for (const name of ['day', 'dusk', 'night', 'studio']) {
    const profile = presets.getPreset(name);
    const state = environment.resolvePStudioEnvironmentState(profile);
    assert.equal(state.name, name);
    assert.ok(Math.abs(Math.hypot(...state.sunDirection) - 1) < 1e-9);
    assert.ok(Math.abs(Math.hypot(...state.lightDirection) - 1) < 1e-9);
    assert.ok(state.cloudTop >= state.cloudBase + 1);
    for (const key of ['sunColor','skyTop','skyMid','skyHorizon','skyGround','environmentIntensity','sunIntensity','sunAngularRadius','starBrightness','moonColor','moonIntensity','fogColor','fogAmbientColor','waterReflectionTint','waterShallow','waterDeep','waterFoam']) {
      assert.ok(state[key], name + ':' + key);
    }
  }
});

test('environment state clamps invalid values and uses deterministic water color defaults', () => {
  const state = environment.resolvePStudioEnvironmentState({
    name:'dusk',
    lightX:NaN, lightY:0, lightZ:0,
    skySunX:0, skySunY:0, skySunZ:0,
    fogDensity:99, fogHeightFalloff:-1, fogAnisotropy:2,
    cloudDensity:-3, cloudCoverage:4, cloudDetail:2,
    cloudBase:100, cloudTop:20, cloudSteps:100,
    waterAbsorption:-5
  });
  assert.ok(Math.abs(Math.hypot(...state.sunDirection) - 1) < 1e-9);
  assert.ok(Math.abs(Math.hypot(...state.lightDirection) - 1) < 1e-9);
  assert.equal(state.fogDensity, 0.08);
  assert.equal(state.fogHeightFalloff, 0);
  assert.equal(state.fogAnisotropy, 0.88);
  assert.equal(state.cloudDensity, 0);
  assert.equal(state.cloudCoverage, 1);
  assert.equal(state.cloudDetail, 1);
  assert.equal(state.cloudBase, 100);
  assert.equal(state.cloudTop, 101);
  // Volumetric march steps are owned by the pass quality controller, not environment state.
  assert.equal(state.waterAbsorption, 0);
  assert.equal(state.environmentIntensity, 0.56);
  assert.equal(state.skyTop, presets.getPreset('dusk').skyTop);
  assert.ok(Math.abs(Math.hypot(...state.moonDirection)-1)<1e-9);
  assert.equal(state.waterReflectionTint, environment.waterDefaults.dusk.reflection);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.sunDirection));
});

test('renderer uses the shared environment normalizer and preserves its fallback path', () => {
  assert.match(renderer,/resolvePStudioEnvironmentState\?\.\(profile\)/);
  assert.ok(renderer.includes('window.PStudioEnvironmentFX?.configureAtmosphere?.(environmentState)'));
  assert.ok(renderer.includes('const atmosphericLightDirection='));
});

test('environment FX applies one state to water, clouds, volumetric fog and contact shadows', () => {
  for(const token of [
    'material?.userData?.pstudioWaterHQ',
    'settings.waterReflectionTint',
    'settings.waterAbsorption',
    'u.uCloudDensity',
    'u.uCloudCoverage',
    'u.uCloudDetail',
    'u.uCloudBase',
    'u.uCloudTop',
    'u.uCloudSteps',
    'u.uSunDirection',
    'u.uFogDensity',
    'u.uFogAnisotropy',
    'u.uLightDirectionWorld'
  ])assert.ok(fx.includes(token),token);
});

test('environment module loads before FX and the renderer consumes it through globals', () => {
  const envIndex=html.indexOf('pstudio_rendering_environment.js');
  const fxIndex=html.indexOf('pstudio_environment_fx.js');
  const rendererIndex=html.indexOf('pstudio_3d_engine.js');
  assert.ok(envIndex>=0&&fxIndex>envIndex&&rendererIndex>fxIndex);
  assert.ok(html.includes('pstudio_rendering_environment.js?v=20261125-tsl-ibl-state-v2'));
});


test('shared environment state keeps visual sky, sun, moon and PBR IBL parameters coherent', () => {
  for (const name of ['day','dusk','night','studio']) {
    const profile = presets.getPreset(name);
    const state = environment.resolvePStudioEnvironmentState(profile);
    assert.equal(state.skyTop,profile.skyTop);
    assert.equal(state.skyMid,profile.skyMid);
    assert.equal(state.skyHorizon,profile.horizon);
    assert.equal(state.skyGround,profile.ground);
    assert.equal(state.environmentIntensity,profile.environmentIntensity);
    assert.equal(state.sunIntensity,profile.sunIntensity);
    assert.equal(state.sunAngularRadius,profile.sunAngularRadius);
    assert.ok(Math.abs(Math.hypot(...state.moonDirection)-1)<1e-9);
  }
});

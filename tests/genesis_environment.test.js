const test = require('node:test');
const assert = require('node:assert/strict');
const presets = require('../static/pstudio_scene_environment.js');
const genesis = require('../static/pstudio_genesis_environment.js');

test('GENESIS time model interpolates day, golden dusk and night continuously', () => {
  const noon = genesis.profileForTime(12);
  const beforeDusk = genesis.profileForTime(17.1);
  const dusk = genesis.profileForTime(18.2);
  const afterDusk = genesis.profileForTime(20.5);

  assert.equal(beforeDusk.visualPreset, 'day');
  assert.equal(dusk.visualPreset, 'dusk');
  assert.equal(afterDusk.visualPreset, 'night');
  assert.ok(dusk.sunIntensity < presets.getPreset('day').sunIntensity);
  assert.ok(dusk.environmentIntensity > presets.getPreset('night').environmentIntensity);
  assert.ok(Math.hypot(dusk.skySunX, dusk.skySunY, dusk.skySunZ) > 0.999);
  assert.ok(Math.hypot(dusk.moonDirectionX, dusk.moonDirectionY, dusk.moonDirectionZ) > 0.999);
  assert.ok(dusk.skyTop !== presets.getPreset('day').skyTop);
  assert.equal(noon.starBrightness, 0, 'midday must not show night stars');
  assert.equal(noon.moonIntensity, 0, 'midday must not show the moon');
  assert.equal(beforeDusk.starBrightness, 0, 'daytime must not leak a visible night starfield');
  assert.ok(dusk.starBrightness >= 0 && dusk.starBrightness <= 1.62, 'twilight star brightness stays bounded');
  assert.ok(afterDusk.starBrightness > 1.45, 'late twilight/night must reveal the dense starfield');
  assert.ok(Number.isFinite(dusk.starBrightness));
});

test('GENESIS named presets apply immediately and keep the moon fixed without an automatic clock',()=>{
  const controller=genesis.createGenesisEnvironmentController({timeOfDay:12,timeScale:0});
  assert.equal(controller.getConfig().transitionSeconds,2.4);
  const night=controller.setImmediate({preset:'night',timeScale:.25});
  assert.equal(night.timeOfDay,23);
  assert.equal(night.visualPreset,'night');
  assert.equal(night.timeScale,0);
  assert.ok(night.moonIntensity>0);
  const next=controller.update(.1);
  assert.equal(next.timeOfDay,23);
  assert.equal(next.moonDirectionX,night.moonDirectionX);
  assert.equal(next.moonDirectionY,night.moonDirectionY);
  assert.equal(next.moonDirectionZ,night.moonDirectionZ);
});

test('GENESIS time controller eases toward target time without a one-frame jump', () => {
  const controller = genesis.createGenesisEnvironmentController({
    timeOfDay: 12,
    timeScale: 0,
    transitionSeconds: 0.6
  });
  const initial = controller.getState();
  controller.set({ timeOfDay: 19 });
  const first = controller.update(0.1);
  assert.ok(first.timeOfDay > initial.timeOfDay);
  assert.ok(first.timeOfDay < 19);
  let latest = first;
  for (let i = 0; i < 50; i += 1) latest = controller.update(0.1);
  assert.ok(Math.abs(latest.timeOfDay - 19) < 0.08);
  assert.equal(latest.visualPreset, 'dusk');
  assert.equal(latest.name, 'dusk');
});

test('GENESIS controller wraps across midnight by the shortest direction', () => {
  const controller = genesis.createGenesisEnvironmentController({
    timeOfDay: 23.5,
    transitionSeconds: 0.3
  });
  controller.set({ timeOfDay: 0.5 });
  const next = controller.update(0.1);
  assert.ok(next.timeOfDay < 24 && next.timeOfDay >= 23.5);
  let state = next;
  for (let i = 0; i < 120; i += 1) state = controller.update(0.1);
  assert.ok(state.timeOfDay < 0.6 || state.timeOfDay > 23.9);
});

test('rain transitions feed precipitation, wetness, wind and wave intensity from one state', () => {
  const controller = genesis.createGenesisEnvironmentController({
    timeOfDay: 13,
    weather: 'clear',
    windSpeed: 0.2,
    transitionSeconds: 0.45,
    windTransitionSeconds: 0.45
  });
  const clear = controller.getState();
  controller.set({
    weather: 'rain',
    windDirection: [0, 1],
    windSpeed: 1.5
  });
  let rain = clear;
  for (let i = 0; i < 50; i += 1) rain = controller.update(0.1);

  assert.ok(rain.rainIntensity > 0.85);
  assert.ok(rain.wetness > 0.7);
  assert.ok(rain.precipitationRate > 90);
  assert.ok(rain.windSpeed > clear.windSpeed);
  assert.ok(rain.waterWaveAmplitude > clear.waterWaveAmplitude);
  assert.ok(rain.waterRippleStrength > 0.75);
  assert.ok(Math.abs(rain.windDirection[0]) < 0.001);
  assert.ok(rain.windDirection[1] > 0.999);
  assert.equal(rain.weatherName, 'rain');
  assert.equal(rain.visualPreset, 'day');
});

test('GENESIS controller clamps unsafe parameters and ignores unknown weather labels', () => {
  const controller = genesis.createGenesisEnvironmentController({
    timeOfDay: 48,
    weather: 'not-a-weather',
    windSpeed: 100,
    windDirection: [0, 0]
  });
  const initial = controller.getState();
  assert.ok(initial.timeOfDay >= 0 && initial.timeOfDay < 24);
  assert.equal(initial.weatherName, 'clear');
  assert.ok(initial.windSpeed <= 12);
  assert.ok(initial.windDirection.every(Number.isFinite));
  controller.set({
    weather: 'storm',
    weatherIntensity: 3,
    windSpeed: -4,
    windDirectionDegrees: 270
  });
  let state = initial;
  for (let i = 0; i < 40; i += 1) state = controller.update(0.1);
  assert.equal(state.weatherName, 'storm');
  assert.ok(state.weather.intensity > 0.8, 'weather intensity eases smoothly instead of snapping to the target');
  assert.ok(state.windSpeed >= 0 && state.windSpeed <= 12);
  assert.ok(state.windDirection.every(Number.isFinite));
});

test('GENESIS sky panorama generation is deterministic and has correct RGBA dimensions', () => {
  const controller = genesis.createGenesisEnvironmentController({
    timeOfDay: 23,
    weather: 'clear'
  });
  const state = controller.getState();
  const a = genesis.composeSkyPixels(state, 96, 48);
  const b = genesis.composeSkyPixels(state, 96, 48);
  assert.equal(a.width, 96);
  assert.equal(a.height, 48);
  assert.equal(a.data.length, 96 * 48 * 4);
  assert.deepEqual(a.data, b.data);
  assert.ok(a.data.some((value, index) => index % 4 === 3 && value === 255));
});


test('wind direction reversals follow a continuous shortest angular path', () => {
  const controller = genesis.createGenesisEnvironmentController({
    timeOfDay: 12,
    windDirection: [1, 0],
    windSpeed: 1,
    windTransitionSeconds: 0.7
  });
  controller.set({ windDirection: [-1, 0] });
  let previous = controller.getState().windDirection;
  for (let i = 0; i < 120; i += 1) {
    const current = controller.update(0.05).windDirection;
    const dot = previous[0] * current[0] + previous[1] * current[1];
    assert.ok(dot > 0.9, 'wind direction must not flip between adjacent frames');
    assert.ok(current.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...current) - 1) < 0.001);
    previous = current;
  }
  assert.ok(previous[0] < -0.999);
  assert.ok(Math.abs(previous[1]) < 0.001);
});

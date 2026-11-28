const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'static', 'pstudio_engine.js'), 'utf8');
const ecsTime = fs.readFileSync(path.join(root, 'static', 'pstudio_ecs_time.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'static', 'pstudio_3d_engine.js'), 'utf8');
const fxSource = fs.readFileSync(path.join(root, 'static', 'pstudio_environment_fx.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const architecture = fs.readFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');

test('cinematic APIs are game-only AST built-ins with strict arity', () => {
  for (const [name, arity] of [
    ['camera_shake', 2], ['set_time_scale', 1],
    ['draw_trail', 4], ['set_god_rays', 2]
  ]) assert.match(app, new RegExp('"' + name + '": ' + arity));
  assert.match(app, /game_functions = GAME_FUNCTIONS if allow_game else \{\}/);
  assert.match(app, /known_calls = \(set\(BUILTIN_FUNCTIONS\) - \{"input"\}\) \| set\(functions\) \| set\(game_functions\)/);
  assert.match(runtime, /case 'camera_shake': if\(a\.length===2\)/);
  assert.match(runtime, /case 'set_time_scale': if\(a\.length===1\)/);
  assert.match(runtime, /case 'draw_trail': if\(a\.length===4\)/);
  assert.match(runtime, /case 'set_god_rays': if\(a\.length===2\)/);
});

test('time scale is owned by ECS TimeState while preserving the browser simulation delta contract', () => {
  assert.equal(runtime.includes('runtime.timeScale'), false);
  assert.ok(runtime.includes('window.PStudioECSTime.setTimeScale(a[0])'));
  assert.ok(runtime.includes('window.PStudioECSTime.beginFrame(raw)'));
  assert.ok(runtime.includes('window.PStudioECSTime.start()'));
  assert.ok(runtime.includes('window.PStudioECSTime?.clear?.()'));
  assert.ok(ecsTime.includes('timeScale: 1'));
  assert.ok(ecsTime.includes('MAX_TIME_SCALE = 4'));
  assert.ok(ecsTime.includes('MAX_DELTA_TIME = 0.1'));
  assert.ok(ecsTime.includes('Math.min(MAX_DELTA_TIME, raw * state.timeScale)'));
  assert.match(runtime, /requires3D:needs3D/);
  assert.match(runtime, /runtime\?\.requires3D\|\|has3D/);
  assert.match(renderer, /frameDelta=Number\.isFinite\(value\)\?Math\.max\(0,Math\.min\(0\.1,value\)\):1\/60/);
});
test('camera shake is transient and restores the authored camera transform after each draw', () => {
  assert.match(runtime, /window\.PStudio3D\?\.cameraShake\?\.\(intensity,duration\)/);
  assert.match(renderer, /function triggerCameraShake\(intensity,duration\)/);
  assert.match(renderer, /function applyCameraShake\(\)/);
  assert.match(renderer, /const cameraPositionBefore=camera\.position\.clone\(\),cameraQuaternionBefore=camera\.quaternion\.clone\(\)/);
  assert.match(renderer, /camera\.position\.copy\(cameraPositionBefore\);camera\.quaternion\.copy\(cameraQuaternionBefore\)/);
});

test('trail ribbons are bounded, updated from world-space samples, and disposed', () => {
  assert.match(runtime, /target=\(sceneObjects\|\|\[\]\)\.find\(item=>String\(item\.id\)===targetKey\|\|String\(item\.name\)===targetKey\)/);
  assert.match(renderer, /const MAX_TRAIL_POINTS=48/);
  assert.match(renderer, /const MAX_TRAIL_EFFECTS=64/);
  assert.match(renderer, /function updateTrailEffect\(key,command\)/);
  assert.match(renderer, /function disposeTrailEffect\(trail\)/);
  assert.match(renderer, /if\(trailEffects\.size>=MAX_TRAIL_EFFECTS\)/);
  assert.match(renderer, /if\(d\.type==='trail'\)\{updateTrailEffect/);
  assert.match(renderer, /trailEffects\.clear\(\)/);
});

test('God Rays shader pass is created with fixed sampling and linear intermediate output', () => {
  class Vector2 { constructor(x, y) { this.x = x; this.y = y; } }
  class ShaderPass {
    constructor(shader) { this.uniforms = shader.uniforms; this.shader = shader; this.enabled = true; }
  }
  const window = { THREE: { Vector2 } };
  vm.runInNewContext(fxSource, { window, console, Math, Set, Map });
  const pass = window.PStudioEnvironmentFX.createGodRaysPass({ ShaderPass }, { Vector2 });
  assert.ok(pass);
  assert.equal(pass.enabled, false);
  assert.ok(pass.uniforms.uIntensity);
  assert.ok(pass.uniforms.uLightPosition);
  assert.match(pass.shader.fragmentShader, /for\(int i=0;i<20;i\+\+\)/);
  assert.ok(pass.shader.fragmentShader.includes('void main()'));
  assert.equal(pass.shader.fragmentShader.includes('tonemapping_fragment'), false);
  assert.equal(typeof window.PStudioEnvironmentFX.createGodRaysPass, 'function');
});

test('God Rays uses the active light, precedes OutputPass, and safely falls back to Bloom', () => {
  assert.match(renderer, /createGodRaysPass\?\.\(FX,T\)/);
  assert.ok(renderer.indexOf('createGodRaysPass?.(FX,T)') < renderer.indexOf('new FX.OutputPass()'));
  assert.match(renderer, /const sunDirection=keyLight\?\.position/);
  assert.match(renderer, /godRaysFallbackEnabled=!!bloomPass/);
  assert.match(renderer, /God Rays shader is unsupported; switching to bloom fallback/);
  assert.match(renderer, /setGodRays:\(enabled,intensity=1\)/);
});

test('the Scene API help and technical docs describe all four cinematic calls', () => {
  for (const name of ['camera_shake', 'set_time_scale', 'draw_trail', 'set_god_rays']) {
    assert.ok(html.includes(name), name + ' in Inspector API help');
    assert.ok(readme.includes(name), name + ' in README');
    assert.ok(architecture.includes(name), name + ' in architecture guide');
  }
  assert.match(html, /pstudio_engine\.js\?v=20261125-daylight-mirror-hq-r2/);
  assert.match(html, /pstudio_3d_engine\.js\?v=20261128-pvcs-foundation-v1/);
  assert.match(html, /pstudio_environment_fx\.js\?v=20261126-natural-clouds-v2/);
});

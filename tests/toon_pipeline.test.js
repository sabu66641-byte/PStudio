const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const fxSource = fs.readFileSync(path.join(root, 'static', 'pstudio_environment_fx.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'static', 'pstudio_3d_engine.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'static', 'pstudio_engine.js'), 'utf8');\nconst materials = fs.readFileSync(path.join(root, 'static', 'pstudio_ecs_materials.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('toon controls persist as ECS Components and are forwarded to the renderer', () => {
  for (const id of [
    'obj-model-toon-enabled', 'obj-model-toon-shadow', 'obj-model-toon-mid',
    'obj-model-toon-highlight', 'obj-model-toon-rim-color', 'obj-model-toon-outline-color',
    'obj-model-toon-sss-color', 'obj-model-wind-strength', 'obj-model-wind-speed'
  ]) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /const toon=\\{enabled:!!document\\.getElementById\\('obj-model-toon-enabled'\\)/);
  assert.match(html, /setSceneToonMaterial\\(o,toon\\)/);
  assert.match(materials, /type: 'toon_material', toon: clone\\(settings\\)/);
  assert.match(materials, /type: 'model_material'/);
  assert.match(renderer, /toon:d\\.toon&&typeof d\\.toon==='object'\\?d\\.toon:null/);
  assert.match(renderer, /configureToon\\?\\.\\(material,toonSettings,object\\)/);
});

test('shared Inspector NPR settings apply through ECS and wind-only stays on PBR', () => {
  assert.ok(html.includes('id="obj-toon-controls"'));
  assert.ok(html.includes('applySelectedToonMaterial()'));
  assert.match(html, /setSceneToonMaterial\\(o,toon\\)/);
  assert.match(materials, /TYPES\\.ToonMaterial/);
  assert.match(materials, /function setToonMaterial/);
  assert.match(materials, /function collectCommands/);
  assert.match(renderer, /shader:toon\\.enabled===false\\?/);
  assert.match(renderer, /primitiveToon&&primitiveToon\\.enabled!==false/);
  assert.match(renderer, /hasOwnProperty\\.call\\(primitiveToon,'windStrength'\\)/);
  assert.match(renderer, /hasOwnProperty\\.call\\(toonSettings,'windStrength'\\)/);
});

test('PBR remains the default, while toon mode uses a standard material with the additive FX pipeline', () => {
  assert.match(renderer, /shaderMode=ownerMaterial\?\.shader\|\|'standard'/);
  assert.match(renderer, /shaderMode==='toon'\)material=new T\.MeshStandardMaterial/);
  assert.match(fxSource, /reflectedLight\.directDiffuse\*=pStudioToonRamp/);
  assert.ok(fxSource.includes('#if !defined(USE_ENVMAP) && !defined(USE_SKINNING)'));
  assert.match(fxSource, /attribute vec3 normal/);
  assert.match(renderer, /setupLightingMaterial\(material\)/);
  assert.match(renderer, /setupClusteredLightingMaterial\(material\)/);
  assert.match(readme, /set_toon_material\(/);
});

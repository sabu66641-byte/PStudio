const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const fxSource = fs.readFileSync(path.join(root, 'static', 'pstudio_environment_fx.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'static', 'pstudio_3d_engine.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'static', 'pstudio_engine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

function createFX() {
  class Color {
    constructor(value) { this.set(value); }
    set(value) { this.value = String(value); return this; }
  }
  class Vector2 {
    constructor(x, y) { this.x = x; this.y = y; }
    normalize() {
      const length = Math.hypot(this.x, this.y) || 1;
      this.x /= length; this.y /= length;
      return this;
    }
  }
  const window = { THREE: { Color, Vector2, DoubleSide: 2 } };
  vm.runInNewContext(fxSource, { window, console, Math, Set, Map });
  return window.PStudioEnvironmentFX;
}

test('game API registry validates set_toon_material as a 14-argument browser-only builtin', () => {
  assert.match(app, /"set_toon_material": 14/);
  assert.match(runtime, /case 'set_toon_material': if\(a\.length===14\)/);
  assert.match(runtime, /set_toon_material\|set_background/);
  assert.match(runtime, /type:'toon_material',toon:/);
  assert.match(renderer, /d\.type==='toon_material'/);
});

test('NPR shader chains existing PBR hooks and adds three-band, rim, outline and pseudo-SSS controls', () => {
  const fx = createFX();
  assert.equal(typeof fx.configureToon, 'function');
  const material = {
    isMeshStandardMaterial: true,
    userData: {},
    onBeforeCompile(shader) { shader.fragmentShader += '\\n// retained PBR hook'; },
    customProgramCacheKey() { return 'existing-pbr-key'; }
  };
  fx.configureToon(material, {
    enabled: true,
    shadowColor: '#101820',
    midColor: '#507090',
    highlightColor: '#f0f0ff',
    shadowThreshold: 0.28,
    highlightThreshold: 0.72,
    rimColor: '#aaddff',
    rimIntensity: 0.8,
    rimPower: 3.1,
    outlineColor: '#081018',
    outlineWidth: 0.16,
    sssColor: '#ee9988',
    sssIntensity: 0.2
  });
  const shader = {
    uniforms: {},
    fragmentShader: '#include <common>\\n#include <lights_fragment_end>\\n#include <opaque_fragment>'
  };
  material.onBeforeCompile(shader, {});
  for (const name of [
    'uPStudioToonEnabled', 'uPStudioToonShadowColor', 'uPStudioToonMidColor',
    'uPStudioToonHighlightColor', 'uPStudioToonRimColor', 'uPStudioToonOutlineColor',
    'uPStudioToonSSSColor'
  ]) assert.ok(shader.uniforms[name], name);
  for (const token of [
    'smoothstep(uPStudioToonShadowThreshold',
    'uPStudioToonHighlightThreshold',
    'pStudioToonRim',
    'pStudioToonSubsurface',
    'pStudioInkEdge',
    'retained PBR hook'
  ]) assert.ok(shader.fragmentShader.includes(token), token);
  assert.match(material.customProgramCacheKey(), /pstudio-npr-toon-v1/);
  assert.equal(material.userData.pstudioToonHQ.uniforms.enabled.value, 1);

  fx.configureToon(material, { enabled: false });
  assert.equal(material.userData.pstudioToonHQ.uniforms.enabled.value, 0);
});

test('foliage wind speed and strength are shader uniforms, not CPU vertex rewrites', () => {
  const fx = createFX();
  const material = {
    isMeshStandardMaterial: true,
    userData: {},
    onBeforeCompile(shader) { shader.fragmentShader += '\\n// pbr'; },
    customProgramCacheKey() { return 'base'; }
  };
  const object = {
    userData: { pstudioWindPart: 'leaf' },
    geometry: {
      boundingBox: { min: { y: 0 }, max: { y: 8 } },
      computeBoundingBox() {}
    }
  };
  fx.configureFoliage(material, object, { windStrength: 1.25, windSpeed: 1.8 });
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\\n#include <begin_vertex>\\n',
    fragmentShader: ''
  };
  material.onBeforeCompile(shader, {});
  assert.ok(shader.uniforms.uPStudioWindStrength);
  assert.ok(shader.uniforms.uPStudioWindSpeed);
  assert.equal(shader.uniforms.uPStudioWindStrength.value, 1.25);
  assert.equal(shader.uniforms.uPStudioWindSpeed.value, 1.8);
  assert.ok(shader.vertexShader.includes('uPStudioWindTime*uPStudioWindSpeed'));
  assert.ok(shader.vertexShader.includes('transformed.x+=sway'));
  assert.equal(material.userData.pstudioFoliageHQ.role, 'leaf');
});

test('toon controls persist as per-model overrides and are forwarded to the renderer', () => {
  for (const id of [
    'obj-model-toon-enabled', 'obj-model-toon-shadow', 'obj-model-toon-mid',
    'obj-model-toon-highlight', 'obj-model-toon-rim-color', 'obj-model-toon-outline-color',
    'obj-model-toon-sss-color', 'obj-model-wind-strength', 'obj-model-wind-speed'
  ]) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /toon\s*:\s*\{enabled:!!document\.getElementById\('obj-model-toon-enabled'\)/);
  assert.match(html, /toon:rawToon\?\{/);
  assert.match(runtime, /toon:override\.toon/);
  assert.match(renderer, /toon:d\.toon&&typeof d\.toon==='object'\?d\.toon:null/);
  assert.match(renderer, /configureToon\?\.\(material,toonSettings,object\)/);
});

test('PBR remains the default, while toon mode uses a standard material with the additive FX pipeline', () => {
  assert.match(renderer, /shaderMode=ownerMaterial\?\.shader\|\|'standard'/);
  assert.match(renderer, /shaderMode==='toon'\)material=new T\.MeshStandardMaterial/);
  assert.match(renderer, /reflectedLight\.directDiffuse\*=mix/);
  assert.match(renderer, /setupLightingMaterial\(material\)/);
  assert.match(renderer, /setupClusteredLightingMaterial\(material\)/);
  assert.match(readme, /set_toon_material\(/);
});

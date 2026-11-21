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

function createFXMeshClass() {
  return class Mesh {
    constructor(geometry, material) {
      this.isMesh = true; this.geometry = geometry; this.material = material;
      this.userData = {}; this.children = []; this.renderOrder = 0; this.frustumCulled = true;
      this.position = { set() {} }; this.quaternion = { set() {} }; this.scale = { set() {} };
    }
    add(child) { child.parent = this; this.children.push(child); }
    remove(child) { this.children = this.children.filter(item => item !== child); child.parent = null; }
  };
}

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
  class MeshBasicMaterial {
    constructor(options) { Object.assign(this, options); this.userData = {}; }
    dispose() { this.disposed = true; }
  }
  class Mesh {
    constructor(geometry, material) {
      this.isMesh = true; this.geometry = geometry; this.material = material;
      this.userData = {}; this.children = []; this.renderOrder = 0; this.frustumCulled = true;
      this.position = { set() {} }; this.quaternion = { set() {} }; this.scale = { set() {} };
    }
    add(child) { child.parent = this; this.children.push(child); }
    remove(child) { this.children = this.children.filter(item => item !== child); child.parent = null; }
  }
  class SkinnedMesh extends Mesh {
    constructor(g, m) { super(g, m); this.isSkinnedMesh = true; }
    bind(skeleton, matrix) { this.skeleton = skeleton; this.bindMatrix = matrix; }
  }
  const window = { THREE: { Color, Vector2, MeshBasicMaterial, Mesh, SkinnedMesh, BackSide: 1, DoubleSide: 2 } };
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
    onBeforeCompile(shader) { shader.fragmentShader += '\n// retained PBR hook'; },
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
    fragmentShader: '#include <common>\n#include <lights_fragment_end>\n#include <opaque_fragment>'
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
    'retained PBR hook'
  ]) assert.ok(shader.fragmentShader.includes(token), token);
  assert.match(material.customProgramCacheKey(), /pstudio-npr-toon-v1/);
  assert.equal(material.userData.pstudioToonHQ.uniforms.enabled.value, 1);

  fx.configureToon(material, { enabled: false });
  assert.equal(material.userData.pstudioToonHQ.uniforms.enabled.value, 0);
});

test('outline is an expanded back-face shell and is released with its source object', () => {
  const fx = createFX();
  const material = { isMeshStandardMaterial: true, userData: {}, alphaTest: 0.5, map: { uuid: 'base-color' }, alphaMap: { uuid: 'alpha-mask' }, customProgramCacheKey() { return 'pbr'; } };
  const SourceMesh = createFXMeshClass();
  const source = new SourceMesh({}, material);
  fx.configureToon(material, { enabled: true, outlineColor: '#102030', outlineWidth: 0.14 }, source);
  assert.equal(source.children.length, 1);
  const shell = source.children[0];
  assert.equal(shell.material.side, 1);
  assert.equal(shell.material.alphaTest, 0.5);
  assert.equal(shell.material.map, material.map);
  assert.equal(shell.material.alphaMap, material.alphaMap);
  assert.equal(shell.castShadow, false);
  assert.equal(shell.receiveShadow, false);
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n#include <skinning_vertex>\n', fragmentShader: '#include <color_fragment>\n' };
  shell.material.onBeforeCompile(shader, {});
  assert.ok(shader.vertexShader.includes('uPStudioOutlineExpansion'));
  assert.ok(shader.vertexShader.includes('normalize(objectNormal)*uPStudioOutlineExpansion'));
  assert.ok(shader.fragmentShader.includes('diffuseColor.rgb=vec3(1.0);'));
  assert.ok(fxSource.includes("#include <skinning_vertex>"));
  fx.releaseObject(source);
  assert.equal(source.children.length, 0);
});

test('foliage wind speed and strength are shader uniforms, not CPU vertex rewrites', () => {
  const fx = createFX();
  const material = {
    isMeshStandardMaterial: true,
    userData: {},
    onBeforeCompile(shader) { shader.fragmentShader += '\n// pbr'; },
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
    vertexShader: '#include <common>\n#include <begin_vertex>\n',
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
  fx.configureFoliage(material, object, { windStrength: 0, windSpeed: 1 });
  assert.equal(shader.uniforms.uPStudioWindStrength.value, 0);
  assert.equal(shader.uniforms.uPStudioWindSpeed.value, 1);
});

test('toon controls persist as per-model overrides and are forwarded to the renderer', () => {
  for (const id of [
    'obj-model-toon-enabled', 'obj-model-toon-shadow', 'obj-model-toon-mid',
    'obj-model-toon-highlight', 'obj-model-toon-rim-color', 'obj-model-toon-outline-color',
    'obj-model-toon-sss-color', 'obj-model-wind-strength', 'obj-model-wind-speed'
  ]) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /const toon=\{enabled:!!document\.getElementById\('obj-model-toon-enabled'\)/);
  assert.match(html, /const toon=rawToon\?\{/);
  assert.match(runtime, /toon:override\.toon/);
  assert.match(renderer, /toon:d\.toon&&typeof d\.toon==='object'\?d\.toon:null/);
  assert.match(renderer, /configureToon\?\.\(material,toonSettings,object\)/);
});

test('shared Inspector NPR settings apply to primitive script owners and wind-only stays on PBR', () => {
  assert.ok(html.includes('id="obj-toon-controls"'));
  assert.ok(html.includes('applySelectedToonMaterial()'));
  assert.match(html, /o\.toonMaterialSettings=toon/);
  assert.match(html, /sourceObjectToon=item\.toonMaterialSettings/);
  assert.match(html, /restored\.toonMaterialSettings=\{/);
  assert.match(runtime, /type:'toon_material',toon:o\.toonMaterialSettings/);
  assert.match(renderer, /shader:toon\.enabled===false\?/);
  assert.match(renderer, /primitiveToon&&primitiveToon\.enabled!==false/);
  assert.match(renderer, /hasOwnProperty\.call\(primitiveToon,'windStrength'\)/);
  assert.match(renderer, /hasOwnProperty\.call\(toonSettings,'windStrength'\)/);
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

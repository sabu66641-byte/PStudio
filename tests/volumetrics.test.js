const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const fxSource = fs.readFileSync(path.join(root, 'static', 'pstudio_environment_fx.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'static', 'pstudio_3d_engine.js'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'static', 'pstudio_engine.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

function loadEnvironmentFx() {
  class Vector2 {
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    set(x, y) { this.x = x; this.y = y; return this; }
  }
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    normalize() {
      const length = Math.hypot(this.x, this.y, this.z) || 1;
      this.x /= length; this.y /= length; this.z /= length;
      return this;
    }
  }
  class Matrix4 {}
  class Color {
    constructor(value) { this.value = value; }
    set(value) { this.value = value; return this; }
  }
  class Scene {
    constructor() { this.children = []; }
    add(object) { this.children.push(object); }
  }
  class OrthographicCamera {}
  class PlaneGeometry {
    constructor(width, height) { this.width = width; this.height = height; }
    dispose() { this.disposed = true; }
  }
  class ShaderMaterial {
    constructor(options) { Object.assign(this, options); }
    dispose() { this.disposed = true; }
  }
  class Mesh {
    constructor(geometry, material) { this.geometry = geometry; this.material = material; }
  }
  class WebGLRenderTarget {
    constructor(width, height, options) {
      this.width = width; this.height = height; this.options = options;
      this.texture = { target: this };
    }
    setSize(width, height) { this.width = width; this.height = height; }
    dispose() { this.disposed = true; }
  }
  class DepthTexture {}
  const Three = {
    Vector2, Vector3, Matrix4, Color, Scene, OrthographicCamera, PlaneGeometry,
    ShaderMaterial, Mesh, WebGLRenderTarget, DepthTexture,
    RGBAFormat: 1, LinearFilter: 2
  };
  const window = { THREE: Three };
  vm.runInNewContext(fxSource, { window, console, Math, Number, Object, Set, Map });
  return { fx: window.PStudioEnvironmentFX, Three };
}

test('volumetric fog uses a height-decaying medium, physical sun direction and bounded march steps', () => {
  assert.ok(fxSource.includes('uHeightFalloff'));
  assert.ok(fxSource.includes('exp(-h*uHeightFalloff)'));
  assert.ok(fxSource.includes('uniform float uSteps'));
  assert.ok(fxSource.includes('const int MAX_STEPS=24'));
  assert.ok(fxSource.includes('uSunDirection'));
  assert.ok(fxSource.includes('pow(cosTheta,8.0)'));
});

test('god rays use thresholded radial samples with configurable decay and sample count', () => {
  assert.ok(fxSource.includes('uniform float uDecay'));
  assert.ok(fxSource.includes('uniform float uSamples'));
  assert.ok(fxSource.includes('for(int i=0;i<32;i++)'));
  assert.ok(fxSource.includes('smoothstep(uThreshold,uThreshold+.38,luminance)'));
  assert.ok(fxSource.includes('illuminationDecay*=uDecay'));
});

test('scaled fog and god-ray passes render to a reduced target and composite back to full resolution', () => {
  const { fx, Three } = loadEnvironmentFx();
  const shaderPass = function ShaderPass() {};
  const rays = fx.createGodRaysPass({ ShaderPass: shaderPass }, Three);
  const fog = fx.createVolumetricFogPass({ ShaderPass: shaderPass }, Three);
  assert.ok(rays);
  assert.ok(fog);

  for (const pass of [rays, fog]) {
    pass.setSize(1280, 720);
    pass.setResolutionScale(0.5);
    assert.deepEqual(
      { width: pass.getTargetSize().width, height: pass.getTargetSize().height },
      { width: 640, height: 360 }
    );
    assert.equal(pass.needsSwap, true);
    assert.equal(pass.enabled, false);
  }

  const calls = [];
  const rendererMock = {
    autoClear: false,
    setRenderTarget(target) { calls.push({ type: 'target', target }); },
    render(scene, camera) { calls.push({ type: 'render', scene, camera }); }
  };
  const sourceTexture = { id: 'source-color' };
  const depthTexture = { id: 'scene-depth' };
  const readBuffer = { texture: sourceTexture, depthTexture };
  const writeBuffer = { id: 'composer-write-buffer' };
  fog.uniforms.tDepth.value = depthTexture;
  fog.render(rendererMock, writeBuffer, readBuffer);
  assert.equal(rendererMock.autoClear, false, 'renderer state must be restored');
  assert.equal(calls.filter(call => call.type === 'render').length, 2, 'low-res effect + full-res composite');
  assert.equal(calls[0].target, fogTarget(calls[0].target), 'first render targets an offscreen buffer');
  assert.equal(calls[1].target, writeBuffer, 'second render writes to EffectComposer buffer');
  assert.equal(fog.uniforms.tDiffuse.value, sourceTexture);
  assert.equal(fog.uniforms.tDepth.value, depthTexture);

  rays.setSamples(20);
  assert.equal(rays.uniforms.uSamples.value, 20);
  assert.equal(rays.getStats().resolutionScale, 0.5);
  assert.equal(fog.setStepCount(18), 18);
  assert.equal(fog.getStats().steps, 18);
  rays.dispose();
  fog.dispose();
});

function fogTarget(target) {
  return !!target && typeof target === 'object' && target.texture?.target === target;
}

test('quality tiers gate expensive volumetrics and progressively scale resolution and samples', () => {
  for (const [name, fogScale, fogSteps, rayScale, samples] of [
    ['mobile', '.25', '4', '.25', '4'],
    ['balanced', '.42', '8', '.38', '8'],
    ['high', '.66', '14', '.62', '18'],
    ['ultra', '1', '24', '1', '32']
  ]) {
    const line = renderer.split('\n').find(item => item.trim().startsWith(name + ':{fog:'));
    assert.ok(line, name + ' volumetric quality profile');
    for (const token of [fogScale, fogSteps, rayScale, samples]) assert.ok(line.includes(token), name + ': ' + token);
  }
  assert.ok(renderer.includes('applyVolumetricQuality(selected,adaptiveQualityLevel)'));
  assert.ok(renderer.includes('applyVolumetricQuality(resolveQualityPreset(\'auto\'),adaptiveQualityLevel)'));
  assert.ok(renderer.includes('qualityLevel>0&&!memorySafetyApplied&&deviceMemoryGiB()>2'));
  assert.ok(renderer.includes('setResolutionScale?.(profile.fogScale*scaleFactor)'));
  assert.ok(renderer.includes('setResolutionScale?.(profile.rayScale*scaleFactor)'));
});

test('volumetric fog follows the same physical sun vector and scene depth as the atmospheric sky', () => {
  assert.ok(renderer.includes('window.PStudioAtmosphere?.sunDirection?.(atmosphereSettings)'));
  assert.ok(renderer.includes('u.uSunDirection.value.set(Number(sun[0])||0,Number(sun[1])||1,Number(sun[2])||0).normalize()'));
  assert.ok(renderer.includes('u.tDepth.value=waterDepthTarget?.depthTexture||null'));
  assert.ok(renderer.includes('const aboveHorizon=sunDirection.y>0.005'));
  assert.ok(renderer.includes('const inFront=cameraForward.dot(sunDirection)>0.015'));
  assert.ok(renderer.includes('const depthVisible=sunScreen.z>=-1&&sunScreen.z<=1'));
});

test('set_god_rays exposes decay while preserving existing two-argument ps scripts', () => {
  assert.ok(app.includes('"set_god_rays": (2, 3)'));
  assert.ok(engine.includes("case 'set_god_rays': if(a.length===2||a.length===3)"));
  assert.ok(engine.includes('const decay=a.length===3?Math.max(.8,Math.min(.995,finite(a[2]))):.965'));
  assert.ok(engine.includes('setGodRays?.(enabled,intensity,decay)'));
  assert.ok(renderer.includes('setGodRays:(enabled,intensity=1,decay=.965)=>'));
  assert.ok(renderer.includes('godRaysDecay=Math.max(.8,Math.min(.995'));
  assert.ok(readme.includes('set_god_rays(enabled, intensity, decay)'));
});

test('god-ray diagnostics expose the active quality budget and the fog manual override remains bounded', () => {
  assert.ok(renderer.includes('resolutionScale:godRaysPass?.getResolutionScale?.()||0'));
  assert.ok(renderer.includes('samples:godRaysPass?.uniforms?.uSamples?.value||0'));
  assert.ok(renderer.includes('resolutionScale:volumetricFogPass?.getResolutionScale?.()||0'));
  assert.ok(renderer.includes('steps:volumetricFogPass?.uniforms?.uSteps?.value||0'));
  assert.ok(renderer.includes('manualOverride:volumetricFogManualOverride'));
});

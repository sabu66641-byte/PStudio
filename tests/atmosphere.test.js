const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const atmosphere = require(path.join(root, 'static', 'pstudio_atmosphere.js'));
const renderer = fs.readFileSync(path.join(root, 'static', 'pstudio_3d_engine.js'), 'utf8');
const environmentFx = fs.readFileSync(path.join(root, 'static', 'pstudio_environment_fx.js'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'static', 'pstudio_engine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

test('atmosphere settings apply preset defaults and clamp all authored parameters', () => {
  assert.deepEqual(atmosphere.normalize({}, 'day'), {
    elevation: 55, azimuth: 57, turbidity: 2.4, cloudDensity: 0.28
  });
  assert.deepEqual(atmosphere.normalize({
    elevation: 120, azimuth: -45, turbidity: 0, cloudDensity: 1.4
  }), {
    elevation: 90, azimuth: 315, turbidity: 1, cloudDensity: 1
  });
  assert.deepEqual(atmosphere.normalize({
    elevation: -90, azimuth: 725, turbidity: 14, cloudDensity: -0.4
  }), {
    elevation: -10, azimuth: 5, turbidity: 10, cloudDensity: 0
  });
});

test('sun direction uses degrees with north at positive Z and east at positive X', () => {
  const north = atmosphere.sunDirection({ elevation: 0, azimuth: 0 });
  const east = atmosphere.sunDirection({ elevation: 0, azimuth: 90 });
  const zenith = atmosphere.sunDirection({ elevation: 90, azimuth: 180 });
  assert.ok(Math.abs(north[0]) < 1e-10 && Math.abs(north[1]) < 1e-10 && north[2] > 0.999);
  assert.ok(east[0] > 0.999 && Math.abs(east[1]) < 1e-10 && Math.abs(east[2]) < 1e-10);
  assert.ok(zenith[1] > 0.999 && Math.abs(zenith[0]) < 1e-10 && Math.abs(zenith[2]) < 1e-10);
});

test('Rayleigh and Mie sky sampling returns finite linear colors and responds to sun and turbidity', () => {
  const clear = atmosphere.normalize({ elevation: 50, azimuth: 90, turbidity: 1.5, cloudDensity: 0 });
  const hazy = atmosphere.normalize({ elevation: 8, azimuth: 90, turbidity: 8, cloudDensity: 0.8 });
  const direction = [0, 0.35, 0.9367496998];
  const clearColor = atmosphere.computeSkyColor(direction, clear);
  const hazyColor = atmosphere.computeSkyColor(direction, hazy);
  assert.equal(clearColor.length, 3);
  assert.equal(hazyColor.length, 3);
  assert.ok([...clearColor, ...hazyColor].every(Number.isFinite));
  assert.notDeepEqual(clearColor, hazyColor);
  assert.ok(atmosphere.sunlight(clear).intensity > atmosphere.sunlight(hazy).intensity);
});

test('atmospheric sky mesh and PMREM generation have a graceful renderer boundary', () => {
  assert.equal(atmosphere.createSkyMesh(null, {}), null);
  assert.equal(atmosphere.createEnvironmentTexture(null, {}), null);
  assert.ok(renderer.includes('createSkyMesh'));
  assert.ok(renderer.includes('createEnvironmentTexture(T,scheduledSettings,384,192)'));
  assert.ok(renderer.includes('atmospherePmremTimer'));
  assert.ok(renderer.includes('setAtmosphere:settings=>'));
  assert.ok(renderer.includes('getAtmosphere:()=>({...atmosphereSettings})'));
});

test('volumetric clouds receive the physical sun direction and normalized cloud density', () => {
  for (const token of [
    'function configureAtmosphere(settings={})',
    'uniforms.uSunDirection.value.set',
    'uniforms.uCloudDensity.value=Math.max(0,Math.min(1,density))',
    'skyColor=source.rgb+vec3(.23,.20,.13)*sunGlow',
    'configureAtmosphere,createGodRaysPass'
  ]) assert.ok(environmentFx.includes(token), token);
  assert.ok(renderer.includes('configureAtmosphere?.({'));
  assert.ok(renderer.includes('cloudDensity:next.cloudDensity'));
  assert.ok(renderer.includes('selectedQuality.clouds&&volumetricCloudPass&&next.cloudDensity>0.001'));
});

test('set_atmosphere is validated and executed only by the browser game API', () => {
  assert.match(app, /"set_atmosphere": 4/);
  assert.match(engine, /case 'set_atmosphere': if\(a\.length===4\)/);
  assert.ok(engine.includes('runtime.atmosphere=settings'));
  assert.ok(engine.includes("type:'environment',preset:settings.preset,...settings"));
  assert.match(engine, /set_god_rays\|set_atmosphere/);
  assert.ok(html.includes('pstudio_atmosphere.js'));
});

test('Inspector atmosphere controls are normalized and persisted with scene and project backups', () => {
  for (const id of [
    'scene-atmosphere-elevation',
    'scene-atmosphere-azimuth',
    'scene-atmosphere-turbidity',
    'scene-atmosphere-cloud-density'
  ]) assert.ok(html.includes('id="' + id + '"'), id);
  assert.ok(html.includes('function updateSceneAtmosphere(field,value)'));
  assert.ok(html.includes('cloudDensity:clamp(number(\'cloudDensity\',defaults.cloudDensity),0,1)'));
  assert.ok(html.includes('environment:normalizeSceneEnvironment(sceneEnvironment)'));
  assert.ok(html.includes('Object.assign(environment,normalizeSceneEnvironment({...sourceEnvironment,...environment}))'));
});

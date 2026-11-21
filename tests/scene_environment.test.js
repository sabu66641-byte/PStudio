const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const presets = require(path.join(root, 'static', 'pstudio_scene_environment.js'));
const renderer = fs.readFileSync(path.join(root, 'static', 'pstudio_3d_engine.js'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'static', 'pstudio_engine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

test('scene environment module defines four independent environment presets', () => {
  const items = presets.listPresets();
  assert.deepEqual(items.map(item => item.name), ['day', 'dusk', 'night', 'studio']);
  for (const { name } of items) {
    const profile = presets.getPreset(name);
    for (const field of [
      'skyTop', 'skyMid', 'horizon', 'ground', 'fogColor', 'fogNear', 'fogFar',
      'lightColor', 'lightIntensity', 'lightX', 'lightY', 'lightZ',
      'hemisphereSky', 'hemisphereGround', 'hemisphereIntensity', 'environmentIntensity'
    ]) assert.ok(Object.prototype.hasOwnProperty.call(profile, field), name + ': ' + field);
    assert.ok(profile.fogFar > profile.fogNear, name + ' fog range');
    assert.ok(profile.lightIntensity > 0, name + ' key light intensity');
    assert.ok(profile.hemisphereIntensity > 0, name + ' hemisphere intensity');
  }
  const mutableCopy=presets.getPreset('day');
  mutableCopy.skyTop='#FFFFFF';
  assert.notEqual(mutableCopy.skyTop,presets.getPreset('day').skyTop,'editing a returned profile must not mutate the internal preset');
});

test('scene environment preset normalization defaults invalid and missing names to daytime', () => {
  assert.equal(presets.normalizePreset(undefined), 'day');
  assert.equal(presets.normalizePreset(null), 'day');
  assert.equal(presets.normalizePreset('not-a-preset'), 'day');
  assert.equal(presets.normalizePreset('NIGHT'), 'night');
  assert.deepEqual(
    ['day', 'dusk', 'night', 'studio'].map(name => presets.normalizePreset(name)),
    ['day', 'dusk', 'night', 'studio']
  );
});

test('new scenes default to day and project persistence includes scene environment', () => {
  assert.match(html, /let sceneEnvironment=\{preset:'day'\}/);
  assert.match(html, /environment:sceneEnvironment/);
  assert.match(html, /function normalizeSceneEnvironment\(value\)/);
  assert.match(html, /\['day','dusk','night','studio'\]\.includes\(preset\)/);
});

test('old scene files without environment data remain compatible and load as daytime', () => {
  assert.match(html, /function serializeScene\(\)\{return JSON\.stringify\(\{width:960,height:540,objects:sceneObjects,environment:normalizeSceneEnvironment\(sceneEnvironment\)\}/);
  assert.match(html, /sceneEnvironment=normalizeSceneEnvironment\(data\.environment\)/);
  assert.match(html, /saved\.environment\|\|legacySceneEnvironment/);
  assert.match(html, /legacySceneEnvironment=JSON\.parse\(projectFiles\['main\.scene'\]\?\.content\|\|'null'\)\?\.environment/);
});

test('Inspector exposes all four scene presets with explicit accessible active states', () => {
  for (const name of ['day', 'dusk', 'night', 'studio']) {
    assert.match(html, new RegExp('id="scene-environment-' + name + '"'));
    assert.match(html, new RegExp("setSceneEnvironmentPreset\\('" + name + "'\\)"));
  }
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /button\.setAttribute\('aria-pressed',active\?'true':'false'\)/);
  assert.match(html, /\.environment-preset-btn\.active/);
});

test('renderer builds a procedural sky panorama and falls back safely if Canvas or PMREM is unavailable', () => {
  for (const token of [
    'function createProceduralSkyTexture(T,profile)',
    'new T.CanvasTexture(canvas)',
    'T.EquirectangularReflectionMapping',
    'context.createLinearGradient',
    'context.createRadialGradient',
    'function applySceneEnvironmentPreset(T,presetName,hasCustomEnvironment=false)',
    'Procedural sky texture unavailable; using a color background',
    'Procedural sky PMREM generation failed; using the equirectangular texture directly',
    "else scene.background=new T.Color(profile.horizon||profile.skyMid||'#79BCE0')"
  ]) assert.ok(renderer.includes(token), token);
});

test('default environment configures fog, hemisphere light, sun light and existing CSM shadow path', () => {
  assert.match(renderer, /applySceneEnvironmentPreset\(T,environment\?\.preset\|\|'day'/);
  assert.match(renderer, /scene\.fog=new T\.Fog\(profile\.fogColor,profile\.fogNear,profile\.fogFar\)/);
  assert.match(renderer, /hemisphereLight\.color\.set\(profile\.hemisphereSky\)/);
  assert.match(renderer, /hemisphereLight\.groundColor\.set\(profile\.hemisphereGround\)/);
  assert.match(renderer, /light\.castShadow=true/);
  assert.match(renderer, /renderer\.shadowMap\.type=profile\.shadowMode==='vsm'\?window\.THREE\.VSMShadowMap:window\.THREE\.PCFSoftShadowMap/);
  assert.doesNotMatch(renderer, /scene\.fog=null/);
});

test('script-authored environment commands and old ps environment APIs remain supported', () => {
  assert.match(renderer, /if\(environment\.environmentSky&&environment\.environmentGround\)/);
  assert.match(renderer, /if\(environment\.fogColor\)/);
  assert.match(renderer, /if\(Number\.isFinite\(environment\.lightIntensity\)\)/);
  assert.match(engine, /case 'set_environment': if\(a\.length===3\)/);
  assert.match(engine, /case 'set_background': if \(a\.length===1\)/);
  assert.match(engine, /case 'set_fog': if \(a\.length===3\)/);
  assert.match(engine, /case 'set_light': if \(a\.length===4\)/);
  assert.match(app, /"set_environment": 3/);
  assert.match(app, /"set_background": 1/);
  assert.match(app, /"set_fog": 3/);
  assert.match(app, /"set_light": 4/);
});

test('large editor workspace grid and selected environment are sent to the 3D renderer', () => {
  assert.match(engine, /commands\.set\('__scene__',\[\{type:'grid',size:500,divisions:100\},\{type:'environment',preset:sceneEnvironment\?\.preset\|\|'day'\}/);
  assert.match(html, /function setSceneEnvironmentPreset\(preset\)/);
  assert.match(html, /window\.PStudioEngine\?\.refreshSceneView\?\.\(\)/);
});

test('runtime scene environment does not force a 2D-only game into the 3D renderer', () => {
  assert.match(engine, /commands\.set\('__scene__',\[\{type:'environment',preset:sceneEnvironment\?\.preset\|\|'day'\}\]\)/);
  assert.match(engine, /const drawCommands=new Map\(\[\.\.\.activeCommands\]\.filter\(\(\[id\]\)=>id!=='__scene__'\)\)/);
  assert.match(engine, /const allDraws=draws/);
  assert.match(engine, /drawScene\(drawCommands\)/);
  assert.match(engine, /window\.PStudio3D\.render\(commands\)/);
});

test('GLB material inspector exposes sidedness, normal recalculation, roughness, metalness and emissive controls', () => {
  for (const id of [
    'obj-model-material-roughness', 'obj-model-material-metalness', 'obj-model-material-color',
    'obj-model-double-side', 'obj-model-recompute-normals',
    'obj-model-material-emissive', 'obj-model-material-emissive-intensity'
  ]) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /doubleSide:!!document\.getElementById\('obj-model-double-side'\)\?\.checked/);
  assert.match(html, /recomputeNormals:!!document\.getElementById\('obj-model-recompute-normals'\)\?\.checked/);
  assert.match(html, /emissiveIntensity:Math\.max\(0,Math\.min\(8/);
  assert.match(engine, /doubleSide:override\.doubleSide,recomputeNormals:override\.recomputeNormals,emissive:override\.emissive,emissiveIntensity:override\.emissiveIntensity/);
});

test('GLB material overrides restore source defaults and keep normal recomputation on instance-owned geometry clones', () => {
  for (const token of [
    'materialDefaults.set(copy,{',
    'emissive:material.emissive?.clone?.()||null',
    'side:material.side??T.FrontSide',
    'material.side=override.doubleSide?window.THREE.DoubleSide:(defaults.side??window.THREE.FrontSide)',
    'material.emissive.set(override.emissive)',
    'geometryOriginals=new Map(),normalGeometryClones=new Map()',
    'normalized=original.clone()',
    'normalized.computeVertexNormals()',
    'object.geometry=normalized',
    'object.geometry=original',
    'for(const geometry of instance.normalGeometryClones?.values?.()||[])'
  ]) assert.ok(renderer.includes(token), token);
});

test('GLB source material and source geometry are cloned before editor overrides are applied', () => {
  assert.match(renderer, /copy=material\.clone\(\);setupLightingMaterial\(copy\)/);
  assert.match(renderer, /geometryOriginals\.set\(object,object\.geometry\)/);
  assert.match(renderer, /normalGeometryClones\?\.set\(original,normalized\)/);
  assert.match(renderer, /instance\.normalGeometryClones\?\.clear\?\.\(\);instance\.geometryOriginals\?\.clear\?\.\(\)/);
});

test('PStudio retains existing ps material API arity and does not change parser or generated code interface', () => {
  assert.match(app, /"set_model_material": 4/);
  assert.match(engine, /case 'set_model_material': if\(a\.length===4\)/);
  assert.match(engine, /case 'set_environment': if\(a\.length===3\)/);
});

test('project backups preserve scene environment presets and restore old backups as daytime',()=>{
  assert.match(html,/environment:normalizeSceneEnvironment\(sceneEnvironment\)/);
  assert.match(html,/let sourceEnvironment=archive\.project\.environment\|\|null/);
  assert.match(html,/JSON\.parse\(files\['main\.scene'\]\?\.content\|\|'null'\)\?\.environment/);
  assert.match(html,/const environment=\{preset:\['day','dusk','night','studio'\]\.includes\(sourcePreset\)\?sourcePreset:'day'\}/);
  assert.match(html,/next\.files\['main\.scene'\]\.content=JSON\.stringify\(\{width:960,height:540,objects:next\.objects,environment:next\.environment\}/);
  assert.match(html,/const nextState=\{files:next\.files,assets:next\.assets,objects:next\.objects,environment:next\.environment,active:next\.active\}/);
  assert.match(html,/sceneEnvironment=next\.environment/);
  assert.match(html,/environment:sceneEnvironment/);
});
test('project backup restores sanitized GLB material overrides without trusting arbitrary input',()=>{
  assert.match(html,/sourceOverrides\.length>64/);
  assert.match(html,/sourceOverrides\.map\(override=>/);
  assert.match(html,/doubleSide:override\.doubleSide===true/);
  assert.match(html,/recomputeNormals:override\.recomputeNormals===true/);
  assert.match(html,/emissiveIntensity:bounded\(override\.emissiveIntensity,0,8\)/);
  assert.match(html,/\^\#\[0-9a-fA-F\]\{6\}\$/);
  assert.match(html,/modelMaterialOverrides=sourceOverrides\.map/);
});
test('procedural scene environment releases the unused room PMREM when switching to the preset PMREM',()=>{
  assert.match(renderer,/if\(environmentTarget\)\{environmentTarget\.dispose\?\.\(\);environmentTarget=null;\}/);
  assert.match(renderer,/scenePresetTarget=nextTarget/);
  assert.match(renderer,/scene\.environment=scenePresetTarget\.texture/);
});

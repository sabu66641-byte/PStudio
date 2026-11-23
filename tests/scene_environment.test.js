const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const presets = require(path.join(root, 'static', 'pstudio_scene_environment.js'));
const renderer = fs.readFileSync(path.join(root, 'static', 'pstudio_3d_engine.js'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'static', 'pstudio_engine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
const materials = fs.readFileSync(path.join(root, 'static', 'pstudio_ecs_materials.js'), 'utf8');
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
  assert.match(html, /test('GLB material Inspector settings are stored in ECS and forwarded to PStudio3D', () => {
  for (const id of [
    'obj-model-material-roughness', 'obj-model-material-metalness', 'obj-model-material-color',
    'obj-model-double-side', 'obj-model-recompute-normals',
    'obj-model-material-emissive', 'obj-model-material-emissive-intensity'
  ]) assert.ok(html.includes('id="' + id + '"'), id);
  assert.ok(html.includes("doubleSide:!!document.getElementById('obj-model-double-side')?.checked"));
  assert.ok(html.includes("recomputeNormals:!!document.getElementById('obj-model-recompute-normals')?.checked"));
  assert.ok(html.includes("emissiveIntensity:Math.max(0,Math.min(8"));
  assert.ok(materials.includes('doubleSide: override.doubleSide'));
  assert.ok(materials.includes('recomputeNormals: override.recomputeNormals'));
  assert.ok(materials.includes('emissiveIntensity: override.emissiveIntensity'));
});
test('GLB material overrides restore source defaults and use per-instance geometry clones for normal recalculation', () => {
  for (const token of [
    'materialDefaults.set(copy,{',
    'emissive:material.emissive?.clone?.()||null',
    'side:material.side??T.FrontSide',
    'material.side=override.doubleSide?window.THREE.DoubleSide:(defaults.side??window.THREE.FrontSide)',
    'material.emissive.set(override.emissive)',
    'geometryOriginals=new Map(),normalGeometryClones=new Map()',
    'const original=object.userData?.pstudioLightmapGeometry?object.geometry:',
    'normalized=original.clone()',
    'normalized.computeVertexNormals()',
    "normalized.deleteAttribute('tangent')",
    'scheduleGeometryBVH(normalized)',
    'object.geometry=normalized',
    'if(normalized&&object.geometry===normalized)object.geometry=original',
    'for(const geometry of instance.normalGeometryClones?.values?.()||[])'
  ]) assert.ok(renderer.includes(token), token);
});

test('model material instances do not capture geometry before LOD or lightmap setup', () => {
  assert.match(renderer,/normalGeometrySignature=overrides\.some\(item=>item\.recomputeNormals===true\)/);
  assert.doesNotMatch(renderer,/geometryOriginals\.set\(object,object\.geometry\)/);
  assert.match(renderer,/const original=object\.userData\?\.pstudioLightmapGeometry\?object\.geometry/);
  assert.match(renderer,/normalGeometryClones\?\.set\(original,normalized\)/);
});
test('normal overrides follow LOD and lightmap geometry revisions without per-frame mesh scans',()=>{
  assert.match(renderer,/function markModelGeometryChanged\(object\)/);
  assert.match(renderer,/object\.geometry=levels\[selected\]\.geometry;\s*markModelGeometryChanged\(object\)/);
  assert.match(renderer,/object\.geometry=working;object\.userData\.pstudioLightmapGeometry=true;markModelGeometryChanged\(object\)/);
  assert.match(renderer,/object\.geometry=working;working=null;object\.userData\.pstudioLightmapGeometry=true;markModelGeometryChanged\(object\)/);
  assert.match(renderer,/object\.geometry=object\.userData\.pstudioLightmapOriginalGeometry;markModelGeometryChanged\(object\)/);
  assert.match(renderer,/normalGeometrySignature=overrides\.some\(item=>item\.recomputeNormals===true\)\s*\?Number\(instance\.root\?\.userData\?\.pstudioGeometryRevision\)\|\|0/);
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

test('project backup Scene Object reconstruction preserves v1 ECS Components and legacy v0 payloads', () => {
  const start = html.indexOf('function copySavedEcsComponentPayload');
  const end = html.indexOf('function validateAndBuildBackup', start + 1);
  assert.ok(start >= 0 && end > start);
  const source = html.slice(start, end);
  const copyPayload = new Function('window', source + '\nreturn copySavedEcsComponentPayload;')({
    PStudioECS: { sceneComponentSchemaVersion: 1 }
  });
  const legacyArray = { ecsComponents: [{ type: 'Health', data: { hp: 25 } }] };
  const restoredArray = copyPayload(legacyArray, {});
  assert.equal(restoredArray.ecsComponentsVersion, 0);
  assert.deepEqual(restoredArray.ecsComponents, legacyArray.ecsComponents);

  const legacyMap = { ecsComponents: { Inventory: { items: { potion: 2 } } } };
  const restoredMap = copyPayload(legacyMap, {});
  assert.equal(restoredMap.ecsComponentsVersion, 0);
  assert.deepEqual(restoredMap.ecsComponents, legacyMap.ecsComponents);

  const v1 = {
    ecsComponentsVersion: 1,
    ecsComponents: [
      { type: 'Renderable', data: { assetName: 'tree.glb', scale: 2 } },
      { type: 'PluginSettings', data: { enabled: true } }
    ]
  };
  const restoredV1 = copyPayload(v1, {});
  assert.equal(restoredV1.ecsComponentsVersion, 1);
  assert.deepEqual(restoredV1.ecsComponents, v1.ecsComponents);
});

test('project backup preserves opaque future ECS schemas and rejects malformed/current oversized payloads', () => {
  const start = html.indexOf('function copySavedEcsComponentPayload');
  const end = html.indexOf('function validateAndBuildBackup', start + 1);
  const copyPayload = new Function('window', html.slice(start, end) + '\nreturn copySavedEcsComponentPayload;')({
    PStudioECS: { sceneComponentSchemaVersion: 1 }
  });
  const future = {
    ecsComponentsVersion: 7,
    ecsComponents: { schema: 'future-map', records: [{ type: 'FutureType', data: [1, 2, 3] }] }
  };
  const copy = copyPayload(future, {});
  assert.deepEqual(copy, future);
  assert.throws(() => copyPayload({ ecsComponentsVersion: 'future', ecsComponents: [] }, {}), /version is invalid/);
  assert.throws(() => copyPayload({ ecsComponentsVersion: 1, ecsComponents: { invalid: true } }, {}), /must be an array/);
  assert.throws(() => copyPayload({ ecsComponentsVersion: 1, ecsComponents: Array.from({ length: 129 }, (_, i) => ({ type: 'C' + i, data: {} })) }, {}), /at most 128/);
  assert.throws(() => copyPayload({ ecsComponents: { a: 'x'.repeat(1024 * 1024 + 1) } }, {}), /1 MB/);
});

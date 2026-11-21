const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'static', 'pstudio_3d_engine.js'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'static', 'pstudio_engine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, start + ' must exist');
  assert.notEqual(to, -1, end + ' must exist');
  return source.slice(from, to);
}

test('adding a GLB keeps the current camera; framing is an explicit user action',()=>{
  const addBlock=section(html,'function addModelToScene(assetName){','function frameSelectedModel(){');
  assert.doesNotMatch(addBlock,/frameObject/);
  assert.match(html,/function frameSelectedModel\(\)/);
  assert.match(html,/onclick="frameSelectedModel\(\)"/);
  assert.match(html,/window\.PStudio3D\?\.frameObject\?\.\(object\.id\)/);
  assert.match(renderer,/function frameCameraToModel\(instance\)/);
  assert.match(renderer,/function frameObject\(ownerId\)/);
  assert.match(renderer,/pendingCameraFrames\.add\(id\)/);
  assert.match(renderer,/pendingCameraFrames\.delete\(String\(ownerId\)\)/);
});
test('model draw distance uses the transformed local bounds center rather than the root pivot',()=>{
  assert.match(renderer,/localCenter\.clone\(\)\.applyMatrix4\(object\.matrixWorld\)/);
  assert.match(renderer,/cameraPosition\.distanceTo\(center\)-radius\*scale/);
  assert.match(renderer,/relativeMatrix\.multiplyMatrices\(inverseRoot,object\.matrixWorld\)/);
  assert.match(renderer,/clone\.userData\.pstudioBoundsCenter=modelSphere\.center\.clone\(\)/);
});
test('large model streaming keeps camera-visible chunks active and uses accurate chunk bounds',()=>{
  assert.match(renderer,/pstudioStreamBoundsCenter=sphere\.center\.clone\(\)\.sub\(chunk\.position\)/);
  assert.match(renderer,/worldFrustum\?\.intersectsSphere\?\.\(new T\.Sphere\(center,radius\)\)/);
  assert.match(renderer,/chunk\.visible=active/);
});
test('prepared model visibility diagnostics distinguish loading success from actual scene visibility',()=>{
  assert.match(renderer,/function getModelVisibilityDiagnostics\(instance\)/);
  assert.match(renderer,/visibleMeshes/);
  assert.match(renderer,/withinDrawDistance/);
  assert.match(renderer,/pstudio-model-visibility/);
  assert.match(engine,/pstudio-model-visibility/);
  assert.match(renderer,/visibility:instances\.map\(getModelVisibilityDiagnostics\)/);
});

test('camera collision ignores the object currently being framed, not other geometry', () => {
  assert.match(renderer, /cameraFocusOwnerId=String\(instance\.ownerId\)/);
  assert.match(renderer, /const isCameraFocus=/);
  assert.match(renderer, /return !isCameraFocus&&\(ownerId===undefined\|\|ownerId===null\|\|ownerId!==excludedOwnerId\)/);
});

test('unchanged scene camera commands do not reset editor orbit and zoom state', () => {
  assert.match(renderer, /nextCameraSignature!==cameraCommandSignature/);
  assert.match(renderer, /cameraCommandSignature=nextCameraSignature/);
  assert.match(renderer, /const nextCameraSignature=cameraCommand/);
});
test('selecting a scene object marks it as the camera focus collision exclusion', () => {
  assert.match(renderer, /if\(id!==null&&id!==undefined\)cameraFocusOwnerId=String\(id\)/);
});

test('selected GLB models remain visible while being edited', () => {
  assert.match(renderer, /String\(c\.owner\)===String\(selectedOwnerId\)/);
  assert.match(renderer, /instance\.root\.visible=!instance\.preparing&&active&&\(isSelected\|\|!instance\.root\.userData\.pstudioOccluded\)/);
});

test('native GLTF material shaders remain untouched unless a probe volume is baked', () => {
  assert.match(renderer, /if\(!bakedLightProbeVolume\?\.length\)return material/);
  assert.match(renderer, /if\(csm&&!material\.userData\.pstudioCSMSetup\)/);
  assert.match(renderer, /setupLightingMaterial\(copy\)/);
  assert.match(renderer, /bakedLightProbeVolume=finalProbes/);
});

test('the full scene stage handles orbit, pan, pinch, wheel and pointer capture', () => {
  assert.match(renderer, /interactionSurface = canvas\.parentElement \|\| canvas/);
  for (const eventName of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) {
    assert.ok(renderer.includes(`interactionSurface.addEventListener('${eventName}'`), eventName);
  }
  assert.match(renderer, /interactionSurface\.setPointerCapture\(e\.pointerId\)/);
  assert.match(renderer, /insideCanvas=/);
});

test('dragging a locked model orbits the camera while double-tap still toggles manipulation', () => {
  assert.match(renderer, /pointerMode==='locked-object'&&dragInfo&&Math\.hypot/);
  assert.match(renderer, /pointerMode='orbit';dragInfo=null;lastObjectTap=null/);
  assert.match(renderer, /toggleManipulation\?\.\(ownerId\)/);
  assert.match(renderer, /pointerMode==='object-pending'/);
});

test('the generic 3D renderer retains its quality, LOD, BVH and lightmap systems', () => {
  for (const feature of [
    'scheduleAutoLOD', 'applyAutoLOD', 'scheduleGeometryBVH',
    'bakeLightProbeVolume', 'bakeUVLightmaps', 'setQualityPreset:applyQualityPreset',
    'csm.update()', 'updateWorldVisibility'
  ]) assert.ok(renderer.includes(feature), feature);
  assert.match(engine, /type:'model'/);
  assert.match(engine, /function buildScenePreview3D\(\)/);
});


test('JSON glTF assets are routed around the GLB-only worker parser',()=>{
  assert.ok(renderer.includes('const isJSONGLTF='));
  assert.ok(renderer.includes("if(isJSONGLTF)"));
  assert.ok(renderer.includes('gltf=await parseGLTFOnMainThread(blob,assetName)'));
  assert.ok(renderer.includes("stage:'main-thread-gltf-json-start'"));
});
test('scene-add feedback describes registration rather than claiming async load completion',()=>{
  assert.ok(html.includes('読み込み状況とエラーはOUTPUTに表示されます'));
  assert.ok(engine.includes("status.textContent='MODEL ERROR · '+name"));
});

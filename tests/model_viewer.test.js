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

test('camera zoom is wide-range, pinch-out zooms in, and distant models expand the far clip plane',()=>{
  assert.match(renderer,/CAMERA_ZOOM_MIN=0\.035,CAMERA_ZOOM_MAX=128/);
  assert.match(renderer,/pinchDistance\/Math\.max\(1,distance\)/);
  assert.match(renderer,/adjustZoom:adjustCameraZoom/);
  assert.match(renderer,/requiredFar=Math\.max\(1600,Math\.min\(1000000,desiredDistance\+worldRenderConfig\.maxDrawDistance\+64\)\)/);
  assert.match(html,/camera-zoom-controls/);
  assert.match(html,/adjustZoom\?\.\(1\.25\)/);
  assert.match(html,/adjustZoom\?\.\(0\.8\)/);
});
test('inspector toggle controls expose their active state in text, color and aria-pressed',()=>{
  for(const id of ['obj-collider-state','obj-bloom-state','obj-ssao-state','obj-particle-enabled-state'])assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(html,/function setToggleState\(id,enabled\)/);
  assert.match(html,/function toggleSelectedManipulation\(\)/);
  assert.match(html,/aria-pressed="true" onclick="toggleSelectedManipulation\(\)"/);
  assert.match(html,/button\.setAttribute\('aria-pressed',String\(enabled\)\)/);
});
test('view mode selection is strongly visible and exposed to assistive state',()=>{
  assert.match(html,/\.view-mode-btn\.active::before\{content:"✓ "/);
  for(const mode of ['auto','2d','3d'])assert.ok(html.includes('id="view-mode-'+mode+'"'),mode);
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

test('touch-device auto quality starts with a balanced adaptive render scale',()=>{
  assert.match(renderer,/selected==='mobile'&&isTouchDevice&&deviceMemoryGiB\(\)>2\)adaptiveQualityLevel=1/);
  assert.match(renderer,/initialAdaptiveScale=adaptiveQualityEnabled\?\[0\.68,0\.84,1\]\[adaptiveQualityLevel\]:1/);
});
test('large GLB scenes bypass recursive CPU occlusion raycasts while keeping frustum culling',()=>{
  assert.match(renderer,/occlusionEligible:meshes\.length<=256/);
  assert.match(renderer,/hasHighComplexityModel=\[\.\.\.modelInstances\.values\(\)\]\.some/);
  assert.match(renderer,/if\(hasHighComplexityModel\)/);
  assert.match(renderer,/instance\.occlusionEligible===false\|\|!instance\.root\.userData\.pstudioOccluded/);
});
test('streaming updates only the root matrix and does not traverse all GLB descendants each frame',()=>{
  assert.match(renderer,/instance\.root\.updateWorldMatrix\(true,false\);\s*const factor=qualityPreset/);
  assert.doesNotMatch(renderer,/function updateModelStreamingChunks\(instance\)\{[\s\S]{0,160}root\.updateMatrixWorld\(true\)/);
});
test('static imported models skip the animated foliage matrix update path',()=>{
  assert.match(renderer,/animatedFoliageBatches:foliageBatches\.filter\(entry=>entry\.isTree\)/);
  assert.match(renderer,/const entries=instance\?\.animatedFoliageBatches/);
  assert.match(renderer,/parent\.updateWorldMatrix\(true,false\)/);
  assert.doesNotMatch(renderer,/function updateFoliageInstanceBatches\(instance\)\{[\s\S]{0,220}root\.updateMatrixWorld\(true\)/);
});
test('large selected GLBs use one bounds outline instead of per-mesh edge geometries',()=>{
  assert.match(renderer,/complexInstance=\[\.\.\.modelInstances\.values\(\)\]\.find/);
  assert.match(renderer,/new T\.Box3Helper\(bounds,0xffffff\)/);
  assert.match(renderer,/pstudioBoundsSelectionHelper/);
});
test('camera collision skips recursive high-complexity model trees',()=>{
  assert.match(renderer,/pstudioHighComplexity=meshes\.length>256/);
  assert.match(renderer,/if\(child\.userData\?\.pstudioHighComplexity\)continue/);
  assert.match(renderer,/child\.updateWorldMatrix\(true,true\)/);
  assert.match(renderer,/collisionTargets\.push\(child\)/);
  assert.match(renderer,/intersectObjects\(collisionTargets,true\)/);
  assert.doesNotMatch(renderer,/primitiveGroup\.updateMatrixWorld\(true\);\s*modelGroup\.updateMatrixWorld\(true\);\s*cameraCollisionRaycaster/);
  assert.match(renderer,/instance\.root\.visible=!instance\.preparing&&active/);
});
test('selected GLB models remain visible while being edited', () => {
  assert.match(renderer, /String\(c\.owner\)===String\(selectedOwnerId\)/);
  assert.match(renderer, /instance\.root\.visible=!instance\.preparing&&active&&\(isSelected\|\|instance\.occlusionEligible===false\|\|!instance\.root\.userData\.pstudioOccluded\)/);
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
test('scene-add feedback describes registration, stable camera state and visibility diagnostics',()=>{
  assert.ok(html.includes('カメラ位置は維持されます'));
  assert.ok(html.includes('表示診断はOUTPUTに表示されます'));
  assert.ok(engine.includes("status.textContent='MODEL ERROR · '+name"));
  assert.ok(engine.includes("pstudio-model-visibility"));
});

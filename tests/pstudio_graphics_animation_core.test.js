'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
 createPStudioAnimationClip,samplePStudioAnimationClip,applyPStudioAnimationFrame,
 createPStudioSkinDescriptor,deformPStudioSkinnedGeometry,evaluatePStudioSceneAnimation,
 createPStudioSceneAnimationPlayer,selectPStudioLOD,createPStudioInstancePool
}=require('../static/pstudio_graphics_animation_core.mjs');
const {createPStudioGraphicsSceneCore}=require('../static/pstudio_graphics_scene_core.mjs');

test('PStudio animation clip samples linear TRS, STEP weights, loops and quaternion slerp',()=>{
 const clip=createPStudioAnimationClip({id:'clip.walk',duration:1,tracks:[
  {targetId:'hero',path:'translation',times:[0,1],values:[0,0,0,10,0,0]},
  {targetId:'hero',path:'rotation',times:[0,1],values:[0,0,0,1,0,1,0,0]},
  {targetId:'hero',path:'weights',components:2,interpolation:'STEP',times:[0,.5],values:[0,0,1,.5]}
 ]});
 const sample=samplePStudioAnimationClip(clip,.75);
 assert.deepEqual(sample.tracks[0].value,[7.5,0,0]);
 assert.ok(Math.abs(sample.tracks[1].value[1]-Math.sin(3*Math.PI/8))<1e-6);
 assert.deepEqual(sample.tracks[2].value,[1,.5]);
 assert.equal(samplePStudioAnimationClip(clip,1.5,{loop:true}).time,.5);
 assert.throws(()=>createPStudioAnimationClip({id:'bad',tracks:[{targetId:'x',path:'translation',times:[1,0],values:[0,0,0,1,0,0]}]}),/strictly increasing/);
});

test('PStudio animation writes only supported Scene Core components and preserves other transform channels',()=>{
 const core=createPStudioGraphicsSceneCore();
 core.createScene({id:'scene'});core.createEntity({id:'hero',sceneId:'scene',transform:{position:[0,0,0],scale:[2,2,2]}});
 const clip=createPStudioAnimationClip({id:'clip',tracks:[{targetId:'hero',path:'translation',times:[0,1],values:[0,0,0,3,0,0]}]});
 assert.equal(applyPStudioAnimationFrame(core,samplePStudioAnimationClip(clip,.5)),1);
 const entity=core.getEntity('hero');
 assert.deepEqual(entity.transform.position,[1.5,0,0]);
 assert.deepEqual(entity.transform.scale,[2,2,2]);
 core.dispose();
});

test('PStudio skin descriptor and CPU morph-then-skin deformation validate joint data',()=>{
 const skin=createPStudioSkinDescriptor({id:'skin',joints:['root'],inverseBindMatrices:[[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]]});
 assert.equal(skin.joints.length,1);
 const output=deformPStudioSkinnedGeometry({
  positions:[0,0,0],normals:[0,1,0],jointIndices:[0,0,0,0],jointWeights:[1,0,0,0],
  jointMatrices:[[1,0,0,0,0,1,0,0,0,0,1,0,2,0,0,1]],
  morphTargets:[{positions:[0,1,0]}],morphWeights:[.5]
 });
 assert.deepEqual(Array.from(output.positions),[2,.5,0]);
 assert.deepEqual(Array.from(output.normals),[0,1,0]);
 assert.throws(()=>createPStudioSkinDescriptor({id:'bad',joints:['a','a'],inverseBindMatrices:[]}),/unique/);
});

test('PStudio LOD selection is distance-bounded and uses hysteresis to prevent oscillation',()=>{
 const levels=[{id:'near',maxDistance:10},{id:'mid',maxDistance:30},{id:'far',maxDistance:100}];
 assert.equal(selectPStudioLOD(levels,9).id,'near');
 assert.equal(selectPStudioLOD(levels,11,0,.2).id,'near');
 assert.equal(selectPStudioLOD(levels,13,0,.1).id,'mid');
 assert.equal(selectPStudioLOD(levels,200,2).id,'far');
});

test('PStudio instance pool enforces limits and deterministic release',()=>{
 const pool=createPStudioInstancePool({limit:2});
 pool.create('a');pool.create('b');
 assert.throws(()=>pool.create('c'),/limit/);
 assert.equal(pool.update('a',{visible:false}).visible,false);
 assert.equal(pool.release('a'),true);assert.equal(pool.release('a'),false);
 assert.equal(pool.stats().count,1);assert.equal(pool.clear(),1);
});

test('PStudio CUBICSPLINE tracks use glTF Hermite tangents scaled by keyframe duration',()=>{
 const clip=createPStudioAnimationClip({id:'clip.cubic',tracks:[{
  targetId:'root',path:'translation',interpolation:'CUBICSPLINE',times:[0,1],
  values:[0,0,0, 1,0,0],
  inTangents:[0,0,0,0,0,0],outTangents:[2,0,0,0,0,0]
 }]});
 assert.deepEqual(samplePStudioAnimationClip(clip,.5).tracks[0].value,[0.75,0,0]);
 assert.throws(()=>createPStudioAnimationClip({id:'bad.cubic',tracks:[{
  targetId:'root',path:'translation',interpolation:'CUBICSPLINE',times:[0,1],values:[0,0,0,1,0,0],
  inTangents:[0,0,0],outTangents:[0,0,0,0,0,0]
 }]}),/one in- and out-tangent/);
});

test('PStudio scene animation evaluates node hierarchy and morphs before skeletal skinning without mutating source assets',()=>{
 const {createPStudioGraphicsSceneAsset}=require('../static/pstudio_graphics_scene_asset.mjs');
 const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
 const geometry={
  id:'hero.geometry',
  positions:[0,0,0, 1,0,0, 0,1,0],
  normals:[0,0,1, 0,0,1, 0,0,1],
  jointIndices:[0,0,0,0, 0,0,0,0, 0,0,0,0],
  jointWeights:[1,0,0,0, 1,0,0,0, 1,0,0,0],
  morphTargets:[{positions:[0,1,0, 0,1,0, 0,1,0]}]
 };
 const skin=createPStudioSkinDescriptor({id:'hero.skin',joints:['node.joint'],inverseBindMatrices:[identity]});
 const clip=createPStudioAnimationClip({id:'hero.walk',tracks:[
  {targetId:'node.joint',path:'translation',times:[0,1],values:[0,0,0,2,0,0]},
  {targetId:'node.mesh',path:'weights',components:1,times:[0,1],values:[0,1]}
 ]});
 const source=createPStudioGraphicsSceneAsset({
  id:'hero.scene',
  geometries:[geometry],
  materials:[{id:'hero.material',model:'pbr'}],
  nodes:[
   {id:'node.mesh',translation:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1],matrix:identity,worldMatrix:identity},
   {id:'node.joint',translation:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1],matrix:identity,worldMatrix:identity}
  ],
  skins:[skin],animations:[clip],
  entities:[{id:'hero.mesh',nodeId:'node.mesh',geometryId:'hero.geometry',materialId:'hero.material',skinId:'hero.skin',morphWeights:[0]}]
 });
 const frame=evaluatePStudioSceneAnimation(source,'hero.walk',.5);
 const output=frame.geometries.find(item=>item.id===frame.entities[0].geometryId);
 assert.notEqual(frame.entities[0].geometryId,'hero.geometry');
 assert.equal(frame.entities[0].skinId,null);
 assert.deepEqual(frame.entities[0].morphWeights,[]);
 assert.deepEqual(Array.from(output.positions.slice(0,3)),[1,.5,0]);
 assert.deepEqual(Array.from(source.geometries[0].positions.slice(0,3)),[0,0,0]);
 assert.deepEqual(frame.nodes.find(node=>node.id==='node.joint').worldMatrix.slice(12,15),[1,0,0]);
 const player=createPStudioSceneAnimationPlayer(source,{clipId:'hero.walk',autoPlay:true,loop:false});
 const played=player.update(.5);
 assert.equal(player.getState().playing,true);
 assert.deepEqual(Array.from(played.scene.geometries.find(item=>item.id===played.scene.entities[0].geometryId).positions.slice(0,3)),[1,.5,0]);
 player.pause();
 assert.equal(player.getState().playing,false);
 player.dispose();
});

test('PStudio skinning transforms normals with the inverse-transpose joint matrix',()=>{
 const output=deformPStudioSkinnedGeometry({
  positions:[0,0,0],normals:[1,1,0],jointIndices:[0,0,0,0],jointWeights:[1,0,0,0],
  jointMatrices:[[2,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]]
 });
 const normal=Array.from(output.normals);
 assert.ok(Math.abs(normal[0] - 1/Math.sqrt(5)) < 1e-6);
 assert.ok(Math.abs(normal[1] - 2/Math.sqrt(5)) < 1e-6);
});

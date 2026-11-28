'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
 createPStudioAnimationClip,samplePStudioAnimationClip,applyPStudioAnimationFrame,
 createPStudioSkinDescriptor,deformPStudioSkinnedGeometry,selectPStudioLOD,createPStudioInstancePool
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

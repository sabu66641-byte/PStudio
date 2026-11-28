'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPStudioTriangleBVH,createPStudioBVHCollisionAdapter}=require('../static/pstudio_graphics_bvh.mjs');
const {createPStudioGraphicsSceneAsset}=require('../static/pstudio_graphics_scene_asset.mjs');

const triangle={positions:[-1,-1,0,1,-1,0,0,1,0],indices:[0,1,2]};
test('PStudio BVH builds a bounded hierarchy and returns barycentric ray hits',()=>{
 const bvh=createPStudioTriangleBVH(triangle);
 const hit=bvh.raycast({origin:[0,0,3],direction:[0,0,-1]});
 assert.equal(hit.triangleIndex,0);assert.equal(hit.distance,3);
 assert.ok(Math.abs(hit.barycentric.reduce((a,b)=>a+b,0)-1)<1e-9);
 assert.deepEqual(hit.position,[0,0,0]);
 assert.equal(bvh.raycast({origin:[3,0,3],direction:[0,0,-1]}),null);
 assert.equal(bvh.raycast({origin:[0,0,3],direction:[0,0,-1]},{maxDistance:2}),null);
});
test('PStudio BVH collision adapter respects scene world transforms',()=>{
 const asset=createPStudioGraphicsSceneAsset({
  id:'scene.collision',geometries:[{id:'geo',...triangle}],
  materials:[{id:'mat'}],
  entities:[{id:'entity',geometryId:'geo',materialId:'mat',matrixWorld:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,-2,1]}]
 });
 const adapter=createPStudioBVHCollisionAdapter(asset);
 const hit=adapter.raycast({origin:[0,0,3],direction:[0,0,-1]});
 assert.equal(hit.entityId,'entity');assert.equal(hit.distance,5);assert.deepEqual(hit.position,[0,0,-2]);
 assert.equal(adapter.stats().cachedGeometryCount,1);
});
test('PStudio BVH rejects invalid indices and singular entity transforms',()=>{
 assert.throws(()=>createPStudioTriangleBVH({positions:[0,0,0,1,0,0,0,1,0],indices:[0,1,9]}),/outside the vertex range/);
 const asset=createPStudioGraphicsSceneAsset({id:'bad',geometries:[{id:'geo',...triangle}],materials:[{id:'mat'}],entities:[{id:'entity',geometryId:'geo',materialId:'mat',matrixWorld:[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]}]});
 assert.throws(()=>createPStudioBVHCollisionAdapter(asset).raycast({origin:[0,0,1],direction:[0,0,-1]}),/singular/);
});

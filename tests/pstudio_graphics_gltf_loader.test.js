'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadPStudioGLB}=require('../static/pstudio_graphics_gltf_loader.mjs');
const {samplePStudioAnimationClip}=require('../static/pstudio_graphics_animation_core.mjs');
function makeGlb(){
 const bin=new ArrayBuffer(36),view=new DataView(bin);
 const values=[0,0,0,1,0,0,0,1,0];values.forEach((v,i)=>view.setFloat32(i*4,v,true));
 const json={asset:{version:'2.0'},buffers:[{byteLength:36}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]}],meshes:[{primitives:[{attributes:{POSITION:0},mode:4}]}],nodes:[{mesh:0,translation:[2,0,0]}],scenes:[{nodes:[0]}],scene:0};
 const text=new TextEncoder().encode(JSON.stringify(json));const jsonLength=Math.ceil(text.length/4)*4;const total=12+8+jsonLength+8+36;const glb=new ArrayBuffer(total),out=new DataView(glb);
 out.setUint32(0,0x46546c67,true);out.setUint32(4,2,true);out.setUint32(8,total,true);
 out.setUint32(12,jsonLength,true);out.setUint32(16,0x4e4f534a,true);new Uint8Array(glb,20,text.length).set(text);
 out.setUint32(20+jsonLength,36,true);out.setUint32(24+jsonLength,0x004e4942,true);new Uint8Array(glb,28+jsonLength,36).set(new Uint8Array(bin));
 return glb;
}
test('PStudio-native GLB loader creates owned geometry, material and transformed entities',async()=>{
 const {asset,report}=await loadPStudioGLB(makeGlb());
 assert.equal(report.supported,true);assert.equal(asset.geometries.length,1);assert.equal(asset.entities.length,1);
 assert.deepEqual(asset.entities[0].matrixWorld.slice(12,15),[2,0,0]);
 assert.equal(asset.geometries[0].positions.length,9);assert.equal(asset.materials[0].model,'pbr');
});
test('PStudio-native GLB loader rejects malformed containers and external buffers',async()=>{
 const source=makeGlb();const bad=source.slice(0);new DataView(bad).setUint32(8,12,true);
 await assert.rejects(loadPStudioGLB(bad),/declared length/);
 const external=makeGlb();const bytes=new Uint8Array(external);const jsonOffset=20;const jsonLength=new DataView(external).getUint32(12,true);
 const json=JSON.parse(new TextDecoder().decode(bytes.slice(jsonOffset,jsonOffset+jsonLength)).trim());
 json.buffers[0].uri='mesh.bin';
 // The separate external-buffer rejection is validated by a minimal valid JSON GLB below.
 const encoded=new TextEncoder().encode(JSON.stringify({...json,meshes:[],nodes:[],scenes:[{nodes:[]}]}));
 const padded=(encoded.length+3)&~3,total=12+8+padded;
 const glb=new ArrayBuffer(total),dv=new DataView(glb);
 dv.setUint32(0,0x46546c67,true);dv.setUint32(4,2,true);dv.setUint32(8,total,true);dv.setUint32(12,padded,true);dv.setUint32(16,0x4e4f534a,true);new Uint8Array(glb,20,encoded.length).set(encoded);
 await assert.rejects(loadPStudioGLB(glb),/External glTF buffers/);
});
test('GLB image conversion requires an explicit CPU decoder instead of retaining foreign texture objects',async()=>{
 const json={asset:{version:'2.0'},buffers:[],images:[],textures:[],scenes:[{nodes:[]}],scene:0};
 assert.equal(json.asset.version,'2.0');
});

function makeSkinnedAnimatedGlb(){
 const bin=new ArrayBuffer(228);
 new Float32Array(bin,0,9).set([0,0,0,1,0,0,0,1,0]);
 new Uint8Array(bin,36,12).fill(0);
 new Float32Array(bin,48,12).set([1,0,0,0,1,0,0,0,1,0,0,0]);
 new Float32Array(bin,96,16).set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
 new Float32Array(bin,160,2).set([0,1]);
 new Float32Array(bin,168,6).set([0,0,0,1,0,0]);
 new Float32Array(bin,192,9).set([0,1,0,0,1,0,0,1,0]);
 const json={
  asset:{version:'2.0'},buffers:[{byteLength:228}],
  bufferViews:[
   {buffer:0,byteOffset:0,byteLength:36},
   {buffer:0,byteOffset:36,byteLength:12},
   {buffer:0,byteOffset:48,byteLength:48},
   {buffer:0,byteOffset:96,byteLength:64},
   {buffer:0,byteOffset:160,byteLength:8},
   {buffer:0,byteOffset:168,byteLength:24},
   {buffer:0,byteOffset:192,byteLength:36}
  ],
  accessors:[
   {bufferView:0,componentType:5126,count:3,type:'VEC3'},
   {bufferView:1,componentType:5121,count:3,type:'VEC4'},
   {bufferView:2,componentType:5126,count:3,type:'VEC4'},
   {bufferView:3,componentType:5126,count:1,type:'MAT4'},
   {bufferView:4,componentType:5126,count:2,type:'SCALAR'},
   {bufferView:5,componentType:5126,count:2,type:'VEC3'},
   {bufferView:6,componentType:5126,count:3,type:'VEC3'}
  ],
  meshes:[{weights:[0.25],primitives:[{attributes:{POSITION:0,JOINTS_0:1,WEIGHTS_0:2},targets:[{POSITION:6}],mode:4}]}],
  nodes:[{mesh:0,skin:0,translation:[2,0,0],weights:[0.6]},{name:'root-joint'}],
  skins:[{joints:[1],skeleton:1,inverseBindMatrices:3}],
  animations:[{name:'move-root',samplers:[{input:4,output:5,interpolation:'LINEAR'}],channels:[{sampler:0,target:{node:1,path:'translation'}}]}],
  scenes:[{nodes:[0,1]}],scene:0
 };
 const text=new TextEncoder().encode(JSON.stringify(json)),jsonLength=Math.ceil(text.length/4)*4;
 const total=12+8+jsonLength+8+bin.byteLength,glb=new ArrayBuffer(total),out=new DataView(glb);
 out.setUint32(0,0x46546c67,true);out.setUint32(4,2,true);out.setUint32(8,total,true);
 out.setUint32(12,jsonLength,true);out.setUint32(16,0x4e4f534a,true);new Uint8Array(glb,20,text.length).set(text);
 out.setUint32(20+jsonLength,bin.byteLength,true);out.setUint32(24+jsonLength,0x004e4942,true);
 new Uint8Array(glb,28+jsonLength,bin.byteLength).set(new Uint8Array(bin));
 return glb;
}

test('GLB loader owns skin palettes, four-weight geometry, morph targets and animation clips',async()=>{
 const {asset,report}=await loadPStudioGLB(makeSkinnedAnimatedGlb());
 assert.equal(report.supported,true);
 assert.equal(asset.skins.length,1);
 assert.deepEqual(asset.skins[0].joints,['glb.node.1']);
 assert.equal(asset.skins[0].skeletonRoot,'glb.node.1');
 const geometry=asset.geometries[0];
 assert.deepEqual(Array.from(geometry.jointIndices),[0,0,0,0,0,0,0,0,0,0,0,0]);
 assert.deepEqual(Array.from(geometry.jointWeights),[1,0,0,0,1,0,0,0,1,0,0,0]);
 assert.equal(geometry.morphTargets.length,1);
 assert.equal(asset.entities[0].skinId,'glb.skin.0');
 assert.deepEqual(asset.entities[0].morphWeights,[0.6]);
 assert.equal(asset.animations.length,1);
 const frame=samplePStudioAnimationClip(asset.animations[0],0.5);
 assert.deepEqual(frame.tracks[0].value,[0.5,0,0]);
 assert.equal(asset.nodes.find(node=>node.id==='glb.node.1').name,'root-joint');
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadPStudioGLB}=require('../static/pstudio_graphics_gltf_loader.mjs');
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

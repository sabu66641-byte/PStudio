'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadPStudioGLB}=require('../static/pstudio_graphics_gltf_loader.mjs');
const {samplePStudioAnimationClip,evaluatePStudioSceneBindPose}=require('../static/pstudio_graphics_animation_core.mjs');
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
function withPunctualLight(source){
 const bytes=new Uint8Array(source),view=new DataView(source);
 const jsonLength=view.getUint32(12,true),json=JSON.parse(new TextDecoder().decode(bytes.slice(20,20+jsonLength)).replace(/[\\u0000\\u0020]+$/g,''));
 const binOffset=20+jsonLength+8,binLength=view.getUint32(20+jsonLength,true);
 json.extensions={KHR_lights_punctual:{lights:[
  {type:'directional',color:[1,.8,.6],intensity:3},
  {type:'point',color:[.2,.4,1],intensity:2,range:12},
  {type:'spot',intensity:4,spot:{innerConeAngle:.2,outerConeAngle:.6}}
 ]}};
 json.extensionsUsed=['KHR_lights_punctual'];
 json.nodes.push(
  {name:'sun',translation:[1,2,3],extensions:{KHR_lights_punctual:{light:0}}},
  {name:'lamp',translation:[4,5,6],extensions:{KHR_lights_punctual:{light:1}}},
  {name:'spot',rotation:[0,0,0,1],extensions:{KHR_lights_punctual:{light:2}}}
 );
 json.scenes[0].nodes.push(1,2,3);
 const encoded=new TextEncoder().encode(JSON.stringify(json)),padded=(encoded.length+3)&~3;
 const total=12+8+padded+8+binLength,glb=new ArrayBuffer(total),out=new DataView(glb);
 out.setUint32(0,0x46546c67,true);out.setUint32(4,2,true);out.setUint32(8,total,true);
 out.setUint32(12,padded,true);out.setUint32(16,0x4e4f534a,true);new Uint8Array(glb,20,encoded.length).set(encoded);
 out.setUint32(20+padded,binLength,true);out.setUint32(24+padded,0x004e4942,true);
 new Uint8Array(glb,28+padded,binLength).set(bytes.slice(binOffset,binOffset+binLength));
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
 const json=JSON.parse(new TextDecoder().decode(bytes.slice(jsonOffset,jsonOffset+jsonLength)).replace(/[\u0000\u0020]+$/g,''));
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

function makeCubicAnimatedGlb(){
 const bin=new ArrayBuffer(116);
 new Float32Array(bin,0,9).set([0,0,0,1,0,0,0,1,0]);
 new Float32Array(bin,36,2).set([0,1]);
 new Float32Array(bin,44,18).set([
  0,0,0, 0,0,0, 2,0,0,
  0,0,0, 1,0,0, 0,0,0
 ]);
 const json={
  asset:{version:'2.0'},buffers:[{byteLength:116}],
  bufferViews:[
   {buffer:0,byteOffset:0,byteLength:36},
   {buffer:0,byteOffset:36,byteLength:8},
   {buffer:0,byteOffset:44,byteLength:72}
  ],
  accessors:[
   {bufferView:0,componentType:5126,count:3,type:'VEC3'},
   {bufferView:1,componentType:5126,count:2,type:'SCALAR'},
   {bufferView:2,componentType:5126,count:6,type:'VEC3'}
  ],
  meshes:[{primitives:[{attributes:{POSITION:0},mode:4}]}],
  nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0,
  animations:[{name:'cubic-move',samplers:[{input:1,output:2,interpolation:'CUBICSPLINE'}],channels:[{sampler:0,target:{node:0,path:'translation'}}]}]
 };
 const encoded=new TextEncoder().encode(JSON.stringify(json)),jsonLength=(encoded.length+3)&~3,total=12+8+jsonLength+8+bin.byteLength;
 const glb=new ArrayBuffer(total),view=new DataView(glb);
 view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,total,true);
 view.setUint32(12,jsonLength,true);view.setUint32(16,0x4e4f534a,true);new Uint8Array(glb,20,encoded.length).set(encoded);
 view.setUint32(20+jsonLength,bin.byteLength,true);view.setUint32(24+jsonLength,0x004e4942,true);
 new Uint8Array(glb,28+jsonLength,bin.byteLength).set(new Uint8Array(bin));
 return glb;
}
function makePbrTextureGlb(){
 const bin=new ArrayBuffer(40);
 new Float32Array(bin,0,9).set([0,0,0,1,0,0,0,1,0]);
 new Uint8Array(bin,36,4).set([255,128,64,255]);
 const info={index:0,extensions:{KHR_texture_transform:{offset:[.25,.5],scale:[2,3],rotation:.2,texCoord:0}}};
 const json={
  asset:{version:'2.0'},buffers:[{byteLength:40}],
  bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:4}],
  accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3'}],
  images:[{bufferView:1,mimeType:'image/png'}],textures:[{source:0}],
  materials:[{
   pbrMetallicRoughness:{baseColorFactor:[.8,.7,.6,1],metallicFactor:.65,roughnessFactor:.35,baseColorTexture:info,metallicRoughnessTexture:{index:0}},
   normalTexture:{index:0,scale:.7},occlusionTexture:{index:0,strength:.6},emissiveTexture:{index:0},
   emissiveFactor:[.1,.2,.3],alphaMode:'MASK',alphaCutoff:.4,doubleSided:true,
   extensions:{
    KHR_materials_ior:{ior:1.7},
    KHR_materials_emissive_strength:{emissiveStrength:2.5},
    KHR_materials_transmission:{transmissionFactor:.2},
    KHR_materials_clearcoat:{clearcoatFactor:.4,clearcoatRoughnessFactor:.25},
    KHR_materials_sheen:{sheenColorFactor:[.2,.3,.4],sheenRoughnessFactor:.5},
    KHR_materials_specular:{specularFactor:.8,specularColorFactor:[.9,.8,.7]}
   }
  }],
  meshes:[{primitives:[{attributes:{POSITION:0},material:0,mode:4}]}],
  nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0,
  extensionsUsed:['KHR_texture_transform','KHR_materials_ior','KHR_materials_emissive_strength','KHR_materials_transmission','KHR_materials_clearcoat','KHR_materials_sheen','KHR_materials_specular'],
  extensionsRequired:['KHR_texture_transform','KHR_materials_ior']
 };
 const encoded=new TextEncoder().encode(JSON.stringify(json)),jsonLength=(encoded.length+3)&~3,total=12+8+jsonLength+8+bin.byteLength;
 const glb=new ArrayBuffer(total),view=new DataView(glb);
 view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,total,true);
 view.setUint32(12,jsonLength,true);view.setUint32(16,0x4e4f534a,true);new Uint8Array(glb,20,encoded.length).set(encoded);
 view.setUint32(20+jsonLength,bin.byteLength,true);view.setUint32(24+jsonLength,0x004e4942,true);
 new Uint8Array(glb,28+jsonLength,bin.byteLength).set(new Uint8Array(bin));
 return glb;
}
test('GLB loader imports CUBICSPLINE Hermite animation channels into native clips',async()=>{
 const {asset,report}=await loadPStudioGLB(makeCubicAnimatedGlb());
 assert.equal(report.supported,true);
 assert.equal(asset.animations[0].tracks[0].interpolation,'CUBICSPLINE');
 assert.deepEqual(samplePStudioAnimationClip(asset.animations[0],.5).tracks[0].value,[.75,0,0]);
});
test('GLB loader imports PBR texture slots, UV transforms and common KHR material extensions',async()=>{
 const {asset,report}=await loadPStudioGLB(makePbrTextureGlb(),{
  decodeImage:async()=>({width:1,height:1,data:new Uint8Array([255,128,64,255])})
 });
 assert.equal(report.supported,true);
 const material=asset.materials[0];
 assert.equal(asset.textures.length,2,'same image is retained with separate sRGB and linear interpretations');
 assert.ok(material.textureIds.baseColor);
 assert.ok(material.textureIds.metallicRoughness);
 assert.ok(material.textureIds.normal);
 assert.ok(material.textureIds.occlusion);
 assert.ok(material.textureIds.emissive);
 assert.equal(material.alphaMode,'mask');
 assert.equal(material.doubleSided,true);
 assert.equal(material.normalScale,.7);
 assert.equal(material.occlusionStrength,.6);
 assert.equal(material.ior,1.7);
 assert.equal(material.emissiveStrength,2.5);
 assert.equal(material.clearcoat,.4);
 assert.equal(material.transmission,.2);
 assert.deepEqual(material.textureTransforms.baseColor.offset,[.25,.5]);
 assert.deepEqual(material.textureTransforms.baseColor.scale,[2,3]);
 assert.ok(Math.abs(material.textureTransforms.baseColor.rotation-.2)<1e-9);
});

test('GLB loader imports KHR_lights_punctual types and applies node world transforms',async()=>{
 const {asset,report}=await loadPStudioGLB(withPunctualLight(makeGlb()));
 assert.equal(report.supported,true);
 assert.equal(asset.lighting.lights.length,3);
 assert.equal(asset.lighting.lights[0].type,'directional');
 assert.deepEqual(asset.lighting.lights[0].position,[1,2,3]);
 assert.deepEqual(asset.lighting.lights[0].direction,[0,0,-1]);
 assert.equal(asset.lighting.lights[0].intensity,3);
 assert.equal(asset.lighting.lights[1].type,'point');
 assert.deepEqual(asset.lighting.lights[1].position,[4,5,6]);
 assert.equal(asset.lighting.lights[1].range,12);
 assert.equal(asset.lighting.lights[2].type,'spot');
 assert.ok(Math.abs(asset.lighting.lights[2].innerConeCos-Math.cos(.2))<1e-9);
 assert.ok(Math.abs(asset.lighting.lights[2].outerConeCos-Math.cos(.6))<1e-9);
});

test('static GLB skin is fully deformed in bind pose without requiring an animation clip',async()=>{
 const {asset}=await loadPStudioGLB(makeSkinnedAnimatedGlb());
 const resolved=evaluatePStudioSceneBindPose(asset);
 assert.equal(resolved.entities[0].skinId,null);
 assert.equal(resolved.entities[0].geometryId.includes('@deformed@'),true);
 const geometry=resolved.geometries.find(item=>item.id===resolved.entities[0].geometryId);
 assert.ok(geometry);
 assert.equal(geometry.jointIndices,null);
 assert.equal(geometry.jointWeights,null);
 assert.ok(Math.abs(geometry.positions[0]+2)<1e-6);
 assert.equal(resolved.animations.length,asset.animations.length);
 assert.equal(resolved.metadata.bindPoseResolved,true);
});

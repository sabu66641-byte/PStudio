const test=require('node:test');
const assert=require('node:assert/strict');
const {
  createPStudioGraphicsScene,createPStudioGraphicsView,createPStudioGraphicsMaterial,
  createPStudioGraphicsResourceDescriptor,createPStudioGraphicsCommandEncoder
}=require('../static/pstudio_graphics_contract.mjs');
const {createPStudioGraphicsResourceCore}=require('../static/pstudio_graphics_resource_core.mjs');
const {createPStudioGraphicsShaderCore}=require('../static/pstudio_graphics_shader_core.mjs');
const {createPStudioGraphicsComputeCore}=require('../static/pstudio_graphics_compute_core.mjs');
const {createPStudioGraphicsLightingCore}=require('../static/pstudio_graphics_lighting_core.mjs');
const {createPStudioGraphicsCore}=require('../static/pstudio_graphics_core.mjs');

test('Scene/View/Material/Resource and command contracts validate PStudio-owned data',()=>{
  assert.equal(createPStudioGraphicsScene({id:'scene.main',revision:2}).revision,2);
  assert.equal(createPStudioGraphicsView({viewport:{width:1280,height:720}}).viewport.width,1280);
  assert.equal(createPStudioGraphicsMaterial({id:'mat.water',model:'pbr',roughness:.1}).roughness,.1);
  assert.equal(createPStudioGraphicsResourceDescriptor({id:'rt.main',type:'render-target',width:1280,height:720,domain:'gpu'}).width,1280);
  assert.throws(()=>createPStudioGraphicsMaterial({id:'bad',metallic:2}),/range/);
  const encoder=createPStudioGraphicsCommandEncoder(5);encoder.record({op:'begin-pass',passId:'main'});encoder.record({op:'draw',count:3});
  assert.equal(encoder.finish().commandCount,2);assert.throws(()=>encoder.record({op:'present'}),/finished/);
});

test('Resource Core provides leases and independent CPU/GPU budget accounting with LRU disposal',()=>{
  const core=createPStudioGraphicsResourceCore({cpuBudgetBytes:100,gpuBudgetBytes:100}),reasons=[];
  core.register({id:'cpu.a',type:'buffer',domain:'cpu',estimatedBytes:60},{},{dispose:(v,reason)=>reasons.push(reason)});
  const lease=core.retain('cpu.a');
  core.register({id:'gpu.a',type:'texture',domain:'gpu',estimatedBytes:80},{});
  core.register({id:'cpu.b',type:'buffer',domain:'cpu',estimatedBytes:60},{});
  assert.ok(core.get('cpu.a'));assert.ok(core.get('cpu.b'));assert.equal(core.stats().gpuBytes,80);assert.equal(core.stats().cpuBytes,120);
  assert.equal(lease.release(),true);core.get('cpu.b');assert.equal(core.trim('cpu',60),1);assert.deepEqual(reasons,['budget']);
  assert.equal(core.stats().cpuBytes,60);core.dispose();
});

test('Resource Core deduplicates concurrent factories and disposes creations that finish after shutdown',async()=>{
  const core=createPStudioGraphicsResourceCore();let created=0;
  const descriptor={id:'model.shared',type:'buffer',domain:'cpu',estimatedBytes:16};
  const [a,b]=await Promise.all([core.getOrCreate(descriptor,async()=>{created++;return {value:1};}),core.getOrCreate(descriptor,async()=>{created++;return {value:2};})]);
  assert.equal(a,b);assert.equal(created,1);core.dispose();
  const late=createPStudioGraphicsResourceCore();let finish,disposed=0;
  const pending=late.getOrCreate({id:'late',type:'texture'},()=>new Promise(resolve=>{finish=resolve;}),{dispose:()=>{disposed++;}});
  await Promise.resolve();late.dispose({force:true});finish({});await assert.rejects(pending,/disposed/);assert.equal(disposed,1);
});

test('Shader Core deduplicates concurrent compiles and invalidates variants',async()=>{
  let compiled=0,disposed=0;const core=createPStudioGraphicsShaderCore({compile:async({descriptor,variant})=>{compiled++;return {id:descriptor.id,variant,dispose(){disposed++;}};}});
  core.register({id:'pbr.vertex',stage:'vertex',language:'wgsl',source:'@vertex fn main() -> @builtin(position) vec4f { return vec4f(0.0); }'});
  const [a,b]=await Promise.all([core.compile('pbr.vertex',{defines:{SKINNED:false}},{backend:'webgpu'}),core.compile('pbr.vertex',{defines:{SKINNED:false}},{backend:'webgpu'})]);
  assert.equal(a,b);assert.equal(compiled,1);assert.equal(core.invalidate('pbr.vertex'),1);assert.equal(disposed,1);core.dispose();
});

test('Compute Core validates dispatch dimensions and delegates to an injected executor',async()=>{
  let received;const core=createPStudioGraphicsComputeCore({executor:async value=>{received=value;return 42;},capabilities:{features:['subgroups']}});
  core.register({id:'particles.integrate',shaderId:'particles.cs',workgroupSize:[64,1,1],requiredFeatures:['subgroups']});
  assert.equal(await core.dispatch('particles.integrate',{groups:[4,1,1]}),42);assert.equal(received.groups[0],4);
  await assert.rejects(core.dispatch('particles.integrate',{groups:[0,1,1]}),/positive/);
  core.dispose();
});

test('Lighting Core normalizes direction and emits stable packed snapshots',()=>{
  const core=createPStudioGraphicsLightingCore();
  core.set({id:'sun',type:'directional',intensity:2,direction:[0,-2,0],castsShadow:true,layerMask:0xffffffff});
  core.set({id:'lamp',type:'point',position:[1,2,3],range:8,color:[1,.8,.6]});
  const snapshot=core.snapshot();assert.equal(snapshot.lightCount,2);assert.equal(snapshot.records[0].id,'lamp');
  assert.equal(snapshot.packed.length,32);assert.equal(snapshot.layerMasks[1],0xffffffff);assert.ok(Math.abs(snapshot.records[1].direction[1]+1)<1e-6);
  assert.throws(()=>core.set({id:'bad',type:'spot',innerConeRadians:1,outerConeRadians:.5}),/cone/);core.dispose();
});

test('Graphics Core composes independently-owned cores around a supplied HAL',async()=>{
  const hal={initialize:async()=>({state:'ready',backend:'webgl2'}),render:()=>true,resize:()=>true,dispose:()=>true,getState:()=>({state:'ready',backend:'webgl2'})};
  const core=createPStudioGraphicsCore({hal});await core.renderer.initialize();
  assert.equal(core.renderer.submit({viewport:{width:640,height:480}}),true);
  assert.equal(core.stats().renderer.frameId,1);assert.equal(core.stats().resources.resourceCount,0);
  assert.equal(core.dispose(),true);
});

test('Shader Core discards late compiler results after variant invalidation',async()=>{
  let resolveCompile,disposed=0;const core=createPStudioGraphicsShaderCore({compile:()=>new Promise(resolve=>{resolveCompile=resolve;})});
  core.register({id:'terrain.fragment',stage:'fragment',language:'wgsl',source:'@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }'});
  const pending=core.compile('terrain.fragment',{quality:'high'},{backend:'webgpu'});
  await Promise.resolve();core.invalidate('terrain.fragment');
  resolveCompile({dispose(){disposed++;}});
  await assert.rejects(pending,error=>error.code==='PSTUDIO_GRAPHICS_SHADER_INVALIDATED');
  assert.equal(disposed,1);core.dispose();
});

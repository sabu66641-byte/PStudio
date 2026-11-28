const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createPStudioGraphicsBackendDescriptor,createPStudioGraphicsFrame,assertPStudioGraphicsStateTransition,PSTUDIO_GRAPHICS_API_VERSION,createPStudioGraphicsScene,createPStudioGraphicsView,createPStudioGraphicsMaterial,createPStudioGraphicsCommandEncoder}=require('../static/pstudio_graphics_contract.mjs');
const {createPStudioGraphicsHAL}=require('../static/pstudio_graphics_hal.mjs');
const {createPStudioGraphicsEngine}=require('../static/pstudio_graphics_engine.mjs');
function makeAdapter({id,backend,priority=0,features=[],initialize,supports}={}){return {descriptor:createPStudioGraphicsBackendDescriptor({id,backend,priority,features}),supports,initialize:initialize||(async()=>({render:()=>true,dispose(){}}))};}

test('vendor-neutral contracts and state transitions are validated',()=>{
  assert.equal(PSTUDIO_GRAPHICS_API_VERSION,'0.2.0');
  const descriptor=createPStudioGraphicsBackendDescriptor({id:'test.webgpu',backend:'webgpu',features:['compute','timestamp-query','compute'],limits:{maxTextureDimension2D:8192,invalid:Infinity}});
  assert.deepEqual(descriptor.features,['compute','timestamp-query']);assert.equal(descriptor.limits.maxTextureDimension2D,8192);
  const frame=createPStudioGraphicsFrame({frameId:7,timeMs:100,deltaMs:16,viewport:{width:1280,height:720,pixelRatio:1.5}});
  assert.equal(frame.viewport.width,1280);assert.throws(()=>createPStudioGraphicsFrame({viewport:{width:0,height:720}}),/positive integers/);
  assert.equal(assertPStudioGraphicsStateTransition('idle','initializing'),true);assert.throws(()=>assertPStudioGraphicsStateTransition('disposed','ready'),/Invalid graphics lifecycle transition/);
  assert.equal(createPStudioGraphicsScene({id:'scene'}).id,'scene');assert.equal(createPStudioGraphicsView({viewport:{width:10,height:10}}).viewport.width,10);
  assert.equal(createPStudioGraphicsMaterial({id:'mat'}).model,'pbr');const encoder=createPStudioGraphicsCommandEncoder(1);encoder.record({op:'draw',count:3});assert.equal(encoder.finish().commandCount,1);
});

test('HAL selects compatible preferred backend and filters required capabilities',async()=>{
  const hal=createPStudioGraphicsHAL({preferredBackend:'webgpu'});let seen;
  hal.register(makeAdapter({id:'compat.gl',backend:'webgl2',features:['pbr'],priority:2}));
  hal.register(makeAdapter({id:'primary.gpu',backend:'webgpu',features:['pbr','compute'],initialize:async()=>({render:frame=>{seen=frame;return true;}})}));
  const result=await hal.initialize({requiredFeatures:['compute','pbr']});assert.equal(result.backend,'webgpu');
  assert.equal(hal.render({frameId:1}),true);assert.equal(seen.frameId,1);hal.dispose();
});

test('HAL reports explicit fallback and never substitutes when fallback is disabled',async()=>{
  const hal=createPStudioGraphicsHAL({preferredBackend:'webgpu'});
  hal.register(makeAdapter({id:'gpu.fail',backend:'webgpu',initialize:async()=>{throw new Error('primary failed');}}));
  hal.register(makeAdapter({id:'gl.fallback',backend:'webgl2'}));
  const result=await hal.initialize();assert.equal(result.state,'fallback');assert.equal(result.backend,'webgl2');assert.match(result.attempts[0].reason,/primary failed/);hal.dispose();
  const strict=createPStudioGraphicsHAL({preferredBackend:'webgpu',allowFallback:false});
  strict.register(makeAdapter({id:'gpu.unsupported',backend:'webgpu',supports:()=>false}));strict.register(makeAdapter({id:'gl.skipped',backend:'webgl2'}));
  await assert.rejects(strict.initialize(),error=>error.code==='PSTUDIO_GRAPHICS_NO_BACKEND');assert.ok(strict.getState().attempts.some(x=>x.reason==='fallback-disabled'));strict.dispose();
});

test('HAL detects device loss and only recovers through an explicit alternate adapter',async()=>{
  let lose,recovered=0;const hal=createPStudioGraphicsHAL({preferredBackend:'webgpu'});
  hal.register(makeAdapter({id:'gpu.adapter',backend:'webgpu',priority:10,initialize:async()=>({render:()=>true,deviceLost:new Promise(resolve=>{lose=resolve;}),dispose(){}})}));
  hal.register(makeAdapter({id:'gl.adapter',backend:'webgl2',priority:5,initialize:async()=>({render:()=>{recovered++;return true;},dispose(){}})}));
  await hal.initialize();lose({reason:'unknown',message:'test loss'});await Promise.resolve();
  assert.equal(hal.getState().state,'lost');assert.equal(hal.render({}),false);
  const result=await hal.recover();assert.equal(result.state,'fallback');assert.equal(result.backend,'webgl2');assert.equal(hal.render({}),true);assert.equal(recovered,1);hal.dispose();
});

test('HAL cancellation disposes late resources',async()=>{
  const hal=createPStudioGraphicsHAL({preferredBackend:'webgpu'});let resolve,disposed=0;
  hal.register(makeAdapter({id:'slow.adapter',backend:'webgpu',initialize:()=>new Promise(r=>{resolve=r;})}));
  const pending=hal.initialize();await Promise.resolve();hal.dispose();resolve({render:()=>true,dispose:()=>{disposed++;}});
  await assert.rejects(pending);assert.equal(disposed,1);
});

test('engine facade reports lost state and refuses frames until explicit recovery',async()=>{
  const hal=createPStudioGraphicsHAL({preferredBackend:'webgpu'});let lose;
  hal.register(makeAdapter({id:'gpu.adapter',backend:'webgpu',initialize:async()=>({render:()=>true,deviceLost:new Promise(resolve=>{lose=resolve;})})}));
  const engine=createPStudioGraphicsEngine({hal});await engine.initialize();
  assert.equal(engine.render({viewport:{width:8,height:8}}),true);lose({reason:'test'});await Promise.resolve();
  assert.equal(engine.getState().state,'lost');assert.equal(engine.render({viewport:{width:8,height:8}}),false);engine.dispose();
});

test('PStudio contracts and core modules remain independent of Three.js and browser globals',()=>{
  const root=path.join(__dirname,'..','static');
  for(const name of ['pstudio_graphics_contract.mjs','pstudio_graphics_hal.mjs','pstudio_graphics_engine.mjs','pstudio_graphics_resource_core.mjs','pstudio_graphics_shader_core.mjs','pstudio_graphics_compute_core.mjs','pstudio_graphics_lighting_core.mjs','pstudio_graphics_renderer_core.mjs','pstudio_graphics_core.mjs']){
    const source=fs.readFileSync(path.join(root,name),'utf8');assert.doesNotMatch(source,/from\s+['"]three(?:\/|['"])/,name);assert.doesNotMatch(source,/\b(?:window|document|GPUDevice|WebGLRenderer|WebGPURenderer)\b/,name);
  }
});

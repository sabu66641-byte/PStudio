const test=require('node:test');
const assert=require('node:assert/strict');
const {createPStudioWebGL2Adapter,createPStudioThreeWebGPUAdapter}=require('../static/pstudio_graphics_adapters.mjs');
const {createPStudioGraphicsHAL}=require('../static/pstudio_graphics_hal.mjs');

test('WebGL2 adapter wraps existing renderer without owning it by default',async()=>{
  const calls=[],listeners=new Map(),canvas={addEventListener:(n,fn)=>listeners.set(n,fn),removeEventListener:n=>listeners.delete(n)};
  const renderer={domElement:canvas,capabilities:{isWebGL2:true,maxTextureSize:8192},render:(s,c)=>calls.push(['render',s,c]),setPixelRatio:v=>calls.push(['ratio',v]),setSize:(w,h,u)=>calls.push(['size',w,h,u]),getContext:()=>null,dispose:()=>calls.push(['dispose'])};
  const scene={},camera={},hal=createPStudioGraphicsHAL({preferredBackend:'webgl2'});
  hal.register(createPStudioWebGL2Adapter({renderer,scene,camera}));await hal.initialize();
  assert.equal(hal.render({scene,view:{camera}}),true);assert.equal(hal.resize(640,480,1.5),true);
  assert.equal(calls[0][0],'render');assert.equal(calls[1][0],'ratio');hal.dispose();
  assert.equal(calls.some(call=>call[0]==='dispose'),false);assert.equal(listeners.size,0);
});

test('WebGL2 context loss is observable and adapter disposes only explicitly owned renderers',async()=>{
  const listeners=new Map();let disposed=0,prevented=0,loss=null;
  const canvas={addEventListener:(n,fn)=>listeners.set(n,fn),removeEventListener:n=>listeners.delete(n)};
  const renderer={domElement:canvas,render(){},getContext:()=>null,dispose(){disposed++;}};
  const hal=createPStudioGraphicsHAL({preferredBackend:'webgl2',onDeviceLost:info=>{loss=info;}});
  hal.register(createPStudioWebGL2Adapter({renderer,scene:{},camera:{},ownsRenderer:true}));
  await hal.initialize();listeners.get('webglcontextlost')?.({preventDefault(){prevented++;}});
  assert.equal(prevented,1);assert.equal(hal.getState().state,'lost');assert.equal(loss.reason,'webglcontextlost');
  await assert.rejects(hal.recover(),error=>error.code==='PSTUDIO_GRAPHICS_NO_BACKEND');
  assert.equal(hal.getState().state,'failed');assert.equal(disposed,1);hal.dispose();
});

test('WebGPU adapter wraps injected TSL scene session and forwards capabilities',async()=>{
  let renderCount=0,disposed=0;
  const adapter=createPStudioThreeWebGPUAdapter({createSession:async()=>({
    capabilities:{features:['pbr']},deviceLost:new Promise(()=>{}),
    render(){renderCount++;return true;},resize(){return true;},dispose(){disposed++;return true;}
  })});
  const hal=createPStudioGraphicsHAL({preferredBackend:'webgpu'});hal.register(adapter);
  await hal.initialize({canvas:{},scene:{},camera:{},navigatorRef:{}});
  assert.equal(hal.render({frameId:1}),true);assert.equal(renderCount,1);
  assert.equal(hal.getState().capabilities.features[0],'pbr');hal.dispose();assert.equal(disposed,1);
});

test('existing renderer HAL factory keeps WebGL2 as the default and only registers supplied adapters',async()=>{
  const {createPStudioGraphicsHALForExistingRenderers}=require('../static/pstudio_graphics_adapters.mjs');
  const renderer={render(){},domElement:{},getContext:()=>null};
  const hal=createPStudioGraphicsHALForExistingRenderers({webgl2:{renderer,scene:{},camera:{}}});
  assert.deepEqual(hal.listBackends().map(x=>x.backend),['webgl2']);
  assert.equal((await hal.initialize()).backend,'webgl2');hal.dispose();
});

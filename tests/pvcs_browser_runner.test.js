'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const CONTEXT=Object.freeze({backend:'webgl2',scene:'pvcs-browser-runner',quality:'high',renderWidth:640,renderHeight:360,renderPixelRatio:1,effects:{ao:true,ssr:false,volumetricClouds:true}});
function frame(){return{width:4,height:4,channels:4,data:new Uint8Array(64)};}
function stats(sequence=10){return{renderFrameSequence:sequence,cpuFrameMs:12.5,cpuRenderSubmitMs:5.5,estimatedGpuBytes:4096,gpuTimingFresh:false,gpuRenderMs:null,gpuRenderSampleSequence:0,gpuRenderSourceFrameSequence:0,gpuRenderSampleContext:null,gpuStageMetrics:{}};}
function fakeEngine(options={}){
 const state={profile:null,applied:0,rolledBack:0,sequence:10};
 return{state,getPerformanceStats(){return stats(state.sequence);},async capturePVCSFrame(){state.sequence++;const current=stats(state.sequence);Object.assign(current,options.metrics?.(state,current)||{});return{frame:frame(),context:CONTEXT,metrics:current};},
 applyPVCSFrameBudgetOverride(profile){state.profile=profile;state.applied++;return{applied:true,rollbackToken:Object.freeze({id:state.applied})};},
 rollbackPVCSFrameBudgetOverride(token){assert.ok(token);state.profile=null;state.rolledBack++;return true;}};
}
test('browser runner applies alternative profile, captures pixels and rolls back',async()=>{
 const{createPStudioPVCSBrowserRunner}=await import('../static/pstudio_pvcs_browser_runner.mjs');const engine=fakeEngine();
 const runner=createPStudioPVCSBrowserRunner({getEngine:()=>engine,settleFrames:0,maxWidth:64,maxHeight:36});
 const result=await runner.runVariant({variant:'alternative',domain:'cpu-frame',profile:{scale:.9},context:CONTEXT});
 assert.equal(result.metrics.cpuFrameMs,12.5);assert.equal(result.frame.data.length,64);assert.equal(engine.state.applied,1);assert.equal(engine.state.rolledBack,1);assert.equal(engine.state.profile,null);
});
test('browser runner rejects stale GPU metrics rather than substituting CPU timing',async()=>{
 const{createPStudioPVCSBrowserRunner}=await import('../static/pstudio_pvcs_browser_runner.mjs');const engine=fakeEngine();
 const runner=createPStudioPVCSBrowserRunner({getEngine:()=>engine,settleFrames:0,maxMetricFrames:2});
 await assert.rejects(runner.runVariant({variant:'baseline',domain:'gpu-frame',context:CONTEXT}),/fresh GPU-frame timer-query sample/);
});
test('browser runner accepts only fresh same-context GPU samples for the active variant',async()=>{
 const{createPStudioPVCSBrowserRunner}=await import('../static/pstudio_pvcs_browser_runner.mjs');
 const engine=fakeEngine({metrics:(state,current)=>({gpuTimingFresh:true,gpuRenderMs:7.25,gpuRenderSampleSequence:4,gpuRenderSourceFrameSequence:current.renderFrameSequence,gpuRenderSampleContext:CONTEXT})});
 const runner=createPStudioPVCSBrowserRunner({getEngine:()=>engine,settleFrames:0,maxMetricFrames:1});
 const result=await runner.runVariant({variant:'baseline',domain:'gpu-frame',context:CONTEXT});
 assert.equal(result.metrics.gpuRenderMs,7.25);assert.equal(result.metrics.gpuRenderSourceFrameSequence,11);
});
test('browser runner requires an explicit GPU stage and asynchronous operation',async()=>{
 const{createPStudioPVCSBrowserRunner}=await import('../static/pstudio_pvcs_browser_runner.mjs');const engine=fakeEngine();const runner=createPStudioPVCSBrowserRunner({getEngine:()=>engine,settleFrames:0});
 await assert.rejects(runner.runVariant({variant:'baseline',domain:'gpu-stage',context:CONTEXT}),/explicit stageId/);
 await assert.rejects(runner.runVariant({variant:'baseline',domain:'asynchronous',context:CONTEXT}),/explicit measureAsync/);
});
test('browser runner measures explicit asynchronous work and memory estimates',async()=>{
 const{createPStudioPVCSBrowserRunner}=await import('../static/pstudio_pvcs_browser_runner.mjs');const engine=fakeEngine();let now=20;
 const runner=createPStudioPVCSBrowserRunner({getEngine:()=>engine,settleFrames:0,now:()=>now,measureAsync:async()=>{now+=8;}});
 assert.equal((await runner.runVariant({variant:'baseline',domain:'asynchronous',context:CONTEXT})).metrics.asyncElapsedMs,8);
 assert.equal((await runner.runVariant({variant:'baseline',domain:'memory',context:CONTEXT})).metrics.memoryBytes,4096);
});
test('browser runner rolls back alternative profile even when capture fails',async()=>{
 const{createPStudioPVCSBrowserRunner}=await import('../static/pstudio_pvcs_browser_runner.mjs');const engine=fakeEngine();engine.capturePVCSFrame=async()=>{throw new Error('capture failed');};
 const runner=createPStudioPVCSBrowserRunner({getEngine:()=>engine,settleFrames:0});
 await assert.rejects(runner.runVariant({variant:'alternative',domain:'cpu-frame',profile:{scale:.95},context:CONTEXT}),/capture failed/);
 assert.equal(engine.state.rolledBack,1);assert.equal(engine.state.profile,null);
});

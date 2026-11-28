'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPStudioGraphicsRenderingSuite,getPStudioGraphicsRenderingPassOrder}=require('../static/pstudio_graphics_rendering_suite.mjs');

test('PStudio rendering suite defines canonical atmosphere-to-present graph order',()=>{
 const suite=createPStudioGraphicsRenderingSuite({width:1920,height:1080});
 assert.equal(suite.plan.passes.length,11);
 assert.equal(suite.passes[0],'pstudio.rendering.shadow-map');
 assert.equal(suite.passes.at(-1),'pstudio.rendering.tone-map-present');
 assert.ok(suite.shaderLibraries.atmosphere.includes('pstudioRayleighPhase'));
 assert.ok(suite.shaderLibraries.water.includes('pstudioWaterBeerLambert'));
 assert.deepEqual(getPStudioGraphicsRenderingPassOrder().map(x=>x.id).slice(0,3),['shadow-map','sky-atmosphere-ibl','depth-prepass']);
 suite.dispose();
});
test('PStudio rendering suite refuses to execute unbound passes instead of silently dropping effects',async()=>{
 const suite=createPStudioGraphicsRenderingSuite();
 await assert.rejects(suite.execute({outputSurface:{id:'surface'}}),error=>error.code==='PSTUDIO_RENDER_PASS_EXECUTOR_MISSING');
 suite.dispose();
});
test('PStudio rendering suite requires an explicit output and honors explicit feature switches',async()=>{
 const suite=createPStudioGraphicsRenderingSuite({features:{water:false,gi:false,volumetrics:false,shadows:false,post:false,atmosphere:false,opaque:false,depth:false,present:true},handlers:{'tone-map-present':async()=>true}});
 assert.equal(suite.passes.length,1);
 await assert.rejects(suite.execute(),/explicit outputSurface/);
 assert.equal((await suite.execute({outputSurface:{id:'canvas'}})).success,true);
 suite.dispose();
});
test('PStudio rendering suite uses explicit executor for each active stage',async()=>{
 const calls=[];
 const handlers=Object.fromEntries(getPStudioGraphicsRenderingPassOrder().map(x=>[x.id,async()=>{calls.push(x.id);return true;}]));
 const suite=createPStudioGraphicsRenderingSuite({handlers});
 const result=await suite.execute({outputSurface:{id:'canvas'}});
 assert.equal(result.success,true);
 assert.equal(calls.length,11);
 suite.dispose();
});

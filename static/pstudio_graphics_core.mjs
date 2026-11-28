import {createPStudioGraphicsRendererCore} from './pstudio_graphics_renderer_core.mjs';
import {createPStudioGraphicsResourceCore} from './pstudio_graphics_resource_core.mjs';
import {createPStudioGraphicsShaderCore} from './pstudio_graphics_shader_core.mjs';
import {createPStudioGraphicsComputeCore} from './pstudio_graphics_compute_core.mjs';
import {createPStudioGraphicsLightingCore} from './pstudio_graphics_lighting_core.mjs';
import {createPStudioGraphicsClusteredLightingCore} from './pstudio_graphics_clustered_lighting_core.mjs';
import {createPStudioRenderGraph} from './pstudio_render_graph.mjs';
import {PStudioGraphicsError} from './pstudio_graphics_contract.mjs';
import {createPStudioGraphicsSceneCore} from './pstudio_graphics_scene_core.mjs';
import {createPStudioGraphicsAssetCore} from './pstudio_graphics_asset_core.mjs';
/** Composition root for PStudio-owned graphics subsystems; GPU runtime attachment is opt-in. */
export function createPStudioGraphicsCore(options={}){
  if(!options.hal)throw new TypeError('Graphics Core requires a PStudio Graphics HAL.');
  const renderer=createPStudioGraphicsRendererCore({hal:options.hal,onStateChange:options.onStateChange});
  let gpuRuntime=options.gpuRuntime||null;
  const resources=createPStudioGraphicsResourceCore({...options.resources,backend:options.resources?.backend||gpuRuntime});
  const shaders=createPStudioGraphicsShaderCore({compile:input=>{
    if (options.compileShader) return options.compileShader(input);
    if (typeof gpuRuntime?.compileShader !== 'function') throw new PStudioGraphicsError('No GPU shader compiler is attached.',{code:'PSTUDIO_GRAPHICS_SHADER_COMPILER_UNAVAILABLE'});
    return gpuRuntime.compileShader(input);
  }});
  const compute=createPStudioGraphicsComputeCore({executor:input=>{
    if (options.computeExecutor) return options.computeExecutor(input);
    if (typeof gpuRuntime?.dispatchCompute !== 'function') throw new PStudioGraphicsError('No GPU compute executor is attached.',{code:'PSTUDIO_GRAPHICS_COMPUTE_EXECUTOR_UNAVAILABLE'});
    return gpuRuntime.dispatchCompute(input);
  },capabilities:options.computeCapabilities||(gpuRuntime?.getCapabilities?.()||null),maxWorkgroupInvocations:options.maxWorkgroupInvocations,maxWorkgroupsPerDimension:options.maxWorkgroupsPerDimension});
  const lighting=createPStudioGraphicsLightingCore({maxLights:options.maxLights,uploadSnapshot:options.uploadLightingSnapshot||((value)=>{
    if (typeof gpuRuntime?.uploadLightingSnapshot !== 'function') throw new PStudioGraphicsError('No GPU lighting uploader is attached.',{code:'PSTUDIO_GRAPHICS_LIGHTING_UPLOAD_UNAVAILABLE'});
    return gpuRuntime.uploadLightingSnapshot(value);
  })});
  const clusteredLighting=createPStudioGraphicsClusteredLightingCore({maxClusters:options.maxClusters,maxLightsPerCluster:options.maxLightsPerCluster,uploadSnapshot:options.uploadClusteredLightingSnapshot||((value)=>{
    if (typeof gpuRuntime?.uploadClusteredLightingSnapshot !== 'function') throw new PStudioGraphicsError('No GPU clustered-lighting uploader is attached.',{code:'PSTUDIO_GRAPHICS_CLUSTERED_LIGHTING_UPLOAD_UNAVAILABLE'});
    return gpuRuntime.uploadClusteredLightingSnapshot(value);
  })});
  const renderGraph=options.renderGraph||createPStudioRenderGraph(options.renderGraphOptions);
  const scene=options.scene||createPStudioGraphicsSceneCore(options.sceneOptions);
  const assets=options.assets||createPStudioGraphicsAssetCore(options.assetOptions);
  const computePipelineRecipes=new Map(),renderPipelineRecipes=new Map();
  let disposed=false,recoveryInProgress=false;
  function stats(){return Object.freeze({renderer:renderer.getState(),resources:resources.stats(),assets:assets.stats(),scene:scene.stats(),shaders:shaders.stats(),compute:compute.stats(),lighting:lighting.stats(),clusteredLighting:clusteredLighting.stats(),renderGraph:renderGraph.stats(),gpuRuntime:gpuRuntime?.stats?.()||null,pipelines:Object.freeze({compute:computePipelineRecipes.size,render:renderPipelineRecipes.size}),recoveryInProgress});}
  async function compileShader(id,variant={},context={}){if(disposed)throw new PStudioGraphicsError('Graphics Core is disposed.',{code:'PSTUDIO_GRAPHICS_CORE_DISPOSED'});return shaders.compile(id,variant,context);}
  async function createComputePipeline(id,descriptor={}){if(disposed)throw new PStudioGraphicsError('Graphics Core is disposed.',{code:'PSTUDIO_GRAPHICS_CORE_DISPOSED'});if(!shaders.get(id))throw new TypeError('Compute pipelines require a registered PStudio shader.');if(!shaders.isCompiled(id))await shaders.compile(id,descriptor.variant||{},descriptor.context||{backend:gpuRuntime?.backend||'webgpu'});if(typeof gpuRuntime?.createComputePipeline!=='function')throw new PStudioGraphicsError('No GPU compute-pipeline compiler is attached.',{code:'PSTUDIO_GRAPHICS_PIPELINE_BACKEND_UNAVAILABLE'});const pipeline=await gpuRuntime.createComputePipeline(id,descriptor);computePipelineRecipes.set(String(id),{...descriptor});return pipeline;}
  async function createRenderPipeline(id,descriptor={}){if(disposed)throw new PStudioGraphicsError('Graphics Core is disposed.',{code:'PSTUDIO_GRAPHICS_CORE_DISPOSED'});if(!descriptor.vertex?.shaderId||(descriptor.fragment&&!descriptor.fragment.shaderId))throw new TypeError('PStudio Graphics Core render pipelines require registered vertex and fragment shader ids for device recovery.');if(!shaders.get(descriptor.vertex.shaderId)|| (descriptor.fragment&&!shaders.get(descriptor.fragment.shaderId)))throw new TypeError('Render pipeline shader ids must be registered in PStudio Shader Core.');if(!shaders.isCompiled(descriptor.vertex.shaderId))await shaders.compile(descriptor.vertex.shaderId,{}, {backend:gpuRuntime?.backend||'webgpu'});if(descriptor.fragment&&!shaders.isCompiled(descriptor.fragment.shaderId))await shaders.compile(descriptor.fragment.shaderId,{}, {backend:gpuRuntime?.backend||'webgpu'});if(typeof gpuRuntime?.createRenderPipeline!=='function')throw new PStudioGraphicsError('No GPU render-pipeline compiler is attached.',{code:'PSTUDIO_GRAPHICS_PIPELINE_BACKEND_UNAVAILABLE'});const pipeline=await gpuRuntime.createRenderPipeline(id,descriptor);renderPipelineRecipes.set(String(id),{...descriptor,vertex:{...(descriptor.vertex||{})},fragment:{...(descriptor.fragment||{})}});return pipeline;}
  async function rehydrateGPUResources(){if(disposed)throw new PStudioGraphicsError('Graphics Core is disposed.',{code:'PSTUDIO_GRAPHICS_CORE_DISPOSED'});return resources.rehydrateGPU();}
  async function recoverGPUBackend(nextRuntime,context={}){
    if(disposed)throw new PStudioGraphicsError('Graphics Core is disposed.',{code:'PSTUDIO_GRAPHICS_CORE_DISPOSED'});
    if(recoveryInProgress)throw new PStudioGraphicsError('GPU backend recovery is already in progress.',{code:'PSTUDIO_GRAPHICS_RECOVERY_BUSY'});
    if(!nextRuntime||typeof nextRuntime.createResource!=='function')throw new TypeError('A replacement GPU runtime with createResource() is required.');
    recoveryInProgress=true;
    try{
      if(typeof nextRuntime.initialize==='function')await nextRuntime.initialize(context);
      gpuRuntime=nextRuntime;
      resources.setBackend(nextRuntime);
      compute.setCapabilities(nextRuntime.getCapabilities?.()||null);
      shaders.invalidateAll();
      const shaderResult=await shaders.recompileAll({backend:nextRuntime.backend||'webgpu'});
      const resourceResult=await resources.rehydrateGPU();
      let computeRestored=0,renderRestored=0;
      for(const [id,descriptor] of computePipelineRecipes){if(typeof nextRuntime.createComputePipeline!=='function')throw new PStudioGraphicsError('Replacement backend cannot recreate compute pipelines.',{code:'PSTUDIO_GRAPHICS_PIPELINE_REHYDRATE_UNAVAILABLE'});await nextRuntime.createComputePipeline(id,descriptor);computeRestored++;}
      for(const [id,descriptor] of renderPipelineRecipes){if(typeof nextRuntime.createRenderPipeline!=='function')throw new PStudioGraphicsError('Replacement backend cannot recreate render pipelines.',{code:'PSTUDIO_GRAPHICS_PIPELINE_REHYDRATE_UNAVAILABLE'});await nextRuntime.createRenderPipeline(id,descriptor);renderRestored++;}
      const pipelineResult=Object.freeze({computePipelinesRestored:computeRestored,renderPipelinesRestored:renderRestored});
      const lightingResult=lighting.stats().lightCount?await lighting.upload():null;
      const clusterResult=clusteredLighting.stats().configured?await clusteredLighting.upload():null;
      return Object.freeze({success:true,shaderResult,resourceResult,pipelineResult,lightingUploaded:!!lightingResult,clusteredLightingUploaded:!!clusterResult,backend:nextRuntime.getCapabilities?.().backend||nextRuntime.backend||'unknown'});
    }catch(error){
      throw new PStudioGraphicsError('GPU backend recovery did not complete; the replacement backend remains attached for explicit retry or disposal.',{code:'PSTUDIO_GRAPHICS_RECOVERY_FAILED',details:{cause:String(error?.message||error)}});
    }finally{recoveryInProgress=false;}
  }
  function dispose({forceResources=false}={}){
    if(disposed)return false;
    if(resources.stats().retainedCount>0&&!forceResources)throw new PStudioGraphicsError('Graphics Core has retained resources; release them or request forceResources.',{code:'PSTUDIO_GRAPHICS_CORE_RESOURCE_LEASES'});
    if(assets.stats().retainedCount>0&&!forceResources)throw new PStudioGraphicsError('Graphics Core has retained assets; release them or request forceResources.',{code:'PSTUDIO_GRAPHICS_CORE_ASSET_LEASES'});
    if(compute.stats().inFlight>0)throw new PStudioGraphicsError('Graphics Core has active compute dispatches.',{code:'PSTUDIO_GRAPHICS_COMPUTE_IN_FLIGHT'});
    assets.dispose({force:forceResources});scene.dispose();renderGraph.dispose();compute.dispose();shaders.dispose();lighting.dispose();clusteredLighting.dispose();resources.dispose({force:forceResources});renderer.dispose();disposed=true;return true;
  }
  return Object.freeze({kind:'pstudio-graphics-core',renderer,resources,assets,scene,shaders,compute,lighting,clusteredLighting,renderGraph,get gpuRuntime(){return gpuRuntime;},stats,compileShader,createComputePipeline,createRenderPipeline,rehydrateGPUResources,recoverGPUBackend,dispose});
}

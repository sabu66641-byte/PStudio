import {createPStudioGraphicsRendererCore} from './pstudio_graphics_renderer_core.mjs';
import {createPStudioGraphicsResourceCore} from './pstudio_graphics_resource_core.mjs';
import {createPStudioGraphicsShaderCore} from './pstudio_graphics_shader_core.mjs';
import {createPStudioGraphicsComputeCore} from './pstudio_graphics_compute_core.mjs';
import {createPStudioGraphicsLightingCore} from './pstudio_graphics_lighting_core.mjs';
import {PStudioGraphicsError} from './pstudio_graphics_contract.mjs';
/** Composition root for the first PStudio-owned Graphics Core vertical slice. */
export function createPStudioGraphicsCore(options={}){
  if(!options.hal)throw new TypeError('Graphics Core requires a PStudio Graphics HAL.');
  const renderer=createPStudioGraphicsRendererCore({hal:options.hal,onStateChange:options.onStateChange});
  const resources=createPStudioGraphicsResourceCore(options.resources);
  const shaders=createPStudioGraphicsShaderCore({compile:options.compileShader});
  const compute=createPStudioGraphicsComputeCore({executor:options.computeExecutor,capabilities:options.computeCapabilities,maxWorkgroupInvocations:options.maxWorkgroupInvocations,maxWorkgroupsPerDimension:options.maxWorkgroupsPerDimension});
  const lighting=createPStudioGraphicsLightingCore({maxLights:options.maxLights});let disposed=false;
  function stats(){return Object.freeze({renderer:renderer.getState(),resources:resources.stats(),shaders:shaders.stats(),compute:compute.stats(),lighting:lighting.stats()});}
  function dispose({forceResources=false}={}){
    if(disposed)return false;
    if(resources.stats().retainedCount>0&&!forceResources)throw new PStudioGraphicsError('Graphics Core has retained resources; release them or request forceResources.',{code:'PSTUDIO_GRAPHICS_CORE_RESOURCE_LEASES'});
    if(compute.stats().inFlight>0)throw new PStudioGraphicsError('Graphics Core has active compute dispatches.',{code:'PSTUDIO_GRAPHICS_COMPUTE_IN_FLIGHT'});
    compute.dispose();shaders.dispose();lighting.dispose();resources.dispose({force:forceResources});renderer.dispose();disposed=true;return true;
  }
  return Object.freeze({kind:'pstudio-graphics-core',renderer,resources,shaders,compute,lighting,stats,dispose});
}

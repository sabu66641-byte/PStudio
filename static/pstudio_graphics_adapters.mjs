import {createPStudioWebGPUSceneSession} from './pstudio_rendering_migration.mjs?v=20261126-genesis-water-live-v1';
import {isPStudioWebGPUAvailable} from './pstudio_rendering_backend.mjs';
import {createPStudioGraphicsHAL} from './pstudio_graphics_hal.mjs';

function positive(value,fallback){const n=Number(value);return Number.isFinite(n)&&n>0?n:fallback;}
function waitForWebGL2Fence(gl,timeoutMs=2000){
  if(!gl?.fenceSync||!gl?.clientWaitSync||!gl?.deleteSync)return Promise.resolve(false);
  const sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);if(!sync)return Promise.resolve(false);gl.flush?.();
  const started=Date.now(),timeout=positive(timeoutMs,2000);
  return new Promise((resolve,reject)=>{
    let settled=false;const finish=(value,error)=>{if(settled)return;settled=true;try{gl.deleteSync(sync);}catch(_){}if(error)reject(error);else resolve(value);};
    const poll=()=>{if(settled)return;try{const result=gl.clientWaitSync(sync,0,0);if(result===gl.ALREADY_SIGNALED||result===gl.CONDITION_SATISFIED)return finish(true);if(result===gl.WAIT_FAILED)return finish(false);if(Date.now()-started>=timeout)return finish(false);setTimeout(poll,8);}catch(error){finish(false,error);}};
    poll();
  });
}

/** Wraps a PStudio3D-owned WebGL2 renderer; it is borrowed unless ownsRenderer is true. */
export function createPStudioWebGL2Adapter(options={}){
  return Object.freeze({
    descriptor:Object.freeze({id:String(options.id||'pstudio.webgl2.legacy'),backend:'webgl2',priority:Number.isFinite(Number(options.priority))?Number(options.priority):0,features:Object.freeze([...(options.features||[])].map(String)),metadata:Object.freeze({implementation:'PStudio3D-owned WebGL2 compatibility renderer'})}),
    supports(context={}){const renderer=context.renderer||options.renderer||options.getRenderer?.();return typeof renderer?.render==='function'&&(typeof options.supports!=='function'||options.supports(context,renderer)!==false);},
    async initialize(context={}){
      const renderer=context.renderer||options.renderer||options.getRenderer?.();if(!renderer||typeof renderer.render!=='function')throw new TypeError('An existing PStudio-owned WebGL2 renderer is required.');
      const scene=context.scene||options.scene||options.getScene?.(),camera=context.camera||options.camera||options.getCamera?.();if(!scene||!camera)throw new TypeError('WebGL2 adapter requires the existing scene and camera.');
      const canvas=renderer.domElement||options.canvas,gl=renderer.getContext?.()||null;let disposed=false,lossHandler=null,restoreHandler=null;
      if(canvas?.addEventListener){lossHandler=event=>{try{event.preventDefault?.();}catch(_){}try{context.onDeviceLost?.({reason:'webglcontextlost',message:'WebGL2 context was lost.'});}catch(_){}try{options.onContextLost?.(event);}catch(_){}};restoreHandler=event=>{try{options.onContextRestored?.(event);}catch(_){}};canvas.addEventListener('webglcontextlost',lossHandler,false);canvas.addEventListener('webglcontextrestored',restoreHandler,false);}
      return Object.freeze({
        backend:'webgl2',renderer,
        render(frame){if(disposed)return false;renderer.render(frame?.scene||scene,frame?.view?.camera||camera);return true;},
        resize(w,h,r=1){if(disposed)return false;renderer.setPixelRatio?.(positive(r,1));renderer.setSize?.(Math.max(1,Math.floor(w)),Math.max(1,Math.floor(h)),false);return true;},
        waitIdle:()=>waitForWebGL2Fence(gl,options.syncTimeoutMs),
        getCapabilities:()=>renderer.capabilities?Object.freeze({isWebGL2:renderer.capabilities.isWebGL2===true,maxTextureSize:renderer.capabilities.maxTextureSize||null,maxSamples:renderer.capabilities.maxSamples||null}):null,
        dispose(){if(disposed)return false;disposed=true;if(canvas?.removeEventListener){if(lossHandler)canvas.removeEventListener('webglcontextlost',lossHandler,false);if(restoreHandler)canvas.removeEventListener('webglcontextrestored',restoreHandler,false);}if(options.ownsRenderer===true)renderer.dispose?.();return true;}
      });
    }
  });
}

/** Wraps the current Three.js r187 WebGPU/TSL scene session. */
export function createPStudioThreeWebGPUAdapter(options={}){
  const createSession=options.createSession||createPStudioWebGPUSceneSession;
  return Object.freeze({
    descriptor:Object.freeze({id:String(options.id||'pstudio.three-r187.webgpu'),backend:'webgpu',priority:Number.isFinite(Number(options.priority))?Number(options.priority):100,features:Object.freeze([...(options.features||['scene-session','pbr-material-conversion','tsl-pipeline'])].map(String)),metadata:Object.freeze({implementation:'Three.js r187 WebGPURenderer + PStudio TSL scene session',vendorNeutral:false})}),
    supports(context={}){const nav=context.navigatorRef||options.navigatorRef||globalThis.navigator;return !!(context.canvas||options.canvas)&&(!!(context.scene||options.scene))&&(!!(context.camera||options.camera))&&(options.createSession?true:isPStudioWebGPUAvailable(nav));},
    async initialize(context={}){
      const canvas=context.canvas||options.canvas,scene=context.scene||options.scene,camera=context.camera||options.camera;if(!canvas||!scene||!camera)throw new TypeError('WebGPU adapter requires canvas, scene and camera.');
      let disposed=false;
      const session=await createSession({...options.sessionOptions,canvas,scene,camera,navigatorRef:context.navigatorRef||options.navigatorRef,signal:context.signal,antialias:options.antialias===true,alpha:options.alpha===true,powerPreference:options.powerPreference||'high-performance',environmentProfile:options.environmentProfile,environmentResolution:options.environmentResolution,pipelineOptions:options.pipelineOptions,csm:options.csm,clusteredLightingOptions:options.clusteredLightingOptions,clusteredLightingSnapshot:options.clusteredLightingSnapshot,getClusteredLightingSnapshot:options.getClusteredLightingSnapshot,configureRenderer:options.configureRenderer,onStageChange:options.onStageChange,onDeviceLost:info=>{try{context.onDeviceLost?.(info);}catch(_){}try{options.onDeviceLost?.(info);}catch(_){}}});
      const device=session.renderer?.backend?.device;
      return Object.freeze({
        backend:'webgpu',renderer:session.renderer,capabilities:session.capabilities,deviceLost:session.deviceLost,
        render(frame){if(disposed)return false;if(options.beforeFrame?.(frame,{scene,camera,session})===false)return false;return session.render()!==false;},
        resize:(w,h,r)=>!disposed&&session.resize(w,h,r)!==false,
        waitIdle:()=>device?.queue?.onSubmittedWorkDone?device.queue.onSubmittedWorkDone():Promise.resolve(false),
        getCapabilities:()=>session.capabilities||null,
        dispose(){if(disposed)return false;disposed=true;return session.dispose?.()!==false;}
      });
    }
  });
}
export function createPStudioGraphicsHALForExistingRenderers(options={}){
  const hal=createPStudioGraphicsHAL({preferredBackend:options.preferredBackend||'webgl2',backendOrder:options.backendOrder||['webgl2','webgpu'],allowFallback:options.allowFallback!==false,onStateChange:options.onStateChange,onDeviceLost:options.onDeviceLost});
  if(options.webgl2)hal.register(createPStudioWebGL2Adapter(options.webgl2));
  if(options.webgpu)hal.register(createPStudioThreeWebGPUAdapter(options.webgpu));
  return hal;
}

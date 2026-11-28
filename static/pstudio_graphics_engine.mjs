import {createPStudioGraphicsFrame,PStudioGraphicsError} from './pstudio_graphics_contract.mjs';
export function createPStudioGraphicsEngine(options={}){
  const hal=options.hal;
  if(!hal||typeof hal.initialize!=='function'||typeof hal.render!=='function'||typeof hal.resize!=='function'||typeof hal.dispose!=='function'||typeof hal.getState!=='function')throw new TypeError('A compatible PStudio Graphics HAL instance is required.');
  let state='idle',disposed=false,initialization=null,lastError=null;
  function snapshot(extra={}){const s=hal.getState();return Object.freeze({state:s.state==='lost'?'lost':state,backend:s.backend||null,lastError:lastError?String(lastError.message||lastError):null,hal:s,...extra});}
  function publish(next,extra={}){state=next;try{options.onStateChange?.(snapshot(extra));}catch(_){}}
  async function initialize(context={}){if(disposed)throw new PStudioGraphicsError('Graphics engine is disposed.',{code:'PSTUDIO_GRAPHICS_DISPOSED'});if(['ready','fallback'].includes(state)&&hal.getState().state!=='lost')return snapshot();if(initialization)return initialization;publish('initializing');initialization=(async()=>{try{const result=await hal.initialize(context);const next=result?.state==='fallback'?'fallback':'ready';publish(next,{selectedBackend:result?.backend||null});return snapshot();}catch(error){if(disposed)throw error;lastError=error;publish('failed');throw error;}})().finally(()=>{initialization=null;});return initialization;}
  function render(input){if(disposed||!['ready','fallback'].includes(state)||hal.getState().state==='lost')return false;return hal.render(createPStudioGraphicsFrame(input));}
  function resize(w,h,r=1){if(disposed||!['ready','fallback'].includes(state)||hal.getState().state==='lost')return false;return hal.resize(w,h,r);}
  async function recover(cause){if(disposed||typeof hal.recover!=='function')return false;publish('initializing',{recovery:true});try{const result=await hal.recover(cause);if(!result)return false;const next=result.state==='fallback'?'fallback':'ready';publish(next,{selectedBackend:result.backend||null,recovered:true});return snapshot();}catch(error){lastError=error;publish('failed');throw error;}}
  function dispose(){if(disposed)return false;disposed=true;try{hal.dispose();}finally{publish('disposed');}return true;}
  return Object.freeze({kind:'pstudio-independent-graphics-engine',apiVersion:'0.2.0',initialize,render,resize,recover,waitIdle:arg=>hal.waitIdle?.(arg)??Promise.resolve(false),getState:()=>snapshot(),dispose});
}

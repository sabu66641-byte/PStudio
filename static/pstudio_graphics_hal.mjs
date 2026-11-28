import {PStudioGraphicsError,assertPStudioGraphicsStateTransition,validatePStudioGraphicsBackendAdapter} from './pstudio_graphics_contract.mjs';

export function createPStudioGraphicsHAL(options={}){
  const adapters=new Map();let state='idle',active=null,initialization=null,generation=0,disposed=false,lastError=null,attempts=[],controller=new AbortController(),lastContext={};
  function snapshot(extra={}){return Object.freeze({state,backend:active?.descriptor.backend||null,adapterId:active?.descriptor.id||null,lastError:lastError?String(lastError.message||lastError):null,capabilities:active?.handle?.getCapabilities?.()||active?.handle?.capabilities||null,attempts:Object.freeze(attempts.map(item=>Object.freeze({...item}))),...extra});}
  function publish(nextState,extra={}){assertPStudioGraphicsStateTransition(state,nextState);state=nextState;try{options.onStateChange?.(snapshot(extra));}catch(_){}}
  function assertMutable(){if(disposed||state==='disposed')throw new PStudioGraphicsError('Graphics HAL is disposed.',{code:'PSTUDIO_GRAPHICS_DISPOSED'});if(state==='initializing'||active)throw new PStudioGraphicsError('Backend registry cannot change while the HAL is active.',{code:'PSTUDIO_GRAPHICS_REGISTRY_LOCKED'});}
  function register(adapter){assertMutable();const item=validatePStudioGraphicsBackendAdapter(adapter);if(adapters.has(item.descriptor.id))throw new PStudioGraphicsError('Graphics backend adapter already registered: '+item.descriptor.id,{code:'PSTUDIO_GRAPHICS_DUPLICATE_ADAPTER'});adapters.set(item.descriptor.id,item);return item.descriptor;}
  function unregister(id){assertMutable();return adapters.delete(String(id||'').trim().toLowerCase());}
  function listBackends(){return Object.freeze([...adapters.values()].map(item=>item.descriptor).sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id)));}
  function orderedCandidates(context){
    const excluded=new Set(context.excludeAdapterIds||[]),available=[...adapters.values()].filter(item=>!excluded.has(item.descriptor.id));
    if(context.recovery===true)return available.sort((a,b)=>b.descriptor.priority-a.descriptor.priority||a.descriptor.id.localeCompare(b.descriptor.id));
    const preferred=context.preferredBackend||options.preferredBackend||null,order=Array.isArray(context.backendOrder)?context.backendOrder:Array.isArray(options.backendOrder)?options.backendOrder:[];
    const ranking=[...new Set([preferred,...order].filter(Boolean).map(v=>String(v).toLowerCase()))],rank=item=>{const i=ranking.indexOf(item.descriptor.backend);return i<0?Number.MAX_SAFE_INTEGER:i;};
    return available.sort((a,b)=>rank(a)-rank(b)||b.descriptor.priority-a.descriptor.priority||a.descriptor.id.localeCompare(b.descriptor.id));
  }
  function isCurrent(ticket){return !disposed&&ticket===generation&&!controller.signal.aborted;}
  function reportDeviceLost(info,ticket,descriptor,handleRef=null){
    if(!isCurrent(ticket)||(handleRef&&active?.handle!==handleRef))return;
    if(state!=='ready'&&state!=='fallback')return;
    const detail=Object.freeze({backend:descriptor.backend,adapterId:descriptor.id,reason:info?.reason||'unknown',message:String(info?.message||'Graphics device/context was lost.')});
    lastError=new PStudioGraphicsError(detail.message,{code:'PSTUDIO_GRAPHICS_DEVICE_LOST',backend:descriptor.backend,details:detail});
    publish('lost',{deviceLoss:detail});try{options.onDeviceLost?.(detail);}catch(_){}
  }
  function watchDeviceLoss(handle,ticket,descriptor){
    const lost=handle?.deviceLost||handle?.lost;if(!lost||typeof lost.then!=='function')return;
    Promise.resolve(lost).then(info=>{if(info?.reason!=='destroyed')reportDeviceLost(info,ticket,descriptor,handle);}).catch(error=>reportDeviceLost({reason:'unknown',message:error?.message||error},ticket,descriptor,handle));
  }
  function normalizeFeatures(context){const value=context.requiredFeatures??options.requiredFeatures??[];if(!Array.isArray(value))throw new TypeError('requiredFeatures must be an array of feature names.');return [...new Set(value.map(v=>String(v).trim().toLowerCase()).filter(Boolean))];}
  async function initialize(context={}){
    if(disposed)throw new PStudioGraphicsError('Graphics HAL is disposed.',{code:'PSTUDIO_GRAPHICS_DISPOSED'});
    if(active&&state!=='lost')return snapshot();if(initialization)return initialization;
    const ticket=++generation,requiredFeatures=normalizeFeatures(context),allowFallback=context.allowFallback??options.allowFallback??true,candidates=orderedCandidates(context);
    attempts=[];lastError=null;controller=new AbortController();lastContext={...context};delete lastContext.signal;
    const externalSignal=context.signal,abortFromExternal=()=>controller.abort(externalSignal?.reason);
    if(externalSignal){if(externalSignal.aborted)abortFromExternal();else externalSignal.addEventListener('abort',abortFromExternal,{once:true});}
    publish('initializing',{requiredFeatures:Object.freeze(requiredFeatures),recovery:context.recovery===true});
    initialization=(async()=>{
      try{
        const eligible=[];
        for(const item of candidates){
          const missing=requiredFeatures.filter(feature=>!item.descriptor.features.includes(feature));
          if(missing.length){attempts.push({adapterId:item.descriptor.id,backend:item.descriptor.backend,status:'skipped',reason:'missing-features',missingFeatures:missing});continue;}
          let supported=true;
          try{if(item.adapter.supports)supported=item.adapter.supports(Object.freeze({...context,requiredFeatures:Object.freeze(requiredFeatures)}))!==false;}
          catch(error){supported=false;attempts.push({adapterId:item.descriptor.id,backend:item.descriptor.backend,status:'skipped',reason:String(error?.message||error)});}
          if(supported)eligible.push(item);else if(!attempts.some(entry=>entry.adapterId===item.descriptor.id))attempts.push({adapterId:item.descriptor.id,backend:item.descriptor.backend,status:'skipped',reason:'adapter-not-supported'});
        }
        const primaryBackend=context.recovery===true?candidates[0]?.descriptor.backend:String(context.preferredBackend||options.preferredBackend||context.backendOrder?.[0]||options.backendOrder?.[0]||candidates[0]?.descriptor.backend||'').toLowerCase();
        const selected=allowFallback?eligible:eligible.filter(item=>item.descriptor.backend===primaryBackend).slice(0,1);
        if(!allowFallback)for(const item of eligible)if(!selected.includes(item))attempts.push({adapterId:item.descriptor.id,backend:item.descriptor.backend,status:'skipped',reason:'fallback-disabled'});
        for(let index=0;index<selected.length;index++){
          const item=selected[index];if(!isCurrent(ticket))throw new PStudioGraphicsError('Graphics initialization was cancelled.',{code:'PSTUDIO_GRAPHICS_INITIALIZATION_CANCELLED'});
          let handle=null,handleDisposed=false;
          try{
            handle=await item.adapter.initialize(Object.freeze({...context,backend:item.descriptor.backend,signal:controller.signal,requiredFeatures:Object.freeze(requiredFeatures),onDeviceLost:info=>reportDeviceLost(info,ticket,item.descriptor)}));
            if(!isCurrent(ticket)){try{handle?.dispose?.();}catch(_){}handleDisposed=true;throw new PStudioGraphicsError('Late graphics backend initialization was discarded.',{code:'PSTUDIO_GRAPHICS_STALE_INITIALIZATION'});}
            if(!handle||typeof handle.render!=='function'){try{handle?.dispose?.();}catch(_){}handleDisposed=true;throw new TypeError('Initialized graphics backend must return an object with render(frame).');}
            active={adapter:item.adapter,descriptor:item.descriptor,handle};
            const fallback=context.recovery===true||attempts.some(e=>e.status==='failed')||item.descriptor.backend!==primaryBackend||index>0;
            attempts.push({adapterId:item.descriptor.id,backend:item.descriptor.backend,status:fallback?'fallback':'selected'});
            publish(fallback?'fallback':'ready',{fallback,selectedBackend:item.descriptor.backend,selectedAdapter:item.descriptor.id});
            watchDeviceLoss(handle,ticket,item.descriptor);return snapshot();
          }catch(error){
            if(handle&&!active&&!handleDisposed){try{handle.dispose?.();}catch(_){}handleDisposed=true;}
            if(!isCurrent(ticket))throw error;
            lastError=error;attempts.push({adapterId:item.descriptor.id,backend:item.descriptor.backend,status:'failed',reason:String(error?.message||error)});
            if(!allowFallback)break;
          }
        }
        if(!isCurrent(ticket))throw new PStudioGraphicsError('Graphics initialization was cancelled.',{code:'PSTUDIO_GRAPHICS_INITIALIZATION_CANCELLED'});
        const summary=attempts.length?attempts.map(item=>item.adapterId+': '+item.status).join(', '):'no eligible backend adapters';
        const error=new PStudioGraphicsError('No graphics backend could be initialized ('+summary+').',{code:'PSTUDIO_GRAPHICS_NO_BACKEND',details:{attempts}});
        error.cause=lastError||undefined;lastError=error;publish('failed');throw error;
      }finally{externalSignal?.removeEventListener?.('abort',abortFromExternal);}
    })().finally(()=>{initialization=null;});
    return initialization;
  }
  function render(frame){if(disposed||!active||!['ready','fallback'].includes(state))return false;return active.handle.render(frame)!==false;}
  function resize(width,height,pixelRatio=1){if(disposed||!active||!['ready','fallback'].includes(state))return false;const w=Number(width),h=Number(height),r=Number(pixelRatio);if(!Number.isSafeInteger(w)||w<1||!Number.isSafeInteger(h)||h<1||!Number.isFinite(r)||r<=0)throw new TypeError('Graphics resize requires positive integer dimensions and a positive pixel ratio.');return active.handle.resize?.(w,h,r)!==false;}
  async function waitIdle(optionsArg){if(disposed||!active||state==='lost'||typeof active.handle.waitIdle!=='function')return false;return active.handle.waitIdle(optionsArg);}
  async function recover(cause=null){
    if(disposed||state!=='lost'||!active)return false;
    const previous=active;active=null;try{previous.handle.dispose?.();}catch(_){}
    const exclude=[...(lastContext.excludeAdapterIds||[]),previous.descriptor.id];
    const context={...lastContext,excludeAdapterIds:exclude,allowFallback:true,recovery:true,signal:undefined};
    if(cause)context.recoveryCause=String(cause.message||cause);
    return initialize(context);
  }
  function dispose(){if(disposed)return false;disposed=true;generation++;try{controller.abort();}catch(_){}const previous=active;active=null;try{previous?.handle?.dispose?.();}catch(_){}publish('disposed');return true;}
  return Object.freeze({kind:'pstudio-graphics-hal',register,unregister,listBackends,initialize,render,resize,waitIdle,recover,getState:()=>snapshot(),getActiveHandle:()=>active?.handle||null,dispose});
}

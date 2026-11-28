import {PStudioGraphicsError} from './pstudio_graphics_contract.mjs';
function stable(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(stable).join(',')+']';return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';}
export function createPStudioGraphicsShaderCore(options={}){
  const shaders=new Map(),compiled=new Map(),pending=new Map(),versions=new Map(),compileRequests=new Map();let disposed=false;
  function assertLive(){if(disposed)throw new PStudioGraphicsError('Graphics Shader Core is disposed.',{code:'PSTUDIO_GRAPHICS_SHADER_CORE_DISPOSED'});}
  function register(input){
    assertLive();const id=String(input?.id||'').trim(),stage=String(input?.stage||'').toLowerCase(),language=String(input?.language||'wgsl').toLowerCase();
    if(!id)throw new TypeError('Shader id is required.');
    if(!['vertex','fragment','compute','combined'].includes(stage))throw new TypeError('Unsupported shader stage: '+stage);
    if(!['wgsl','glsl','tsl','source'].includes(language))throw new TypeError('Unsupported shader language: '+language);
    if(typeof input.source!=='string'||!input.source.trim())throw new TypeError('Shader source must be a non-empty string.');
    if(shaders.has(id))throw new PStudioGraphicsError('Shader already registered: '+id,{code:'PSTUDIO_GRAPHICS_SHADER_DUPLICATE'});
    const descriptor=Object.freeze({id,stage,language,entryPoint:String(input.entryPoint||(stage==='compute'?'main':'main')),source:input.source,defines:Object.freeze({...input.defines}),metadata:Object.freeze({...input.metadata})});
    shaders.set(id,descriptor);versions.set(id,(versions.get(id)||0)+1);return descriptor;
  }
  function get(id){assertLive();return shaders.get(String(id))||null;}
  function isCompiled(id){assertLive();return [...compiled.values()].some(record=>record.shaderId===String(id));}
  async function compile(id,variant={},context={}){
    assertLive();const descriptor=get(id);if(!descriptor)throw new Error('Unknown graphics shader: '+id);
    if(typeof options.compile!=='function')throw new PStudioGraphicsError('No backend shader compiler was supplied.',{code:'PSTUDIO_GRAPHICS_SHADER_COMPILER_UNAVAILABLE'});
    const key=descriptor.id+'|'+stable(variant)+'|'+String(context.backend||'unknown')+'|'+String(context.deviceKey||'default');
    compileRequests.set(key,{id,variant:{...variant},context:{...context}});
    if(compiled.has(key))return compiled.get(key).handle;if(pending.has(key))return pending.get(key);
    const version=versions.get(id)||0;
    const promise=(async()=>{
      const handle=await options.compile(Object.freeze({descriptor,variant:Object.freeze({...variant}),context:Object.freeze({...context})}));
      if(!handle)throw new PStudioGraphicsError('Shader compiler returned no handle for '+id,{code:'PSTUDIO_GRAPHICS_SHADER_COMPILE_EMPTY'});
      if(disposed){try{handle.dispose?.();}catch(_){}throw new PStudioGraphicsError('Shader compile completed after core disposal.',{code:'PSTUDIO_GRAPHICS_SHADER_CORE_DISPOSED'});}
      if(shaders.get(id)!==descriptor||(versions.get(id)||0)!==version){try{handle.dispose?.();}catch(_){}throw new PStudioGraphicsError('Shader compile completed after its source or variant was invalidated.',{code:'PSTUDIO_GRAPHICS_SHADER_INVALIDATED'});}
      const existing=compiled.get(key);if(existing){try{handle.dispose?.();}catch(_){}return existing.handle;}
      compiled.set(key,{handle,shaderId:id});return handle;
    })().finally(()=>{if(pending.get(key)===promise)pending.delete(key);});
    pending.set(key,promise);return promise;
  }
  function invalidate(id,variant=null,context={}){
    assertLive();const shaderId=String(id),prefix=shaderId+'|';let removed=0;versions.set(shaderId,(versions.get(shaderId)||0)+1);
    for(const [key,record] of [...compiled]){if(!key.startsWith(prefix))continue;if(variant!==null&&!key.startsWith(prefix+stable(variant)+'|'))continue;if(context.backend&&!key.includes('|'+String(context.backend)+'|'))continue;compiled.delete(key);try{record.handle.dispose?.();}catch(_){}removed++;}return removed;
  }
  function invalidateAll(){assertLive();let removed=0;for(const id of shaders.keys())removed+=invalidate(id);return removed;}
  async function recompileAll(context={}){
    assertLive();
    const requests=compileRequests.size?[...compileRequests.values()]:[...shaders.values()].map(descriptor=>({id:descriptor.id,variant:{},context:{}}));
    const results=[];
    for(const request of requests){
      const nextContext={...request.context,...context};
      results.push(await compile(request.id,request.variant,nextContext));
    }
    return Object.freeze({requested:requests.length,compiled:results.length});
  }
  function unregister(id){assertLive();const key=String(id);if(!shaders.has(key))return false;invalidate(key);for(const requestKey of [...compileRequests.keys()])if(requestKey.startsWith(key+'|'))compileRequests.delete(requestKey);shaders.delete(key);versions.set(key,(versions.get(key)||0)+1);return true;}
  function stats(){return Object.freeze({shaderCount:shaders.size,compiledVariantCount:compiled.size,pendingCompileCount:pending.size,shaders:Object.freeze([...shaders.values()].map(s=>Object.freeze({id:s.id,stage:s.stage,language:s.language}))) });}
  function dispose(){if(disposed)return false;for(const record of compiled.values())try{record.handle.dispose?.();}catch(_){}compiled.clear();compileRequests.clear();shaders.clear();disposed=true;return true;}
  return Object.freeze({kind:'pstudio-graphics-shader-core',register,get,isCompiled,compile,invalidate,invalidateAll,recompileAll,unregister,stats,dispose});
}

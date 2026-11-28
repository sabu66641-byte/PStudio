import {PStudioGraphicsError} from './pstudio_graphics_contract.mjs';
function positiveInt(value,label){const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new TypeError(label+' must be a positive safe integer.');return n;}
export function createPStudioGraphicsComputeCore(options={}){
  const kernels=new Map();let disposed=false,inFlight=0,dispatchCount=0;
  function assertLive(){if(disposed)throw new PStudioGraphicsError('Graphics Compute Core is disposed.',{code:'PSTUDIO_GRAPHICS_COMPUTE_CORE_DISPOSED'});}
  function register(input){
    assertLive();const id=String(input?.id||'').trim();if(!id)throw new TypeError('Compute kernel id is required.');
    if(kernels.has(id))throw new PStudioGraphicsError('Compute kernel already registered: '+id,{code:'PSTUDIO_GRAPHICS_COMPUTE_DUPLICATE'});
    const workgroup=input.workgroupSize||[1,1,1];if(!Array.isArray(workgroup)||workgroup.length!==3)throw new TypeError('Compute workgroupSize must be a 3D tuple.');
    const sizes=workgroup.map((v,i)=>positiveInt(v,'workgroupSize['+i+']')),total=sizes.reduce((a,b)=>a*b,1),max=positiveInt(options.maxWorkgroupInvocations||1024,'maxWorkgroupInvocations');
    if(total>max)throw new RangeError('Compute workgroup exceeds configured invocation limit.');
    const kernel=Object.freeze({id,shaderId:String(input.shaderId||id),entryPoint:String(input.entryPoint||'main'),workgroupSize:Object.freeze(sizes),requiredFeatures:Object.freeze([...(input.requiredFeatures||[])].map(String)),metadata:Object.freeze({...input.metadata})});
    kernels.set(id,kernel);return kernel;
  }
  async function dispatch(id,input={}){
    assertLive();const kernel=kernels.get(String(id));if(!kernel)throw new Error('Unknown compute kernel: '+id);
    if(typeof options.executor!=='function')throw new PStudioGraphicsError('No compute backend executor is configured.',{code:'PSTUDIO_GRAPHICS_COMPUTE_EXECUTOR_UNAVAILABLE'});
    const groups=input.groups||[1,1,1];if(!Array.isArray(groups)||groups.length!==3)throw new TypeError('Compute dispatch groups must be a 3D tuple.');
    const values=groups.map((v,i)=>positiveInt(v,'groups['+i+']')),max=positiveInt(options.maxWorkgroupsPerDimension||65535,'maxWorkgroupsPerDimension');
    if(values.some(v=>v>max))throw new RangeError('Compute dispatch group count exceeds the configured limit.');
    const available=input.capabilities?.features||options.capabilities?.features||[],missing=kernel.requiredFeatures.filter(feature=>!available.includes(feature));
    if(missing.length)throw new PStudioGraphicsError('Compute kernel requires unsupported features: '+missing.join(', '),{code:'PSTUDIO_GRAPHICS_COMPUTE_FEATURE_MISSING',details:{missing}});
    inFlight++;dispatchCount++;
    try{return await options.executor(Object.freeze({kernel,groups:Object.freeze(values),resources:Object.freeze({...input.resources}),parameters:Object.freeze({...input.parameters}),frame:input.frame??null}));}
    finally{inFlight--;}
  }
  function stats(){return Object.freeze({kernelCount:kernels.size,inFlight,dispatchCount,kernels:Object.freeze([...kernels.values()])});}
  function dispose(){if(disposed)return false;if(inFlight>0)throw new PStudioGraphicsError('Cannot dispose Compute Core while dispatches are in flight.',{code:'PSTUDIO_GRAPHICS_COMPUTE_IN_FLIGHT'});kernels.clear();disposed=true;return true;}
  return Object.freeze({kind:'pstudio-graphics-compute-core',register,dispatch,get:id=>kernels.get(String(id))||null,stats,dispose});
}

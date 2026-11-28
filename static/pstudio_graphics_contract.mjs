/**
 * Vendor-neutral public contracts for PStudio Independent Graphics Engine.
 * No Three.js, WebGL, WebGPU, DOM or browser-global dependencies.
 */
export const PSTUDIO_GRAPHICS_API_VERSION = '0.2.0';
export const PSTUDIO_GRAPHICS_BACKENDS = Object.freeze(['webgpu','webgl2','vulkan','direct3d12','metal']);
export const PSTUDIO_GRAPHICS_STATES = Object.freeze(['idle','initializing','ready','fallback','lost','failed','disposed']);

const STATE_TRANSITIONS = Object.freeze({
  idle:Object.freeze(['initializing','disposed']),
  initializing:Object.freeze(['ready','fallback','failed','disposed']),
  ready:Object.freeze(['lost','failed','disposed']),
  fallback:Object.freeze(['lost','failed','disposed']),
  lost:Object.freeze(['initializing','fallback','failed','disposed']),
  failed:Object.freeze(['initializing','disposed']),
  disposed:Object.freeze([])
});
function freezeRecord(value){return !value||typeof value!=='object'||Array.isArray(value)?Object.freeze({}):Object.freeze({...value});}
function finite(value,fallback=0){const n=Number(value);return Number.isFinite(n)?n:fallback;}
function finiteArray(value,length,fallback,label){
  const source=Array.isArray(value)||ArrayBuffer.isView(value)?Array.from(value):fallback;
  if(source.length!==length||!source.every(item=>Number.isFinite(Number(item))))throw new TypeError(label+' must contain exactly '+length+' finite numbers.');
  return Object.freeze(source.map(Number));
}
function normalizeFeatureList(value){
  const source=Array.isArray(value)?value:[];
  return Object.freeze([...new Set(source.map(item=>String(item).trim().toLowerCase()).filter(Boolean))].sort());
}
export class PStudioGraphicsError extends Error{
  constructor(message,options={}){super(String(message||'PStudio Graphics Engine error.'));this.name='PStudioGraphicsError';this.code=String(options.code||'PSTUDIO_GRAPHICS_ERROR');this.backend=options.backend?String(options.backend):null;this.details=freezeRecord(options.details);}
}
export function createPStudioGraphicsBackendDescriptor(input={}){
  const id=String(input.id||'').trim().toLowerCase();
  if(!/^[a-z][a-z0-9._-]{1,63}$/.test(id))throw new TypeError('Graphics backend adapter id must be 2–64 lowercase identifier characters.');
  const backend=String(input.backend||'').trim().toLowerCase();
  if(!PSTUDIO_GRAPHICS_BACKENDS.includes(backend))throw new TypeError('Unsupported PStudio graphics backend: '+backend);
  const limits={};for(const [key,value] of Object.entries(input.limits||{}))if(Number.isFinite(Number(value))&&Number(value)>=0)limits[String(key)]=Number(value);
  return Object.freeze({id,backend,priority:Math.trunc(finite(input.priority,0)),features:normalizeFeatureList(input.features),limits:Object.freeze(limits),metadata:freezeRecord(input.metadata)});
}
export function validatePStudioGraphicsBackendAdapter(adapter){
  if(!adapter||typeof adapter!=='object')throw new TypeError('A graphics backend adapter object is required.');
  if(typeof adapter.initialize!=='function')throw new TypeError('Graphics backend adapter must implement initialize(context).');
  const descriptor=createPStudioGraphicsBackendDescriptor(adapter.descriptor||adapter);
  if(adapter.supports!=null&&typeof adapter.supports!=='function')throw new TypeError('Graphics backend adapter supports must be a function when provided.');
  return Object.freeze({adapter,descriptor});
}
export function createPStudioGraphicsScene(input={}){
  const id=String(input.id||'').trim();if(!id)throw new TypeError('Graphics scene id is required.');
  const revision=finite(input.revision,0);if(!Number.isSafeInteger(revision)||revision<0)throw new TypeError('Graphics scene revision must be a non-negative safe integer.');
  return Object.freeze({id,revision,root:input.root??null,environment:input.environment??null,metadata:freezeRecord(input.metadata)});
}
export function createPStudioGraphicsView(input={}){
  const id=String(input.id||'main').trim()||'main',viewport=input.viewport||{};
  const width=Number(viewport.width),height=Number(viewport.height),pixelRatio=viewport.pixelRatio==null?1:Number(viewport.pixelRatio);
  if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1)throw new TypeError('Graphics view viewport requires positive integer dimensions.');
  if(!Number.isFinite(pixelRatio)||pixelRatio<=0)throw new TypeError('Graphics view pixelRatio must be positive.');
  const viewMatrix=input.viewMatrix==null?null:finiteArray(input.viewMatrix,16,[],'viewMatrix');
  const projectionMatrix=input.projectionMatrix==null?null:finiteArray(input.projectionMatrix,16,[],'projectionMatrix');
  return Object.freeze({id,camera:input.camera??null,viewport:Object.freeze({width,height,pixelRatio}),viewMatrix,projectionMatrix,near:input.near==null?null:Math.max(0,finite(input.near)),far:input.far==null?null:Math.max(0,finite(input.far)),metadata:freezeRecord(input.metadata)});
}
export function createPStudioGraphicsMaterial(input={}){
  const id=String(input.id||'').trim();if(!id)throw new TypeError('Graphics material id is required.');
  const model=String(input.model||'pbr').toLowerCase();if(!['unlit','lambert','phong','pbr','toon'].includes(model))throw new TypeError('Unsupported graphics material model: '+model);
  const metallic=finite(input.metallic,0),roughness=finite(input.roughness,0.7),opacity=finite(input.opacity,1);
  if(metallic<0||metallic>1||roughness<0||roughness>1||opacity<0||opacity>1)throw new RangeError('Material metallic, roughness and opacity must be in the range [0, 1].');
  const baseColorTextureId=input.baseColorTextureId==null?null:String(input.baseColorTextureId).trim()||null;
  return Object.freeze({id,model,baseColor:finiteArray(input.baseColor||[1,1,1,1],4,[1,1,1,1],'baseColor'),emissive:finiteArray(input.emissive||[0,0,0],3,[0,0,0],'emissive'),metallic,roughness,opacity,alphaMode:['opaque','mask','blend'].includes(input.alphaMode)?input.alphaMode:'opaque',doubleSided:input.doubleSided===true,baseColorTextureId,textures:normalizeFeatureList(input.textures),metadata:freezeRecord(input.metadata)});
}
export function createPStudioGraphicsResourceDescriptor(input={}){
  const id=String(input.id||'').trim(),type=String(input.type||'').trim().toLowerCase();if(!id||!type)throw new TypeError('Graphics resource id and type are required.');
  const width=input.width==null?null:Number(input.width),height=input.height==null?null:Number(input.height),depth=input.depth==null?null:Number(input.depth);
  for(const [name,value] of Object.entries({width,height,depth}))if(value!=null&&(!Number.isSafeInteger(value)||value<1))throw new TypeError('Resource '+name+' must be a positive integer.');
  return Object.freeze({id,type,format:input.format?String(input.format):null,width,height,depth,usage:normalizeFeatureList(input.usage),domain:input.domain==='gpu'?'gpu':'cpu',lifetime:['transient','persistent','external'].includes(input.lifetime)?input.lifetime:'persistent',estimatedBytes:Math.max(0,Math.floor(finite(input.estimatedBytes,0))),backendHandle:input.backendHandle??null,metadata:freezeRecord(input.metadata)});
}
const COMMAND_OPS=new Set(['begin-pass','end-pass','bind-pipeline','bind-resource','set-viewport','set-scissor','clear','draw','draw-indexed','dispatch','copy-resource','barrier','present']);
export function createPStudioGraphicsCommand(input={}){
  const op=String(input.op||'').trim().toLowerCase();if(!COMMAND_OPS.has(op))throw new TypeError('Unsupported PStudio graphics command: '+op);
  const command={op};
  for(const key of ['passId','pipelineId','resourceId','sourceId','targetId','label'])if(input[key]!=null)command[key]=String(input[key]);
  for(const key of ['x','y','width','height','count','first','instances','groupsX','groupsY','groupsZ','indexCount','firstIndex','baseVertex'])if(input[key]!=null){const value=Number(input[key]);if(!Number.isFinite(value)||value<0)throw new TypeError('Graphics command '+key+' must be finite and non-negative.');command[key]=value;}
  if(input.clearColor!=null)command.clearColor=finiteArray(input.clearColor,4,[],'clearColor');
  if(input.bindings!=null)command.bindings=Object.freeze({...input.bindings});
  if(input.metadata!=null)command.metadata=freezeRecord(input.metadata);
  return Object.freeze(command);
}
export function createPStudioGraphicsCommandBuffer(input={}){
  const frameId=Math.floor(finite(input.frameId,0));if(!Number.isSafeInteger(frameId)||frameId<0)throw new TypeError('Command buffer frameId must be a non-negative safe integer.');
  const commands=Object.freeze((Array.isArray(input.commands)?input.commands:[]).map(createPStudioGraphicsCommand));
  return Object.freeze({frameId,commands,commandCount:commands.length,metadata:freezeRecord(input.metadata)});
}
export function createPStudioGraphicsCommandEncoder(frameId=0){
  const commands=[];let finished=false;
  return Object.freeze({
    record(command){if(finished)throw new PStudioGraphicsError('Graphics command encoder is already finished.',{code:'PSTUDIO_GRAPHICS_ENCODER_FINISHED'});commands.push(createPStudioGraphicsCommand(command));return commands.length;},
    finish(metadata={}){if(finished)throw new PStudioGraphicsError('Graphics command encoder can only finish once.',{code:'PSTUDIO_GRAPHICS_ENCODER_FINISHED'});finished=true;return createPStudioGraphicsCommandBuffer({frameId,commands,metadata});},
    get commandCount(){return commands.length;},get finished(){return finished;}
  });
}
export function createPStudioGraphicsFrame(input={}){
  const frameId=input.frameId==null?0:Number(input.frameId),timeMs=input.timeMs==null?0:Number(input.timeMs),deltaMs=input.deltaMs==null?0:Number(input.deltaMs),viewport=input.viewport||{};
  const width=Number(viewport.width),height=Number(viewport.height),pixelRatio=viewport.pixelRatio==null?1:Number(viewport.pixelRatio);
  if(!Number.isSafeInteger(frameId)||frameId<0)throw new TypeError('Graphics frameId must be a non-negative safe integer.');
  if(!Number.isFinite(timeMs)||timeMs<0||!Number.isFinite(deltaMs)||deltaMs<0)throw new TypeError('Graphics frame time values must be finite and non-negative.');
  if(!Number.isSafeInteger(width)||width<=0||!Number.isSafeInteger(height)||height<=0)throw new TypeError('Graphics frame viewport width and height must be positive integers.');
  if(!Number.isFinite(pixelRatio)||pixelRatio<=0)throw new TypeError('Graphics frame viewport pixelRatio must be finite and greater than zero.');
  const commandBuffer=input.commandBuffer==null?null:(input.commandBuffer.commands?createPStudioGraphicsCommandBuffer(input.commandBuffer):input.commandBuffer);
  if(commandBuffer&&commandBuffer.frameId!==frameId)throw new TypeError('Graphics frame and command buffer frameId must match.');
  return Object.freeze({frameId,timeMs,deltaMs,viewport:Object.freeze({width,height,pixelRatio}),scene:input.scene??null,view:input.view??null,environment:input.environment??null,quality:input.quality??null,commandBuffer,metadata:freezeRecord(input.metadata)});
}
export function createPStudioGraphicsSyncHandle(input={}){
  if(typeof input.wait!=='function')throw new TypeError('Graphics sync handle requires wait().');let disposed=false;
  return Object.freeze({kind:String(input.kind||'fence'),wait(options){if(disposed)return Promise.reject(new PStudioGraphicsError('Graphics sync handle is disposed.',{code:'PSTUDIO_GRAPHICS_SYNC_DISPOSED'}));return Promise.resolve(input.wait(options));},dispose(){if(disposed)return false;disposed=true;try{input.dispose?.();}catch(_){}return true;},get disposed(){return disposed;}});
}
export function assertPStudioGraphicsStateTransition(current,next){
  const from=String(current||''),to=String(next||'');if(from===to)return true;
  if(!PSTUDIO_GRAPHICS_STATES.includes(from)||!PSTUDIO_GRAPHICS_STATES.includes(to))throw new TypeError('Unknown PStudio graphics lifecycle state: '+from+' → '+to);
  if(!STATE_TRANSITIONS[from].includes(to))throw new PStudioGraphicsError('Invalid graphics lifecycle transition: '+from+' → '+to,{code:'PSTUDIO_GRAPHICS_INVALID_STATE_TRANSITION',details:{current:from,next:to}});
  return true;
}

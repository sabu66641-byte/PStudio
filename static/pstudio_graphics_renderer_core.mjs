import {createPStudioGraphicsCommandBuffer,PStudioGraphicsError} from './pstudio_graphics_contract.mjs';
import {createPStudioGraphicsEngine} from './pstudio_graphics_engine.mjs';
/** Deterministic PStudio frame owner; pass scheduling is Phase 4. */
export function createPStudioGraphicsRendererCore(options={}){
  const engine=options.engine||createPStudioGraphicsEngine({hal:options.hal,onStateChange:options.onStateChange});
  if(typeof engine.render!=='function'||typeof engine.initialize!=='function')throw new TypeError('A PStudio Graphics Engine is required.');
  let frameId=0,disposed=false,lastSubmission=null;
  async function initialize(context){if(disposed)throw new PStudioGraphicsError('Renderer Core is disposed.',{code:'PSTUDIO_GRAPHICS_RENDERER_CORE_DISPOSED'});return engine.initialize(context);}
  function submit(input={}){
    if(disposed)return false;const nextId=input.frameId==null?frameId+1:Number(input.frameId);
    if(!Number.isSafeInteger(nextId)||nextId<=frameId)throw new TypeError('Renderer Core frameId must increase monotonically.');
    const commandBuffer=input.commandBuffer?createPStudioGraphicsCommandBuffer(input.commandBuffer):null;
    if(commandBuffer&&commandBuffer.frameId!==nextId)throw new TypeError('Command buffer frameId must match submitted frameId.');
    const accepted=engine.render({frameId:nextId,timeMs:Number(input.timeMs??0),deltaMs:Number(input.deltaMs??0),viewport:input.viewport||{},scene:input.scene??null,view:input.view??null,environment:input.environment??null,quality:input.quality??null,commandBuffer,metadata:input.metadata});
    if(accepted){frameId=nextId;lastSubmission=Object.freeze({frameId:nextId,timeMs:Number(input.timeMs??0),deltaMs:Number(input.deltaMs??0),commandCount:commandBuffer?.commandCount||0});}return accepted;
  }
  function resize(w,h,r){return !disposed&&engine.resize(w,h,r);}
  function getState(){return Object.freeze({disposed,frameId,lastSubmission,engine:engine.getState()});}
  function dispose(){if(disposed)return false;disposed=true;return engine.dispose();}
  return Object.freeze({kind:'pstudio-graphics-renderer-core',initialize,submit,resize,getState,dispose});
}

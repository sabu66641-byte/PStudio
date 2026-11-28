const DOMAIN_KEYS=Object.freeze({'cpu-frame':'cpuFrameMs','cpu-stage':'cpuSubmitMs','gpu-frame':'gpuRenderMs','gpu-stage':'gpuStageMs',asynchronous:'asyncElapsedMs',memory:'memoryBytes'});
function positiveInteger(value,fallback,min,max,label){const number=value==null?fallback:Number(value);if(!Number.isSafeInteger(number)||number<min||number>max)throw new RangeError(label+' must be an integer between '+min+' and '+max+'.');return number;}
function finite(value,label){if(value==null)throw new TypeError(label+' is unavailable.');const number=Number(value);if(!Number.isFinite(number)||number<0)throw new TypeError(label+' must be a finite non-negative number.');return number;}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(!value||typeof value!=='object')return value;const output={};for(const key of Object.keys(value).sort())output[key]=canonical(value[key]);return output;}
function contextsMatch(left,right){return !!left&&!!right&&JSON.stringify(canonical(left))===JSON.stringify(canonical(right));}
/** Connects PVCS A/B calibration to live PStudio3D capture. Alternative overlays always roll back. */
export function createPStudioPVCSBrowserRunner(options={}){
 const getEngine=typeof options.getEngine==='function'?options.getEngine:()=>globalThis.PStudio3D;
 const getPVCS=typeof options.getPVCS==='function'?options.getPVCS:()=>globalThis.PStudioPVCS;
 const measureAsync=typeof options.measureAsync==='function'?options.measureAsync:null;
 const stageId=typeof options.stageId==='string'?options.stageId.trim():'';
 const settleFrames=positiveInteger(options.settleFrames,2,0,60,'settleFrames');
 const maxMetricFrames=positiveInteger(options.maxMetricFrames,16,1,120,'maxMetricFrames');
 const maxWidth=positiveInteger(options.maxWidth,640,32,1024,'maxWidth');
 const maxHeight=positiveInteger(options.maxHeight,360,18,1024,'maxHeight');
 const clock=typeof options.now==='function'?options.now:()=>globalThis.performance?.now?.()??Date.now();
 let running=false;
 async function runVariant(input={}){
  if(running)throw new Error('The PStudio PVCS browser runner does not allow concurrent variant captures.');
  const domain=String(input.domain||''),metricKey=DOMAIN_KEYS[domain];
  if(!metricKey)throw new TypeError('Unsupported PVCS browser calibration domain: '+domain);
  if((domain==='cpu-stage'||domain==='gpu-stage')&&!stageId)throw new TypeError(domain+' calibration requires an explicit stageId.');
  if(domain==='asynchronous'&&!measureAsync)throw new TypeError('asynchronous calibration requires an explicit measureAsync callback.');
  if(input.signal?.aborted){const error=new Error('PVCS browser calibration was cancelled.');error.name='AbortError';throw error;}
  const engine=getEngine();
  if(!engine||typeof engine.capturePVCSFrame!=='function'||typeof engine.getPerformanceStats!=='function')throw new Error('The active PStudio3D runtime does not expose PVCS frame capture and performance telemetry.');
  running=true;let rollbackToken=null,overrideApplied=false;
  const pvcs=getPVCS();
  const shouldEnableStageMonitoring=domain==='cpu-stage'||domain==='gpu-stage';
  const previousMonitoring=shouldEnableStageMonitoring&&typeof pvcs?.isMonitoringEnabled==='function'?pvcs.isMonitoringEnabled():null;
  if(shouldEnableStageMonitoring&&typeof pvcs?.setMonitoringEnabled==='function'&&previousMonitoring!==true)pvcs.setMonitoringEnabled(true);
  try{
   if(input.variant==='alternative'){
    if(typeof engine.applyPVCSFrameBudgetOverride!=='function'||typeof engine.rollbackPVCSFrameBudgetOverride!=='function')throw new Error('The reversible PStudio frame-budget override API is unavailable.');
    const applied=engine.applyPVCSFrameBudgetOverride(input.profile||{});
    if(!applied?.applied||!applied.rollbackToken)throw new Error('The alternative PVCS frame-budget profile could not be applied: '+String(applied?.reason||'no rollback token'));
    rollbackToken=applied.rollbackToken;overrideApplied=true;
   }else if(input.variant!=='baseline')throw new TypeError('PVCS browser runner variant must be baseline or alternative.');
   const initialStats=engine.getPerformanceStats()||{},initialFrameSequence=Number(initialStats.renderFrameSequence)||0;
   let capture=null;
   for(let i=0;i<settleFrames;i++){if(input.signal?.aborted){const error=new Error('PVCS browser calibration was cancelled.');error.name='AbortError';throw error;}capture=await engine.capturePVCSFrame({maxWidth,maxHeight});}
   let asyncElapsedMs=null;
   if(!input.warmup&&domain==='asynchronous'){const startedAt=clock();await measureAsync(Object.freeze({variant:input.variant,profile:input.profile,index:input.index,context:input.context,signal:input.signal,engine}));asyncElapsedMs=Math.max(0,clock()-startedAt);}
   let selectedMetric=null,selectedStage=null;
   const attempts=domain==='gpu-frame'||domain==='gpu-stage'?maxMetricFrames:1;
   for(let attempt=0;attempt<attempts;attempt++){
    capture=await engine.capturePVCSFrame({maxWidth,maxHeight});if(input.warmup)break;
    const metrics=capture?.metrics||{};
    if(domain==='cpu-stage'){
     const candidate=metrics.cpuStageMetrics?.[stageId],sourceSequence=Number(candidate?.sourceFrameSequence)||0;
     if(candidate&&sourceSequence>initialFrameSequence&&contextsMatch(candidate.context,capture.context)){selectedMetric=candidate.cpuStageMs;selectedStage=candidate;break;}
    }else if(domain==='gpu-frame'){
     const sourceSequence=Number(metrics.gpuRenderSourceFrameSequence)||0;
     if(metrics.gpuTimingFresh===true&&Number(metrics.gpuRenderSampleSequence)>0&&sourceSequence>initialFrameSequence&&contextsMatch(metrics.gpuRenderSampleContext,capture.context)){selectedMetric=metrics.gpuRenderMs;break;}
    }else if(domain==='gpu-stage'){
     const candidate=metrics.gpuStageMetrics?.[stageId],sourceSequence=Number(candidate?.sourceFrameSequence)||0;
     if(candidate&&sourceSequence>initialFrameSequence&&contextsMatch(candidate.context,capture.context)){selectedMetric=candidate.gpuStageMs;selectedStage=candidate;break;}
    }else{selectedMetric=domain==='asynchronous'?asyncElapsedMs:domain==='cpu-frame'?metrics.cpuFrameMs:domain==='memory'?metrics.memoryBytes:null;break;}
   }
   if(!capture?.frame||!capture?.context)throw new Error('PStudio frame capture returned no image or render context.');
   if(!input.warmup&&selectedMetric==null){if(domain==='gpu-frame')throw new Error('A fresh GPU-frame timer-query sample from the active variant is unavailable; no CPU fallback was used.');if(domain==='gpu-stage')throw new Error('A fresh GPU-stage timer-query sample for '+stageId+' is unavailable.');throw new Error('The requested PVCS metric '+metricKey+' is unavailable.');}
   const metrics=input.warmup?{}:{[metricKey]:finite(selectedMetric,input.variant+'.'+metricKey)};
   if(domain==='gpu-frame'&&selectedMetric!=null){metrics.gpuRenderSampleSequence=capture.metrics.gpuRenderSampleSequence;metrics.gpuRenderSourceFrameSequence=capture.metrics.gpuRenderSourceFrameSequence;}
   if(domain==='cpu-stage'&&selectedStage)metrics.cpuStageSourceFrameSequence=selectedStage.sourceFrameSequence;
   if(domain==='gpu-stage'&&selectedStage)metrics.gpuStageSourceFrameSequence=selectedStage.sourceFrameSequence;
   return Object.freeze({context:capture.context,metrics:Object.freeze(metrics),frame:capture.frame});
  }finally{
   try{if(overrideApplied&&engine.rollbackPVCSFrameBudgetOverride(rollbackToken)!==true)throw new Error('PStudio failed to roll back the alternative frame-budget profile.');}
   finally{
    if(shouldEnableStageMonitoring&&previousMonitoring===false&&typeof pvcs?.setMonitoringEnabled==='function')pvcs.setMonitoringEnabled(false);
    running=false;
   }
  }
 }
 return Object.freeze({runVariant,getState:()=>Object.freeze({running,settleFrames,maxMetricFrames,maxWidth,maxHeight,stageId:stageId||null})});
}

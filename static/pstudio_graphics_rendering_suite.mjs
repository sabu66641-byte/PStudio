import { createPStudioRenderGraph } from "./pstudio_render_graph.mjs";
import { getPStudioRenderingShaderLibraries } from "./pstudio_graphics_rendering_systems.mjs";

const PASS_DEFINITIONS = Object.freeze([
  { id:"shadow-map", reads:[], writes:[["shadowDepth","depth-attachment"]], feature:"shadows", stageId:"shadow-map" },
  { id:"sky-atmosphere-ibl", reads:[], writes:[["skyRadiance","color-attachment"],["iblSpecular","color-attachment"]], feature:"atmosphere", stageId:"sky-ibl" },
  { id:"depth-prepass", reads:[], writes:[["sceneDepth","depth-attachment"]], feature:"depth", stageId:"depth-prepass" },
  { id:"opaque-forward", reads:[["sceneDepth","sampled"],["shadowDepth","sampled"],["skyRadiance","sampled"],["iblSpecular","sampled"]], writes:[["opaqueHdr","color-attachment"]], feature:"opaque", stageId:"opaque-forward" },
  { id:"water-depth", reads:[["sceneDepth","sampled"]], writes:[["waterLinearDepth","color-attachment"]], feature:"water", stageId:"water-depth" },
  { id:"mirror-reflection", reads:[["sceneDepth","sampled"],["skyRadiance","sampled"]], writes:[["mirrorReflection","color-attachment"]], feature:"water", stageId:"mirror-reflection" },
  { id:"water-surface", reads:[["opaqueHdr","sampled"],["waterLinearDepth","sampled"],["mirrorReflection","sampled"],["skyRadiance","sampled"]], writes:[["waterHdr","color-attachment"]], feature:"water", stageId:"water-surface" },
  { id:"gi-probes", reads:[["waterHdr","sampled"],["sceneDepth","sampled"],["skyRadiance","sampled"]], writes:[["giIrradiance","storage-write"]], feature:"gi", stageId:"gi-probes" },
  { id:"volumetric-lighting", reads:[["waterHdr","sampled"],["sceneDepth","sampled"],["shadowDepth","sampled"],["skyRadiance","sampled"]], writes:[["volumeHdr","color-attachment"]], feature:"volumetrics", stageId:"volumetric-lighting" },
  { id:"post-processing", reads:[["waterHdr","sampled"],["giIrradiance","sampled"],["volumeHdr","sampled"]], writes:[["postHdr","color-attachment"]], feature:"post", stageId:"post-processing" },
  { id:"tone-map-present", reads:[["postHdr","sampled"]], writes:[["outputSurface","color-attachment"]], feature:"present", stageId:"tone-map-present" }
]);
const FEATURES = Object.freeze(["atmosphere","shadows","depth","opaque","water","gi","volumetrics","post","present"]);
function enabledFeatures(input) {
  const result = {};
  for (const feature of FEATURES) {
    const value = input[feature];
    if (value != null && typeof value !== "boolean") throw new TypeError("Render feature " + feature + " must be explicitly true or false.");
    result[feature] = value !== false;
  }
  return Object.freeze(result);
}
function resourceDescriptor(id, width, height, format, extra = {}) {
  return { id, type: id === "outputSurface" ? "surface" : "texture", width, height, format, usage: ["sampled","color-attachment","depth-attachment","storage-write"], lifetime: id === "outputSurface" ? "external" : "transient", imported: id === "outputSurface", aliasable: id !== "outputSurface", ...extra };
}

/**
 * Creates the canonical PStudio visual pipeline order on a backend-neutral Render Graph.
 * Passes are real executable slots, but each backend must inject the actual shader/pipeline
 * implementation. An unbound pass throws at execution; it never silently disappears.
 */
export function createPStudioGraphicsRenderingSuite(options = {}) {
  const width = Math.max(1, Math.floor(Number(options.width) || 1280));
  const height = Math.max(1, Math.floor(Number(options.height) || 720));
  const prefix = String(options.prefix || "pstudio.rendering");
  if (!prefix) throw new TypeError("Rendering suite prefix is required.");
  const features = enabledFeatures(options.features || {});
  const handlers = options.handlers || {};
  const graph = options.graph || createPStudioRenderGraph();
  const ownsGraph = !options.graph;
  const ids = Object.freeze({
    shadowDepth: prefix + ".shadow-depth",
    skyRadiance: prefix + ".sky-radiance",
    iblSpecular: prefix + ".ibl-specular",
    sceneDepth: prefix + ".scene-depth",
    opaqueHdr: prefix + ".opaque-hdr",
    waterLinearDepth: prefix + ".water-linear-depth",
    mirrorReflection: prefix + ".mirror-reflection",
    waterHdr: prefix + ".water-hdr",
    giIrradiance: prefix + ".gi-irradiance",
    volumeHdr: prefix + ".volume-hdr",
    postHdr: prefix + ".post-hdr",
    outputSurface: prefix + ".output"
  });
  const resources = [
    resourceDescriptor(ids.shadowDepth,width,height,"depth32float"),
    resourceDescriptor(ids.skyRadiance,width,height,"rgba16float"),
    resourceDescriptor(ids.iblSpecular,Math.max(16,Math.floor(width/4)),Math.max(16,Math.floor(height/4)),"rgba16float"),
    resourceDescriptor(ids.sceneDepth,width,height,"depth32float"),
    resourceDescriptor(ids.opaqueHdr,width,height,"rgba16float"),
    resourceDescriptor(ids.waterLinearDepth,width,height,"r32float"),
    resourceDescriptor(ids.mirrorReflection,Math.max(16,Math.floor(width/2)),Math.max(16,Math.floor(height/2)),"rgba16float"),
    resourceDescriptor(ids.waterHdr,width,height,"rgba16float"),
    resourceDescriptor(ids.giIrradiance,64,64,"rgba16float"),
    resourceDescriptor(ids.volumeHdr,Math.max(16,Math.floor(width/2)),Math.max(16,Math.floor(height/2)),"rgba16float"),
    resourceDescriptor(ids.postHdr,width,height,"rgba16float"),
    resourceDescriptor(ids.outputSurface,width,height,options.outputFormat || "bgra8unorm")
  ];
  const resourceNameMap = Object.fromEntries(Object.entries(ids).map(([name,id])=>[name,id]));
  const registeredResources=[];
  const registeredPasses=[];
  try {
    for (const descriptor of resources) {
      graph.addResource(descriptor);
      registeredResources.push(descriptor.id);
    }
    for (const definition of PASS_DEFINITIONS) {
      if (!features[definition.feature]) continue;
      const reads=definition.reads.map(([resource,access])=>({resource:resourceNameMap[resource],access}));
      const writes=definition.writes.map(([resource,access])=>({resource:resourceNameMap[resource],access}));
      const passId=prefix+"."+definition.id;
      graph.addPass({
        id:passId,
        type:definition.id==="gi-probes"?"compute":"render",
        reads,writes,
        metadata:{owner:"PStudio",stageId:definition.stageId,feature:definition.feature,requiresBackendExecutor:true},
        execute:async context=>{
          const handler=handlers[definition.id] || handlers[definition.stageId];
          if(typeof handler!=="function") {
            const error=new Error("PStudio rendering pass has no backend executor: "+definition.id);
            error.code="PSTUDIO_RENDER_PASS_EXECUTOR_MISSING";
            error.passId=passId;
            throw error;
          }
          return handler(Object.freeze({...context,stageId:definition.stageId,feature:definition.feature,resourceIds:ids}));
        }
      });
      registeredPasses.push(passId);
    }
    const plan=graph.compile();
    return Object.freeze({
      kind:"pstudio-graphics-rendering-suite",
      graph,plan,resources:Object.freeze(ids),passes:Object.freeze(registeredPasses),
      features,
      shaderLibraries:getPStudioRenderingShaderLibraries(),
      async execute(executionOptions={}) {
        const external={...(executionOptions.resources||{}),[ids.outputSurface]:executionOptions.outputSurface??executionOptions.resources?.[ids.outputSurface]};
        if(external[ids.outputSurface]==null)throw new Error("A PStudio rendering suite requires an explicit outputSurface resource.");
        return graph.execute({...executionOptions,plan,resources:external});
      },
      dispose() {
        if(!ownsGraph)throw new Error("This rendering suite does not own its injected Render Graph; remove its passes/resources through the owning graph controller.");
        return graph.dispose();
      }
    });
  } catch(error) {
    for(const passId of registeredPasses.reverse())try{graph.removePass(passId);}catch(_){}
    for(const id of registeredResources.reverse())try{graph.removeResource(id);}catch(_){}
    if(ownsGraph)try{graph.dispose();}catch(_){}
    throw error;
  }
}

export function getPStudioGraphicsRenderingPassOrder() {
  return Object.freeze(PASS_DEFINITIONS.map((item,index)=>Object.freeze({index,id:item.id,feature:item.feature,stageId:item.stageId})));
}

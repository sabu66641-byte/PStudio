import {PStudioGraphicsError} from './pstudio_graphics_contract.mjs';
const TYPE_CODE=Object.freeze({directional:0,point:1,spot:2});
function tuple(value,fallback,label,max=100000){const source=Array.isArray(value)?value:fallback;if(source.length!==3||!source.every(v=>Number.isFinite(Number(v))&&Math.abs(Number(v))<=max))throw new TypeError(label+' must be three finite values.');return Object.freeze(source.map(Number));}
function normalizeDirection(value){const v=tuple(value,[0,-1,0],'direction'),length=Math.hypot(...v);if(length<1e-8)throw new TypeError('Light direction cannot be zero.');return Object.freeze(v.map(x=>x/length));}
export function createPStudioGraphicsLightingCore(options={}){
  const lights=new Map();let revision=0,disposed=false;
  function assertLive(){if(disposed)throw new PStudioGraphicsError('Graphics Lighting Core is disposed.',{code:'PSTUDIO_GRAPHICS_LIGHTING_CORE_DISPOSED'});}
  function normalize(input){
    const id=String(input?.id||'').trim(),type=String(input?.type||'').toLowerCase();if(!id)throw new TypeError('Light id is required.');
    if(!(type in TYPE_CODE))throw new TypeError('Unsupported light type: '+type);
    const intensity=Number(input.intensity??1),range=Number(input.range??(type==='directional'?0:10));
    if(!Number.isFinite(intensity)||intensity<0||intensity>1e6)throw new RangeError('Light intensity must be finite and non-negative.');
    if(type!=='directional'&&(!Number.isFinite(range)||range<=0))throw new RangeError('Local light range must be positive.');
    const inner=Number(input.innerConeRadians??0.35),outer=Number(input.outerConeRadians??0.6);
    if(type==='spot'&&(!Number.isFinite(inner)||!Number.isFinite(outer)||inner<0||outer<=inner||outer>=Math.PI/2))throw new RangeError('Spot cone angles must satisfy 0 <= inner < outer < PI/2.');
    return Object.freeze({id,type,color:tuple(input.color,[1,1,1],'color',64),intensity,position:tuple(input.position,[0,0,0],'position'),direction:type==='directional'||type==='spot'?normalizeDirection(input.direction||[0,-1,0]):Object.freeze([0,-1,0]),range,innerConeRadians:inner,outerConeRadians:outer,castsShadow:input.castsShadow===true,priority:Math.max(-32768,Math.min(32767,Math.trunc(Number(input.priority)||0))),layerMask:Math.max(0,Math.trunc(Number(input.layerMask??0xffffffff))>>>0)});
  }
  function set(input){assertLive();const light=normalize(input);lights.set(light.id,light);revision++;return light;}
  function remove(id){assertLive();const changed=lights.delete(String(id));if(changed)revision++;return changed;}
  function snapshot({maxLights=options.maxLights||4096}={}){
    assertLive();const limit=Math.max(1,Math.min(65535,Math.floor(Number(maxLights)||4096))),selected=[...lights.values()].sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id)).slice(0,limit),stride=16,packed=new Float32Array(selected.length*stride);
    selected.forEach((light,index)=>{const o=index*stride;packed[o]=TYPE_CODE[light.type];packed[o+1]=light.intensity;packed[o+2]=light.color[0];packed[o+3]=light.color[1];packed[o+4]=light.color[2];packed[o+5]=light.position[0];packed[o+6]=light.position[1];packed[o+7]=light.position[2];packed[o+8]=light.range;packed[o+9]=light.direction[0];packed[o+10]=light.direction[1];packed[o+11]=light.direction[2];packed[o+12]=Math.cos(light.innerConeRadians);packed[o+13]=Math.cos(light.outerConeRadians);packed[o+14]=light.castsShadow?1:0;packed[o+15]=light.layerMask;});
    return Object.freeze({revision,lightCount:selected.length,records:Object.freeze(selected),packed,stride,omittedCount:Math.max(0,lights.size-selected.length)});
  }
  function stats(){return Object.freeze({lightCount:lights.size,revision,byType:Object.freeze({directional:[...lights.values()].filter(v=>v.type==='directional').length,point:[...lights.values()].filter(v=>v.type==='point').length,spot:[...lights.values()].filter(v=>v.type==='spot').length})});}
  function dispose(){if(disposed)return false;lights.clear();disposed=true;return true;}
  return Object.freeze({kind:'pstudio-graphics-lighting-core',set,remove,get:id=>lights.get(String(id))||null,snapshot,stats,dispose});
}

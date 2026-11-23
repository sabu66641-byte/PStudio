/* PStudio ECS Script Runtime bridge 1.0.0 */
(()=>{'use strict';const ecs=window.PStudioECS;if(!ecs){console.warn('[PStudio ECS Script] ECS core unavailable');return;}
const SOURCE='pstudio_ecs_script',STATE='ScriptState',LIFE='ScriptLifecycle';
function reg(type,schema,create){if(ecs.hasComponentType(type))return;ecs.registerComponent(type,{source:SOURCE,label:type,description:'Runtime-only ps interpreter state.',category:'Scripting',internal:true,persistent:false,additionalProperties:false,schema,create});}
reg(STATE,{variables:{type:'json',default:{}},systems:{type:'json',default:{}}},()=>({variables:Object.create(null),systems:Object.create(null)}));
reg(LIFE,{initialized:{type:'boolean',default:false},started:{type:'boolean',default:false},landSequence:{type:'integer',default:0,min:0}},()=>({initialized:false,started:false,landSequence:0}));
function ensure(e){e=Number(e);if(!Number.isSafeInteger(e)||!ecs.getEntities().includes(e))return false;if(!ecs.hasComponent(e,STATE))ecs.addComponent(e,STATE);if(!ecs.hasComponent(e,LIFE))ecs.addComponent(e,LIFE);return true;}
const entity=id=>ecs.getEntityForSceneObject(String(id));
function sync(objects){let n=0;for(const o of Array.isArray(objects)?objects:[]){if(o?.id==null)continue;const e=entity(o.id);if(e!=null&&ensure(e))n++;}return n;}
function state(e){return ensure(e)?ecs.getComponent(Number(e),STATE):null;}
function getVarsEntity(e){return state(e)?.variables||null;}
function setVarsEntity(e,v){const s=state(e);if(!s||!v||typeof v!=='object'||Array.isArray(v))return false;ecs.setComponent(Number(e),STATE,{...s,variables:v});return true;}
function getVars(id){const e=entity(id);return e==null?null:getVarsEntity(e);}
function setVars(id,v){const e=entity(id);return e==null?false:setVarsEntity(e,v);}
function getSys(e,id){const s=state(e);if(!s)return null;id=String(id);return Object.prototype.hasOwnProperty.call(s.systems,id)?s.systems[id]:Object.create(null);}
function setSys(e,id,v){const s=state(e);if(!s||!v||typeof v!=='object'||Array.isArray(v))return false;const systems=Object.assign(Object.create(null),s.systems);Object.defineProperty(systems,String(id),{value:v,enumerable:true,configurable:true,writable:true});ecs.setComponent(Number(e),STATE,{...s,systems});return true;}
function life(e){return ensure(e)?ecs.getComponent(Number(e),LIFE):null;}
function getLifeEntity(e){return life(e);}
function setLifeEntity(e,p){const s=life(e);if(!s||!p||typeof p!=='object')return false;ecs.setComponent(Number(e),LIFE,{...s,...p});return true;}
function getLife(id){const e=entity(id);return e==null?null:life(e);}
function setLife(id,p){const e=entity(id);return e==null?false:setLifeEntity(e,p);}
function clear(){for(const e of ecs.query([STATE]))ecs.removeComponent(e,STATE);for(const e of ecs.query([LIFE]))ecs.removeComponent(e,LIFE);return true;}
window.PStudioECSScript=Object.freeze({sync,clear,getVariables:getVars,setVariables:setVars,getVariablesByEntity:getVarsEntity,setVariablesByEntity:setVarsEntity,getSystemState:getSys,setSystemState:setSys,getLifecycle:getLife,setLifecycle:setLife,getLifecycleByEntity:getLifeEntity,setLifecycleByEntity:setLifeEntity,version:'1.0.0'});
})();
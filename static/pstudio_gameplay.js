/* PStudio Gameplay Systems 1.0.0
 * Per-object health, combat queries, inventory, quests and graph navigation.
 */
(() => {
  'use strict';
  const stats=new Map(), inventories=new Map(), quests=new Map(), navNodes=new Map(), blockedNavNodes=new Set(), attackTimes=new Map();
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const number=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
  function stat(id){if(!stats.has(id))stats.set(id,{max:100,hp:100,configured:false});return stats.get(id);}
  function setMaxHP(id,value){const s=stat(id);s.max=Math.max(1,number(value,100));s.hp=s.configured?clamp(s.hp,0,s.max):s.max;s.configured=true;return s.max;}
  function setHP(id,value){const s=stat(id);s.hp=clamp(number(value),0,s.max);s.configured=true;return s.hp;}
  function getHP(id){return stat(id).hp;}
  function getMaxHP(id){return stat(id).max;}
  function damage(id,value){const s=stat(id);s.hp=clamp(s.hp-Math.max(0,number(value)),0,s.max);return s.hp;}
  function heal(id,value){const s=stat(id);s.hp=clamp(s.hp+Math.max(0,number(value)),0,s.max);return s.hp;}
  function isAlive(id){return getHP(id)>0;}
  function resolveObject(name,objects){return (objects||[]).find(o=>String(o.id)===String(name)||String(o.name)===String(name))||null;}
  function position(o,physics){const p=physics?.getPosition?.(o.id);if(p)return p;return{x:((number(o.x)+number(o.w,64)/2)-480)/100,y:(270-(number(o.y)+number(o.h,64)/2))/100,z:number(o.z)/100};}
  function attack(sourceId,radius,amount,objects,physics,cooldown=220){
    const source=resolveObject(sourceId,objects);if(!source||!isAlive(sourceId))return 0;
    const origin=position(source,physics),r=Math.max(0,number(radius)),now=Date.now();let hits=0;
    for(const target of objects||[]){if(target.id===sourceId||!physics?.getBody?.(target.id)||!isAlive(target.id))continue;
      const p=position(target,physics),distance=Math.hypot(p.x-origin.x,p.y-origin.y,p.z-origin.z);
      if(distance>r)continue;const key=String(sourceId)+'>'+String(target.id),last=attackTimes.get(key)||0;
      if(now-last<Math.max(0,number(cooldown,220)))continue;attackTimes.set(key,now);damage(target.id,amount);hits++;
    }
    return hits;
  }
  function strike(sourceId,targetName,range,amount,cooldown,objects,physics){
    const source=resolveObject(sourceId,objects),target=resolveObject(targetName,objects);if(!source||!target||!isAlive(sourceId)||!isAlive(target.id))return false;
    const a=position(source,physics),b=position(target,physics);if(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)>Math.max(0,number(range)))return false;
    const key=String(sourceId)+'>'+String(target.id),now=Date.now(),last=attackTimes.get(key)||0;if(now-last<Math.max(0,number(cooldown,500)))return false;attackTimes.set(key,now);damage(target.id,amount);return true;
  }
  function follow(sourceId,targetName,speed,stopDistance,objects,physics){
    const source=resolveObject(sourceId,objects),target=resolveObject(targetName,objects);
    if(!source||!target||!physics?.getBody?.(sourceId))return false;
    if(number(speed)>0)physics.configureController(sourceId,Math.max(0.1,number(speed)),24,0.25);
    const a=position(source,physics),b=position(target,physics),dx=b.x-a.x,dz=b.z-a.z,dist=Math.hypot(dx,dz),stop=Math.max(0,number(stopDistance,1));
    if(dist<=stop){physics.moveCharacter(sourceId,0,0);return true;}
    physics.moveCharacter(sourceId,dx/dist,dz/dist);return true;
  }
  function inventory(id){if(!inventories.has(id))inventories.set(id,new Map());return inventories.get(id);}
  function inventoryAdd(id,item,count=1){const bag=inventory(id),key=String(item),next=(bag.get(key)||0)+Math.max(1,Math.floor(number(count,1)));bag.set(key,next);return next;}
  function inventoryRemove(id,item,count=1){const bag=inventory(id),key=String(item),old=bag.get(key)||0,n=Math.max(1,Math.floor(number(count,1)));if(old<n)return false;if(old===n)bag.delete(key);else bag.set(key,old-n);return true;}
  function inventoryCount(id,item){return inventory(id).get(String(item))||0;}
  function questStart(id){const key=String(id);if(!quests.has(key))quests.set(key,{started:true,complete:false,progress:0,target:1});else quests.get(key).started=true;return true;}
  function questComplete(id){const key=String(id),q=quests.get(key)||{started:true,complete:false,progress:0,target:1};q.started=true;q.complete=true;q.progress=q.target;quests.set(key,q);return true;}
  function questIsComplete(id){return !!quests.get(String(id))?.complete;}
  function questSetProgress(id,value,target=1){const key=String(id),q=quests.get(key)||{started:true,complete:false,progress:0,target:Math.max(1,number(target,1))};q.started=true;q.target=Math.max(1,number(target,q.target));q.progress=clamp(number(value),0,q.target);if(q.progress>=q.target)q.complete=true;quests.set(key,q);return q.progress;}
  function questGetProgress(id){const q=quests.get(String(id));return q?q.progress:0;}
  function navAddNode(id,x,y,z){navNodes.set(String(id),{id:String(id),x:number(x),y:number(y),z:number(z),links:new Set()});return true;}
  function navConnect(a,b){a=navNodes.get(String(a));b=navNodes.get(String(b));if(!a||!b)return false;a.links.add(b.id);b.links.add(a.id);return true;}
  function navBuildGrid(x,z,width,depth,cell){const step=Math.max(0.5,number(cell,2)),cols=Math.max(1,Math.min(50,Math.floor(number(width)/step))),rows=Math.max(1,Math.min(50,Math.floor(number(depth)/step)));if(cols*rows>2500)return 0;navClear();for(let iz=0;iz<=rows;iz++)for(let ix=0;ix<=cols;ix++){const id='grid_'+ix+'_'+iz;navAddNode(id,number(x)+(ix/cols)*number(width),0,number(z)+(iz/rows)*number(depth));}for(let iz=0;iz<=rows;iz++)for(let ix=0;ix<=cols;ix++){const id='grid_'+ix+'_'+iz;if(ix<cols)navConnect(id,'grid_'+(ix+1)+'_'+iz);if(iz<rows)navConnect(id,'grid_'+ix+'_'+(iz+1));}return navNodes.size;}
  function navBlock(id,blocked=true){if(!navNodes.has(String(id)))return false;if(blocked)blockedNavNodes.add(String(id));else blockedNavNodes.delete(String(id));return true;}
  function navNext(start,goal){
    start=String(start);goal=String(goal);if(!navNodes.has(start)||!navNodes.has(goal))return '';
    const queue=[start],previous=new Map([[start,null]]);
    while(queue.length){const id=queue.shift();if(id===goal)break;for(const next of navNodes.get(id).links)if(!blockedNavNodes.has(next)&&!previous.has(next)){previous.set(next,id);queue.push(next);}}
    if(!previous.has(goal))return '';let step=goal;while(previous.get(step)!==start&&previous.get(step)!==null)step=previous.get(step);return step===start?'':step;
  }
  function navClear(){navNodes.clear();blockedNavNodes.clear();}
  function resetTransient(){attackTimes.clear();}
  window.PStudioGameplay={setMaxHP,setHP,getHP,getMaxHP,damage,heal,isAlive,attack,strike,follow,inventoryAdd,inventoryRemove,inventoryCount,questStart,questComplete,questIsComplete,questSetProgress,questGetProgress,navAddNode,navConnect,navBuildGrid,navBlock,navNext,navClear,resetTransient,version:'1.1.0'};
})();

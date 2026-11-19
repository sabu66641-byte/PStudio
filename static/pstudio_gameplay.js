/* PStudio Gameplay Systems 1.0.0
 * Per-object health, combat queries, inventory, quests and graph navigation.
 */
(() => {
  'use strict';
  const stats=new Map(), inventories=new Map(), quests=new Map(), navNodes=new Map(), blockedNavNodes=new Set(), attackTimes=new Map();
  const weaponCombos=new Map(), aiStates=new Map(), itemDefinitions=new Map(), equipment=new Map(), questDefinitions=new Map(), dialogueStates=new Map(), weaponDefinitions=new Map();
  let activeUI=null, lastDialogueChoice='';
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
  function defineItem(item,kind,slot,value){itemDefinitions.set(String(item),{kind:String(kind),slot:String(slot||''),value:Math.max(0,number(value))});return true;}
  function equipItem(id,item){const def=itemDefinitions.get(String(item));if(!def||def.kind!=='equipment'||inventoryCount(id,item)<=0)return false;const slots=equipment.get(id)||new Map();slots.set(def.slot||'main',String(item));equipment.set(id,slots);return true;}
  function getEquipment(id){return [...(equipment.get(id)||new Map()).entries()].map(([slot,item])=>({slot,item}));}
  function useItem(id,item){const def=itemDefinitions.get(String(item));if(!def||def.kind!=='consumable'||inventoryCount(id,item)<=0)return false;if(!inventoryRemove(id,item,1))return false;if(def.slot==='heal')heal(id,def.value);return true;}
  function getInventorySnapshot(id){return [...inventory(id).entries()].map(([item,count])=>({item,count,definition:itemDefinitions.get(item)||null,equipped:getEquipment(id).some(e=>e.item===item)}));}
  function questDefine(id,prerequisite,rewardItem,rewardCount){questDefinitions.set(String(id),{prerequisite:String(prerequisite||''),rewardItem:String(rewardItem||''),rewardCount:Math.max(0,Math.floor(number(rewardCount,0)))});return true;}
  function questStart(id){const key=String(id),def=questDefinitions.get(key);if(def?.prerequisite&&!questIsComplete(def.prerequisite))return false;if(!quests.has(key))quests.set(key,{started:true,complete:false,progress:0,target:1,rewarded:false});else quests.get(key).started=true;return true;}
  function questComplete(id,ownerId){const key=String(id),q=quests.get(key)||{started:true,complete:false,progress:0,target:1,rewarded:false};q.started=true;q.complete=true;q.progress=q.target;if(!q.rewarded&&ownerId){const def=questDefinitions.get(key);if(def?.rewardItem&&def.rewardCount>0)inventoryAdd(ownerId,def.rewardItem,def.rewardCount);q.rewarded=true;}quests.set(key,q);return true;}
  function questIsComplete(id){return !!quests.get(String(id))?.complete;}
  function questSetProgress(id,value,target=1){const key=String(id),q=quests.get(key)||{started:true,complete:false,progress:0,target:Math.max(1,number(target,1)),rewarded:false};q.started=true;q.target=Math.max(1,number(target,q.target));q.progress=clamp(number(value),0,q.target);if(q.progress>=q.target)q.complete=true;quests.set(key,q);return q.progress;}
  function questGetProgress(id){const q=quests.get(String(id));return q?q.progress:0;}
  function defineWeapon(name,range,arcDegrees,damageMultiplier=1){weaponDefinitions.set(String(name),{range:Math.max(0.1,number(range,2)),arc:clamp(number(arcDegrees,100),1,360),multiplier:Math.max(0,number(damageMultiplier,1))});return true;}
  function weaponAttack(sourceId,weapon,radius,amount,comboWindow,objects,physics){
    const source=resolveObject(sourceId,objects);if(!source||!isAlive(sourceId))return 0;
    const weaponDef=weaponDefinitions.get(String(weapon)),attackRange=weaponDef?.range??Math.max(0,number(radius)),minimumFacing=weaponDef?Math.cos(weaponDef.arc*Math.PI/360):0.25,weaponDamage=Math.max(0,number(amount))*(weaponDef?.multiplier??1);
    const now=Date.now(),old=weaponCombos.get(sourceId),windowMs=Math.max(150,number(comboWindow,1100));const combo=old&&now-old.time<=windowMs?old.count%5+1:1;weaponCombos.set(sourceId,{count:combo,time:now,weapon:String(weapon)});
    const a=position(source,physics),forwardX=Math.sin(number(source.rotationY)*Math.PI/180),forwardZ=Math.cos(number(source.rotationY)*Math.PI/180);let hits=0;
    for(const target of objects||[]){if(target.id===sourceId||!physics?.getBody?.(target.id)||!isAlive(target.id))continue;const b=position(target,physics),dx=b.x-a.x,dz=b.z-a.z,dist=Math.hypot(dx,dz);if(dist>attackRange)continue;if(dist>0.001&&(dx/dist)*forwardX+(dz/dist)*forwardZ<minimumFacing)continue;
      const multiplier=[1,1.08,1.22,1.45,1.8][combo-1];damage(target.id,weaponDamage*multiplier);hits++;
    }
    return hits;
  }
  function comboCount(id){return weaponCombos.get(id)?.count||0;}
  function enemyAI(sourceId,targetName,sightRange,attackRange,speed,objects,physics){
    const source=resolveObject(sourceId,objects),target=resolveObject(targetName,objects);if(!source||!target||!physics?.getBody?.(sourceId))return 'idle';
    if(!isAlive(sourceId)){aiStates.set(sourceId,'dead');physics.moveCharacter(sourceId,0,0);return 'dead';}
    const a=position(source,physics),b=position(target,physics),dx=b.x-a.x,dz=b.z-a.z,dist=Math.hypot(dx,dz),sight=Math.max(0,number(sightRange,12)),range=Math.max(0,number(attackRange,1.8));
    let state='idle';if(!isAlive(target.id))state='idle';else if(dist>sight)state='idle';else if(getHP(sourceId)<getMaxHP(sourceId)*0.18){state='retreat';const n=Math.max(0.001,dist);physics.moveCharacter(sourceId,-dx/n,-dz/n);}else if(dist>range){state='chase';if(navNodes.size){const nearest=p=>{let best='',score=Infinity;for(const [id,node] of navNodes){const d=Math.hypot(node.x-p.x,node.y-p.y,node.z-p.z);if(d<score){score=d;best=id;}}return best;};const start=nearest(a),goal=nearest(b),nextNode=navNext(start,goal),node=navNodes.get(nextNode||goal);if(node){const px=node.x-a.x,pz=node.z-a.z,len=Math.hypot(px,pz);physics.moveCharacter(sourceId,len>0.3?px/len:0,len>0.3?pz/len:0);}else follow(sourceId,targetName,speed,range,objects,physics);}else follow(sourceId,targetName,speed,range,objects,physics);}else{state='attack';physics.moveCharacter(sourceId,0,0);strike(sourceId,targetName,range,8,650,objects,physics);}
    if(state==='idle')physics.moveCharacter(sourceId,0,0);aiStates.set(sourceId,state);return state;
  }
  function getAIState(id){return aiStates.get(id)||'idle';}
  function openInventory(id){activeUI={type:'inventory',ownerId:String(id)};return true;}
  function openQuestLog(id){activeUI={type:'quests',ownerId:String(id)};return true;}
  function closeUI(){activeUI=null;return true;}
  function showDialogue(speaker,text,choice1,choice2,choice3){const choices=[choice1,choice2,choice3].filter(v=>String(v||'').trim());const signature=[speaker,text,...choices].join('|');if(dialogueStates.signature!==signature){dialogueStates.signature=signature;dialogueStates.choice='';lastDialogueChoice='';}dialogueStates.speaker=String(speaker);dialogueStates.text=String(text);dialogueStates.choices=choices;activeUI=dialogueStates.choice?null:{type:'dialogue'};return true;}
  function chooseDialogue(index){const choice=dialogueStates.choices?.[Math.max(0,Math.min(dialogueStates.choices.length-1,Math.floor(number(index))))];lastDialogueChoice=choice||'';dialogueStates.choice=lastDialogueChoice;activeUI=null;return lastDialogueChoice;}
  function getDialogueChoice(){return lastDialogueChoice;}
  function getUIState(){if(!activeUI)return null;if(activeUI.type==='dialogue')return {type:'dialogue',speaker:dialogueStates.speaker,text:dialogueStates.text,choices:dialogueStates.choices||[],choice:dialogueStates.choice||''};const id=activeUI.ownerId;if(activeUI.type==='inventory')return {type:'inventory',ownerId:id,items:getInventorySnapshot(id),equipment:getEquipment(id),hp:getHP(id),maxHp:getMaxHP(id)};return {type:'quests',ownerId:id,quests:[...quests.entries()].map(([quest,q])=>({quest,...q}))};}
  function uiAction(action,item,slot){if(!activeUI)return false;const id=activeUI.ownerId;if(action==='use')return useItem(id,item);if(action==='equip')return equipItem(id,item);if(action==='close')return closeUI();if(action==='dialogue')return chooseDialogue(item);return false;}

  function navAddNode(id,x,y,z){navNodes.set(String(id),{id:String(id),x:number(x),y:number(y),z:number(z),links:new Set()});return true;}
  function navConnect(a,b){a=navNodes.get(String(a));b=navNodes.get(String(b));if(!a||!b)return false;a.links.add(b.id);b.links.add(a.id);return true;}
  function navBuildGrid(x,z,width,depth,cell){const step=Math.max(0.5,number(cell,2)),cols=Math.max(1,Math.min(50,Math.floor(number(width)/step))),rows=Math.max(1,Math.min(50,Math.floor(number(depth)/step)));if(cols*rows>2500)return 0;navClear();for(let iz=0;iz<=rows;iz++)for(let ix=0;ix<=cols;ix++){const id='grid_'+ix+'_'+iz;navAddNode(id,number(x)+(ix/cols)*number(width),0,number(z)+(iz/rows)*number(depth));}for(let iz=0;iz<=rows;iz++)for(let ix=0;ix<=cols;ix++){const id='grid_'+ix+'_'+iz;if(ix<cols)navConnect(id,'grid_'+(ix+1)+'_'+iz);if(iz<rows)navConnect(id,'grid_'+ix+'_'+(iz+1));}return navNodes.size;}
  function navBlock(id,blocked=true){if(!navNodes.has(String(id)))return false;if(blocked)blockedNavNodes.add(String(id));else blockedNavNodes.delete(String(id));return true;}
  function navNext(start,goal){
    start=String(start);goal=String(goal);if(!navNodes.has(start)||!navNodes.has(goal)||blockedNavNodes.has(goal))return '';
    const distance=(a,b)=>{const p=navNodes.get(a),q=navNodes.get(b);return Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z);};
    const open=[start],came=new Map(),g=new Map([[start,0]]),f=new Map([[start,distance(start,goal)] ]),closed=new Set();
    while(open.length){open.sort((a,b)=>(f.get(a)||Infinity)-(f.get(b)||Infinity));const id=open.shift();if(id===goal)break;closed.add(id);for(const next of navNodes.get(id).links){if(blockedNavNodes.has(next)||closed.has(next))continue;const score=(g.get(id)||0)+distance(id,next);if(score<(g.get(next)??Infinity)){came.set(next,id);g.set(next,score);f.set(next,score+distance(next,goal));if(!open.includes(next))open.push(next);}}}
    if(start!==goal&&!came.has(goal))return '';let step=goal;while(came.get(step)!==start&&came.has(step))step=came.get(step);return step===start?'':step;
  }
  function navClear(){navNodes.clear();blockedNavNodes.clear();}
  function navBuildFromTerrain(x,y,z,width,depth,segments,height,maxSlope=50){const n=Math.max(2,Math.min(48,Math.floor(number(segments,12)))),w=Math.max(1,number(width)),d=Math.max(1,number(depth)),h=Math.max(0,number(height)),baseY=number(y),v=[];const at=(ix,iz)=>{const px=number(x)+(ix/n-.5)*w,pz=number(z)+(iz/n-.5)*d,lx=px-number(x),lz=pz-number(z),py=baseY+h*(Math.sin(lx*.18)*Math.cos(lz*.16)*.5+Math.sin((lx+lz)*.07)*.15);return [px,py,pz];};for(let iz=0;iz<n;iz++)for(let ix=0;ix<n;ix++){const a=at(ix,iz),b=at(ix+1,iz),c=at(ix,iz+1),e=at(ix+1,iz+1);v.push(...a,...c,...b,...b,...c,...e);}return navBuildFromTriangles(v,maxSlope);}
  function navBuildFromTriangles(vertices,maxSlope=50){if(!Array.isArray(vertices)||vertices.length<9)return 0;const slope=Math.cos(clamp(number(maxSlope,50),0,89)*Math.PI/180),nodes=[],edgeMap=new Map(),count=Math.min(2000,Math.floor(vertices.length/9));navClear();
    for(let i=0;i<count;i++){const tri=vertices.slice(i*9,i*9+9).map(number),a=tri.slice(0,3),b=tri.slice(3,6),c=tri.slice(6,9),ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]],nx=ab[1]*ac[2]-ab[2]*ac[1],ny=ab[2]*ac[0]-ab[0]*ac[2],nz=ab[0]*ac[1]-ab[1]*ac[0],len=Math.hypot(nx,ny,nz);if(len<1e-8||Math.abs(ny/len)<slope)continue;const id='navtri_'+nodes.length;const p={id,x:(a[0]+b[0]+c[0])/3,y:(a[1]+b[1]+c[1])/3,z:(a[2]+b[2]+c[2])/3,links:new Set()};nodes.push(p);navNodes.set(id,p);const verts=[a,b,c];for(let e=0;e<3;e++){const v1=verts[e],v2=verts[(e+1)%3],k1=v1.map(v=>Math.round(v*1000)).join(','),k2=v2.map(v=>Math.round(v*1000)).join(','),key=[k1,k2].sort().join('|');if(edgeMap.has(key)){const other=edgeMap.get(key);p.links.add(other.id);other.links.add(p.id);}else edgeMap.set(key,p);}}
    return nodes.length;}
  function resetTransient(){attackTimes.clear();weaponCombos.clear();}
  window.PStudioGameplay={setMaxHP,setHP,getHP,getMaxHP,damage,heal,isAlive,attack,strike,follow,inventoryAdd,inventoryRemove,inventoryCount,defineItem,equipItem,useItem,getEquipment,getInventorySnapshot,questDefine,questStart,questComplete,questIsComplete,questSetProgress,questGetProgress,weaponAttack,comboCount,enemyAI,getAIState,openInventory,openQuestLog,closeUI,showDialogue,chooseDialogue,getDialogueChoice,getUIState,uiAction,navAddNode,navConnect,navBuildGrid,navBuildFromTriangles,navBuildFromTerrain,defineWeapon,navBlock,navNext,navClear,resetTransient,version:'2.0.0'};
})();

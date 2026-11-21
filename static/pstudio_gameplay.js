/* PStudio Gameplay Systems 1.0.0
 * Per-object health, combat queries, inventory, quests and graph navigation.
 */
(() => {
  'use strict';
  const stats=new Map(), inventories=new Map(), quests=new Map(), navNodes=new Map(), blockedNavNodes=new Set(), attackTimes=new Map();
  const weaponCombos=new Map(), aiStates=new Map(), itemDefinitions=new Map(), equipment=new Map(), questDefinitions=new Map(), weaponDefinitions=new Map();
  const questEntities=new Map();
  let activeUI=null, lastDialogueChoice='';
  const ecsGameplay=()=>window.PStudioECSGameplay||null;
  function sceneComponent(id,type,defaults){return ecsGameplay()?.ensureSceneComponent?.(String(id),type,defaults)||null;}
  function commitSceneComponent(id,type,value){return ecsGameplay()?.commitSceneComponent?.(String(id),type,value)||false;}
  function worldState(){return ecsGameplay()?.getWorldState?.()||null;}
  function commitWorld(value){return ecsGameplay()?.commitWorldState?.(value)||false;}

  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const number=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
  function stat(id){const state=sceneComponent(id,'Health',stats.get(id)||{max:100,hp:100,configured:false});if(state){stats.delete(id);return state;}if(!stats.has(id))stats.set(id,{max:100,hp:100,configured:false});return stats.get(id);}
  function setMaxHP(id,value){const s=stat(id);s.max=Math.max(1,number(value,100));s.hp=s.configured?clamp(s.hp,0,s.max):s.max;s.configured=true;commitSceneComponent(id,'Health',s);return s.max;}
  function setHP(id,value){const s=stat(id);s.hp=clamp(number(value),0,s.max);s.configured=true;commitSceneComponent(id,'Health',s);return s.hp;}
  function getHP(id){return stat(id).hp;}
  function getMaxHP(id){return stat(id).max;}
  function damage(id,value){const s=stat(id);s.hp=clamp(s.hp-Math.max(0,number(value)),0,s.max);commitSceneComponent(id,'Health',s);return s.hp;}
  function heal(id,value){const s=stat(id);s.hp=clamp(s.hp+Math.max(0,number(value)),0,s.max);commitSceneComponent(id,'Health',s);return s.hp;}
  function isAlive(id){return getHP(id)>0;}
  function resolveObject(name,objects){return (objects||[]).find(o=>String(o.id)===String(name)||String(o.name)===String(name))||null;}
  function position(o,physics){const p=physics?.getPosition?.(o.id);if(p)return p;return{x:((number(o.x)+number(o.w,64)/2)-480)/100,y:(270-(number(o.y)+number(o.h,64)/2))/100,z:number(o.z)/100};}
  function getAttackTime(sourceId,targetId){const state=ecsGameplay()?.getSceneComponent?.(String(sourceId),'CombatState');if(state)return number(state.cooldowns[String(targetId)],0);return attackTimes.get(String(sourceId)+'>'+String(targetId))||0;}
  function setAttackTime(sourceId,targetId,time){const state=combatComponent(sourceId);if(state){state.cooldowns[String(targetId)]=time;commitSceneComponent(sourceId,'CombatState',state);}else attackTimes.set(String(sourceId)+'>'+String(targetId),time);}
  function attack(sourceId,radius,amount,objects,physics,cooldown=220){
    const source=resolveObject(sourceId,objects);if(!source||!isAlive(sourceId))return 0;
    const origin=position(source,physics),r=Math.max(0,number(radius)),now=Date.now();let hits=0;
    for(const target of objects||[]){if(target.id===sourceId||!physics?.getBody?.(target.id)||!isAlive(target.id))continue;
      const p=position(target,physics),distance=Math.hypot(p.x-origin.x,p.y-origin.y,p.z-origin.z);
      if(distance>r)continue;const last=getAttackTime(sourceId,target.id);
      if(now-last<Math.max(0,number(cooldown,220)))continue;setAttackTime(sourceId,target.id,now);damage(target.id,amount);hits++;
    }
    return hits;
  }
  function strike(sourceId,targetName,range,amount,cooldown,objects,physics){
    const source=resolveObject(sourceId,objects),target=resolveObject(targetName,objects);if(!source||!target||!isAlive(sourceId)||!isAlive(target.id))return false;
    const a=position(source,physics),b=position(target,physics);if(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)>Math.max(0,number(range)))return false;
    const now=Date.now(),last=getAttackTime(sourceId,target.id);if(now-last<Math.max(0,number(cooldown,500)))return false;setAttackTime(sourceId,target.id,now);damage(target.id,amount);return true;
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
  function inventoryComponent(id){
    const bag=inventories.get(id);
    const state=sceneComponent(id,'Inventory',{items:bag?[...bag.entries()].map(([item,count])=>({item,count})):[]});
    if(state)inventories.delete(id);
    return state;
  }
  function equipmentComponent(id){
    const slots=equipment.get(id);
    const state=sceneComponent(id,'Equipment',{slots:slots?[...slots.entries()].map(([slot,item])=>({slot,item})):[]});
    if(state)equipment.delete(id);
    return state;
  }
  function combatComponent(id){
    const key=String(id),cooldowns=Object.create(null),prefix=key+'>';
    for(const [pair,time] of attackTimes)if(pair.startsWith(prefix))cooldowns[pair.slice(prefix.length)]=time;
    const old=weaponCombos.get(id);
    const state=sceneComponent(id,'CombatState',{comboCount:old?.count||0,comboTime:old?.time||0,comboWeapon:old?.weapon||'',cooldowns});
    if(state){for(const pair of [...attackTimes.keys()])if(pair.startsWith(prefix))attackTimes.delete(pair);weaponCombos.delete(id);}
    return state;
  }
  function aiComponent(id){const state=sceneComponent(id,'AIState',{state:aiStates.get(id)||'idle'});if(state)aiStates.delete(id);return state;}
  function inventoryAdd(id,item,count=1){
    const key=String(item),added=Math.max(1,Math.floor(number(count,1))),state=inventoryComponent(id);
    if(state){const entry=state.items.find(value=>value.item===key);if(entry)entry.count+=added;else state.items.push({item:key,count:added});commitSceneComponent(id,'Inventory',state);return entry?entry.count:added;}
    const bag=inventory(id),next=(bag.get(key)||0)+added;bag.set(key,next);return next;
  }
  function inventoryRemove(id,item,count=1){
    const key=String(item),n=Math.max(1,Math.floor(number(count,1))),state=sceneComponent(id,'Inventory',{items:[]});
    if(state){const entry=state.items.find(value=>value.item===key);if(!entry||entry.count<n)return false;entry.count-=n;if(entry.count<=0)state.items=state.items.filter(value=>value!==entry);commitSceneComponent(id,'Inventory',state);return true;}
    const bag=inventory(id),old=bag.get(key)||0;if(old<n)return false;if(old===n)bag.delete(key);else bag.set(key,old-n);return true;
  }
  function inventoryCount(id,item){const key=String(item),state=sceneComponent(id,'Inventory',{items:[]});if(state)return state.items.find(value=>value.item===key)?.count||0;return inventory(id).get(key)||0;}
  function defineItem(item,kind,slot,value){itemDefinitions.set(String(item),{kind:String(kind),slot:String(slot||''),value:Math.max(0,number(value))});return true;}
  function equipItem(id,item){const def=itemDefinitions.get(String(item));if(!def||def.kind!=='equipment'||inventoryCount(id,item)<=0)return false;const state=equipmentComponent(id);if(state){const slot=def.slot||'main',entry=state.slots.find(value=>value.slot===slot);if(entry)entry.item=String(item);else state.slots.push({slot,item:String(item)});commitSceneComponent(id,'Equipment',state);return true;}const slots=equipment.get(id)||new Map();slots.set(def.slot||'main',String(item));equipment.set(id,slots);return true;}
  function getEquipment(id){const state=sceneComponent(id,'Equipment',{slots:[]});return state?state.slots.map(value=>({slot:value.slot,item:value.item})):[...(equipment.get(id)||new Map()).entries()].map(([slot,item])=>({slot,item}));}
  function useItem(id,item){const def=itemDefinitions.get(String(item));if(!def||def.kind!=='consumable'||inventoryCount(id,item)<=0)return false;if(!inventoryRemove(id,item,1))return false;if(def.slot==='heal')heal(id,def.value);return true;}
  function getInventorySnapshot(id){const state=inventoryComponent(id);const entries=state?state.items.map(value=>[value.item,value.count]):[...inventory(id).entries()];return entries.map(([item,count])=>({item,count,definition:itemDefinitions.get(item)||null,equipped:getEquipment(id).some(e=>e.item===item)}));}
  function questRecord(id,create=false){
    const key=String(id),bridge=ecsGameplay();
    if(bridge?.isAvailable?.()){
      let entity=questEntities.get(key),data=entity?bridge.getEntityComponent(entity,'Quest'):null;
      if(!data){const found=bridge.queryData('Quest').find(entry=>entry.data.questId===key);if(found){entity=found.entity;data=found.data;questEntities.set(key,entity);}}
      if(!data&&create){entity=bridge.createDataEntity('Quest',{questId:key,prerequisite:'',rewardItem:'',rewardCount:0,started:false,complete:false,progress:0,target:1,rewarded:false});if(entity){questEntities.set(key,entity);data=bridge.getEntityComponent(entity,'Quest');}}
      return data?{data,commit:()=>bridge.setEntityComponent(entity,'Quest',data)}:null;
    }
    let data=quests.get(key);
    if(!data&&create){const def=questDefinitions.get(key)||{};data={questId:key,prerequisite:def.prerequisite||'',rewardItem:def.rewardItem||'',rewardCount:def.rewardCount||0,started:false,complete:false,progress:0,target:1,rewarded:false};quests.set(key,data);}
    return data?{data,commit:()=>quests.set(key,data)}:null;
  }
  function questDefine(id,prerequisite,rewardItem,rewardCount){
    const def={prerequisite:String(prerequisite||''),rewardItem:String(rewardItem||''),rewardCount:Math.max(0,Math.floor(number(rewardCount,0)))};
    questDefinitions.set(String(id),def);
    const record=questRecord(id,true);if(record){Object.assign(record.data,def);record.commit();}
    return true;
  }
  function questStart(id){
    const record=questRecord(id,true);if(!record)return false;
    if(record.data.prerequisite&&!questIsComplete(record.data.prerequisite))return false;
    record.data.started=true;record.commit();return true;
  }
  function questComplete(id,ownerId){
    const record=questRecord(id,true);if(!record)return false;
    const q=record.data;q.started=true;q.complete=true;q.progress=q.target;
    if(!q.rewarded&&ownerId){if(q.rewardItem&&q.rewardCount>0)inventoryAdd(ownerId,q.rewardItem,q.rewardCount);q.rewarded=true;}
    record.commit();return true;
  }
  function questIsComplete(id){return !!questRecord(id,false)?.data.complete;}
  function questSetProgress(id,value,target=1){
    const record=questRecord(id,true);if(!record)return 0;
    const q=record.data;q.started=true;q.target=Math.max(1,number(target,q.target));q.progress=clamp(number(value),0,q.target);if(q.progress>=q.target)q.complete=true;
    record.commit();return q.progress;
  }
  function questGetProgress(id){return questRecord(id,false)?.data.progress||0;}
  function listQuestStates(){
    const bridge=ecsGameplay();
    if(bridge?.isAvailable?.())return bridge.queryData('Quest').map(entry=>entry.data).filter(q=>q.started||q.complete).map(q=>({quest:q.questId,started:q.started,complete:q.complete,progress:q.progress,target:q.target,rewarded:q.rewarded}));
    return [...quests.entries()].map(([quest,q])=>({quest,...q})).filter(q=>q.started||q.complete);
  }
  function defineWeapon(name,range,arcDegrees,damageMultiplier=1){weaponDefinitions.set(String(name),{range:Math.max(0.1,number(range,2)),arc:clamp(number(arcDegrees,100),1,360),multiplier:Math.max(0,number(damageMultiplier,1))});return true;}
  function weaponAttack(sourceId,weapon,radius,amount,comboWindow,objects,physics){
    const source=resolveObject(sourceId,objects);if(!source||!isAlive(sourceId))return 0;
    const weaponDef=weaponDefinitions.get(String(weapon)),attackRange=weaponDef?.range??Math.max(0,number(radius)),minimumFacing=weaponDef?Math.cos(weaponDef.arc*Math.PI/360):0.25,weaponDamage=Math.max(0,number(amount))*(weaponDef?.multiplier??1);
    const now=Date.now(),combat=combatComponent(sourceId),old=combat?{count:combat.comboCount,time:combat.comboTime}:weaponCombos.get(sourceId),windowMs=Math.max(150,number(comboWindow,1100));const combo=old&&now-old.time<=windowMs?old.count%5+1:1;if(combat){combat.comboCount=combo;combat.comboTime=now;combat.comboWeapon=String(weapon);commitSceneComponent(sourceId,'CombatState',combat);}else weaponCombos.set(sourceId,{count:combo,time:now,weapon:String(weapon)});
    const a=position(source,physics),forwardX=Math.sin(number(source.rotationY)*Math.PI/180),forwardZ=Math.cos(number(source.rotationY)*Math.PI/180);let hits=0;
    for(const target of objects||[]){if(target.id===sourceId||!physics?.getBody?.(target.id)||!isAlive(target.id))continue;const b=position(target,physics),dx=b.x-a.x,dz=b.z-a.z,dist=Math.hypot(dx,dz);if(dist>attackRange)continue;if(dist>0.001&&(dx/dist)*forwardX+(dz/dist)*forwardZ<minimumFacing)continue;
      const multiplier=[1,1.08,1.22,1.45,1.8][combo-1];damage(target.id,weaponDamage*multiplier);hits++;
    }
    return hits;
  }
  function comboCount(id){return ecsGameplay()?.getSceneComponent?.(String(id),'CombatState')?.comboCount||weaponCombos.get(id)?.count||0;}
  function enemyAI(sourceId,targetName,sightRange,attackRange,speed,objects,physics){
    const source=resolveObject(sourceId,objects),target=resolveObject(targetName,objects);if(!source||!target||!physics?.getBody?.(sourceId))return 'idle';
    if(!isAlive(sourceId)){setAIState(sourceId,'dead');physics.moveCharacter(sourceId,0,0);return 'dead';}
    const a=position(source,physics),b=position(target,physics),dx=b.x-a.x,dz=b.z-a.z,dist=Math.hypot(dx,dz),sight=Math.max(0,number(sightRange,12)),range=Math.max(0,number(attackRange,1.8));
    let state='idle';if(!isAlive(target.id))state='idle';else if(dist>sight)state='idle';else if(getHP(sourceId)<getMaxHP(sourceId)*0.18){state='retreat';const n=Math.max(0.001,dist);physics.moveCharacter(sourceId,-dx/n,-dz/n);}else if(dist>range){state='chase';if(navNodes.size){const nearest=p=>{let best='',score=Infinity;for(const id of navNodes.keys()){const node=getNavNode(id);if(!node)continue;const d=Math.hypot(node.x-p.x,node.y-p.y,node.z-p.z);if(d<score){score=d;best=id;}}return best;};const start=nearest(a),goal=nearest(b),nextNode=navNext(start,goal),node=navNodes.get(nextNode||goal);if(node){const px=node.x-a.x,pz=node.z-a.z,len=Math.hypot(px,pz);physics.moveCharacter(sourceId,len>0.3?px/len:0,len>0.3?pz/len:0);}else follow(sourceId,targetName,speed,range,objects,physics);}else follow(sourceId,targetName,speed,range,objects,physics);}else{state='attack';physics.moveCharacter(sourceId,0,0);strike(sourceId,targetName,range,8,650,objects,physics);}
    if(state==='idle')physics.moveCharacter(sourceId,0,0);setAIState(sourceId,state);return state;
  }
  function getAIState(id){return ecsGameplay()?.getSceneComponent?.(String(id),'AIState')?.state||aiStates.get(id)||'idle';}
  function setAIState(id,value){const state=aiComponent(id);if(state){state.state=value;commitSceneComponent(id,'AIState',state);}else aiStates.set(id,value);}
  function getActiveUI(){return worldState()?.ui||activeUI;}
  function setActiveUI(value){const world=worldState();if(world){world.ui=value?{type:String(value.type||''),ownerId:String(value.ownerId||'')}:null;commitWorld(world);}else activeUI=value;}
  function dialogueState(){const world=worldState();if(world)return world.dialogue;return dialogueFallback;}
  const dialogueFallback={signature:'',speaker:'',text:'',choices:[],choice:'',lastChoice:''};
  function openInventory(id){setActiveUI({type:'inventory',ownerId:String(id)});return true;}
  function openQuestLog(id){setActiveUI({type:'quests',ownerId:String(id)});return true;}
  function closeUI(){setActiveUI(null);return true;}
  function showDialogue(speaker,text,choice1,choice2,choice3){
    const dialogue=dialogueState(),choices=[choice1,choice2,choice3].filter(v=>String(v||'').trim()),signature=[speaker,text,...choices].join('|');
    if(dialogue.signature!==signature){dialogue.signature=signature;dialogue.choice='';dialogue.lastChoice='';lastDialogueChoice='';}
    dialogue.speaker=String(speaker);dialogue.text=String(text);dialogue.choices=choices;
    const world=worldState();if(world){world.dialogue=dialogue;commitWorld(world);}
    setActiveUI(dialogue.choice?null:{type:'dialogue'});return true;
  }
  function chooseDialogue(index){
    const dialogue=dialogueState(),choice=dialogue.choices?.[Math.max(0,Math.min(dialogue.choices.length-1,Math.floor(number(index))))];
    dialogue.lastChoice=choice||'';dialogue.choice=dialogue.lastChoice;lastDialogueChoice=dialogue.lastChoice;
    const world=worldState();if(world){world.dialogue=dialogue;commitWorld(world);}
    setActiveUI(null);return lastDialogueChoice;
  }
  function getDialogueChoice(){return dialogueState().lastChoice||lastDialogueChoice;}
  function getUIState(){
    const active=getActiveUI();if(!active||!active.type)return null;
    if(active.type==='dialogue'){const dialogue=dialogueState();return {type:'dialogue',speaker:dialogue.speaker,text:dialogue.text,choices:dialogue.choices||[],choice:dialogue.choice||''};}
    const id=active.ownerId;if(active.type==='inventory')return {type:'inventory',ownerId:id,items:getInventorySnapshot(id),equipment:getEquipment(id),hp:getHP(id),maxHp:getMaxHP(id)};
    return {type:'quests',ownerId:id,quests:listQuestStates()};
  }
  function uiAction(action,item,slot){const active=getActiveUI();if(!active)return false;const id=active.ownerId;if(action==='use')return useItem(id,item);if(action==='equip')return equipItem(id,item);if(action==='close')return closeUI();if(action==='dialogue')return chooseDialogue(item);return false;}

  function getNavNode(id){const value=navNodes.get(String(id));if(value===undefined)return null;if(typeof value==='number')return ecsGameplay()?.getEntityComponent?.(value,'NavigationNode')||null;return value;}
  function commitNavNode(id,node){const value=navNodes.get(String(id));if(typeof value==='number')return ecsGameplay()?.setEntityComponent?.(value,'NavigationNode',node)||false;navNodes.set(String(id),node);return true;}
  function navAddNode(id,x,y,z){
    const key=String(id),node={nodeId:key,x:number(x),y:number(y),z:number(z),links:[],blocked:false},bridge=ecsGameplay();
    const previous=navNodes.get(key);if(typeof previous==='number')bridge?.destroyDataEntity?.(previous);
    const entity=bridge?.createDataEntity?.('NavigationNode',node);
    if(entity){navNodes.set(key,entity);return true;}
    navNodes.set(key,{id:key,x:node.x,y:node.y,z:node.z,links:new Set()});return true;
  }
  function navConnect(first,second){
    const a=getNavNode(first),b=getNavNode(second);if(!a||!b)return false;
    if(Array.isArray(a.links)){if(!a.links.includes(String(second)))a.links.push(String(second));commitNavNode(first,a);}
    else a.links.add(String(second));
    if(Array.isArray(b.links)){if(!b.links.includes(String(first)))b.links.push(String(first));commitNavNode(second,b);}
    else b.links.add(String(first));
    return true;
  }
  function navBuildGrid(x,z,width,depth,cell){const step=Math.max(0.5,number(cell,2)),cols=Math.max(1,Math.min(50,Math.floor(number(width)/step))),rows=Math.max(1,Math.min(50,Math.floor(number(depth)/step)));if(cols*rows>2500)return 0;navClear();for(let iz=0;iz<=rows;iz++)for(let ix=0;ix<=cols;ix++){const id='grid_'+ix+'_'+iz;navAddNode(id,number(x)+(ix/cols)*number(width),0,number(z)+(iz/rows)*number(depth));}for(let iz=0;iz<=rows;iz++)for(let ix=0;ix<=cols;ix++){const id='grid_'+ix+'_'+iz;if(ix<cols)navConnect(id,'grid_'+(ix+1)+'_'+iz);if(iz<rows)navConnect(id,'grid_'+ix+'_'+(iz+1));}return navNodes.size;}
  function navBlock(id,blocked=true){const node=getNavNode(id);if(!node)return false;if(Array.isArray(node.links)){node.blocked=!!blocked;commitNavNode(id,node);}else if(blocked)blockedNavNodes.add(String(id));else blockedNavNodes.delete(String(id));return true;}
  function navNext(start,goal){
    start=String(start);goal=String(goal);const startNode=getNavNode(start),goalNode=getNavNode(goal);
    if(!startNode||!goalNode||goalNode.blocked||blockedNavNodes.has(goal))return '';
    const distance=(a,b)=>{const p=getNavNode(a),q=getNavNode(b);return p&&q?Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z):Infinity;};
    const links=node=>Array.isArray(node.links)?node.links:[...(node.links||[])];
    const blocked=id=>!!getNavNode(id)?.blocked||blockedNavNodes.has(id);
    const open=[start],came=new Map(),g=new Map([[start,0]]),f=new Map([[start,distance(start,goal)]]),closed=new Set();
    while(open.length){open.sort((a,b)=>(f.get(a)||Infinity)-(f.get(b)||Infinity));const id=open.shift();if(id===goal)break;closed.add(id);const currentNode=getNavNode(id);if(!currentNode)continue;for(const next of links(currentNode)){if(blocked(next)||closed.has(next))continue;const score=(g.get(id)||0)+distance(id,next);if(score<(g.get(next)??Infinity)){came.set(next,id);g.set(next,score);f.set(next,score+distance(next,goal));if(!open.includes(next))open.push(next);}}}
    if(start!==goal&&!came.has(goal))return '';let step=goal;while(came.get(step)!==start&&came.has(step))step=came.get(step);return step===start?'':step;
  }
  function navClear(){
    const bridge=ecsGameplay();
    for(const value of navNodes.values())if(typeof value==='number')bridge?.destroyDataEntity?.(value);
    navNodes.clear();blockedNavNodes.clear();
  }
  function navBuildFromTerrain(x,y,z,width,depth,segments,height,maxSlope=50){const n=Math.max(2,Math.min(48,Math.floor(number(segments,12)))),w=Math.max(1,number(width)),d=Math.max(1,number(depth)),h=Math.max(0,number(height)),baseY=number(y),v=[];const at=(ix,iz)=>{const px=number(x)+(ix/n-.5)*w,pz=number(z)+(iz/n-.5)*d,lx=px-number(x),lz=pz-number(z),py=baseY+h*(Math.sin(lx*.18)*Math.cos(lz*.16)*.5+Math.sin((lx+lz)*.07)*.15);return [px,py,pz];};for(let iz=0;iz<n;iz++)for(let ix=0;ix<n;ix++){const a=at(ix,iz),b=at(ix+1,iz),c=at(ix,iz+1),e=at(ix+1,iz+1);v.push(...a,...c,...b,...b,...c,...e);}return navBuildFromTriangles(v,maxSlope);}
  function navBuildFromTriangles(vertices,maxSlope=50){
    if(!Array.isArray(vertices)||vertices.length<9)return 0;
    const slope=Math.cos(clamp(number(maxSlope,50),0,89)*Math.PI/180),nodes=[],edgeMap=new Map(),count=Math.min(2000,Math.floor(vertices.length/9));
    navClear();
    for(let i=0;i<count;i++){
      const tri=vertices.slice(i*9,i*9+9).map(number),a=tri.slice(0,3),b=tri.slice(3,6),c=tri.slice(6,9),
        ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]],
        nx=ab[1]*ac[2]-ab[2]*ac[1],ny=ab[2]*ac[0]-ab[0]*ac[2],nz=ab[0]*ac[1]-ab[1]*ac[0],len=Math.hypot(nx,ny,nz);
      if(len<1e-8||Math.abs(ny/len)<slope)continue;
      const id='navtri_'+nodes.length,p={id,x:(a[0]+b[0]+c[0])/3,y:(a[1]+b[1]+c[1])/3,z:(a[2]+b[2]+c[2])/3};
      navAddNode(id,p.x,p.y,p.z);nodes.push({id,vertices:[a,b,c]});
      for(let e=0;e<3;e++){
        const v1=[a,b,c][e],v2=[a,b,c][(e+1)%3],k1=v1.map(v=>Math.round(v*1000)).join(','),k2=v2.map(v=>Math.round(v*1000)).join(','),key=[k1,k2].sort().join('|');
        if(edgeMap.has(key))navConnect(id,edgeMap.get(key));else edgeMap.set(key,id);
      }
    }
    return nodes.length;
  }
  function resetTransient(){attackTimes.clear();weaponCombos.clear();ecsGameplay()?.resetCombatTransient?.();}
  window.PStudioGameplay={setMaxHP,setHP,getHP,getMaxHP,damage,heal,isAlive,attack,strike,follow,inventoryAdd,inventoryRemove,inventoryCount,defineItem,equipItem,useItem,getEquipment,getInventorySnapshot,questDefine,questStart,questComplete,questIsComplete,questSetProgress,questGetProgress,weaponAttack,comboCount,enemyAI,getAIState,openInventory,openQuestLog,closeUI,showDialogue,chooseDialogue,getDialogueChoice,getUIState,uiAction,navAddNode,navConnect,navBuildGrid,navBuildFromTriangles,navBuildFromTerrain,defineWeapon,navBlock,navNext,navClear,resetTransient,version:'2.1.0'};
})();

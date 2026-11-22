/* PStudio Gameplay Systems 1.0.0
 * Per-object health, combat queries, inventory, quests and graph navigation.
 */
(() => {
  'use strict';
  const stats=new Map(), inventories=new Map(), quests=new Map(), fallbackNavNodes=new Map(), fallbackBlockedNavNodes=new Set(), attackTimes=new Map();
  const weaponCombos=new Map(), aiStates=new Map(), itemDefinitions=new Map(), equipment=new Map(), questDefinitions=new Map(), dialogueStates=new Map(), weaponDefinitions=new Map();
  let activeUI=null, lastDialogueChoice='';
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const number=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
  const hasOwn=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
  function setRecordValue(record,key,value){
    Object.defineProperty(record,String(key),{value,enumerable:true,configurable:true,writable:true});
  }
  function stat(id){const ecsHealth=window.PStudioECSGameplay?.getHealth?.(id);if(ecsHealth)return ecsHealth;if(!stats.has(id))stats.set(id,{max:100,hp:100,configured:false});return stats.get(id);}
  function initializeECS(sceneObjects){
    const bridge=window.PStudioECSGameplay;
    if(!bridge?.initialize)return false;
    const legacy={
      getHealth:id=>stats.get(id),
      setHealth:(id,value)=>stats.set(id,value),
      getInventory:id=>Object.fromEntries(inventories.get(id)||new Map()),
      setInventory:(id,value)=>inventories.set(id,new Map(Object.entries(value||{}).map(([key,count])=>[key,Math.max(0,Math.floor(number(count)))]))),
      getEquipment:id=>Object.fromEntries(equipment.get(id)||new Map()),
      setEquipment:(id,value)=>equipment.set(id,new Map(Object.entries(value||{}))),
      getCombat:id=>{
        const cooldowns=Object.create(null);
        const prefix=String(id)+'>';
        for(const [key,value] of attackTimes)if(key.startsWith(prefix)){
          const target=key.slice(prefix.length);
          setRecordValue(cooldowns,target,typeof value==='number'?{at:value,duration:0}:value);
        }
        const combo=weaponCombos.get(id)||{count:0,time:0,weapon:''};
        return {cooldowns,comboCount:combo.count||0,comboTime:combo.time||0,comboWeapon:combo.weapon||''};
      },
      setCombat:(id,value)=>{
        const prefix=String(id)+'>';
        for(const key of [...attackTimes.keys()])if(key.startsWith(prefix))attackTimes.delete(key);
        for(const [target,record] of Object.entries(value?.cooldowns||{}))attackTimes.set(prefix+target,record);
        if(value?.comboCount)weaponCombos.set(id,{count:value.comboCount,time:value.comboTime||0,weapon:value.comboWeapon||''});
        else weaponCombos.delete(id);
      },
      getAIState:id=>aiStates.get(id),
      setAIState:(id,value)=>aiStates.set(id,String(value||'idle')),
      getQuests:()=>[...quests.entries()],
      setQuests:entries=>{quests.clear();for(const [id,value] of entries||[])quests.set(String(id),value);},
      getDialogue:()=>({...dialogueStates,choices:[...(dialogueStates.choices||[])],choice:dialogueStates.choice||lastDialogueChoice||'',active:activeUI?.type==='dialogue'}),
      setDialogue:value=>{
        Object.assign(dialogueStates,{
          signature:String(value.signature||''),speaker:String(value.speaker||''),
          text:String(value.text||''),choices:Array.isArray(value.choices)?[...value.choices]:[],
          choice:String(value.choice||'')
        });
        lastDialogueChoice=dialogueStates.choice;
      }
    };
    return bridge.initialize(sceneObjects||[],legacy);
  }
  function persistECS(sceneObjects){
    const bridge=window.PStudioECSGameplay;
    if(!bridge?.persist)return false;
    const legacy={
      setHealth:(id,value)=>stats.set(id,value),
      setInventory:(id,value)=>inventories.set(id,new Map(Object.entries(value||{}).map(([key,count])=>[key,Math.max(0,Math.floor(number(count)))]))),
      setEquipment:(id,value)=>equipment.set(id,new Map(Object.entries(value||{}))),
      setCombat:(id,value)=>{
        const prefix=String(id)+'>';
        for(const key of [...attackTimes.keys()])if(key.startsWith(prefix))attackTimes.delete(key);
        for(const [target,record] of Object.entries(value?.cooldowns||{}))attackTimes.set(prefix+target,record);
        if(value?.comboCount)weaponCombos.set(id,{count:value.comboCount,time:value.comboTime||0,weapon:value.comboWeapon||''});
        else weaponCombos.delete(id);
      },
      setAIState:(id,value)=>aiStates.set(id,String(value||'idle')),
      setQuests:entries=>{quests.clear();for(const [id,value] of entries||[])quests.set(String(id),value);},
      setDialogue:value=>{
        Object.assign(dialogueStates,{
          signature:String(value.signature||''),speaker:String(value.speaker||''),
          text:String(value.text||''),choices:Array.isArray(value.choices)?[...value.choices]:[],
          choice:String(value.choice||'')
        });
        lastDialogueChoice=dialogueStates.choice;
      }
    };
    return bridge.persist(sceneObjects||[],legacy);
  }
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
      if(distance>r)continue;
      const ready=window.PStudioECSGameplay?.canAttack?.(sourceId,target.id,cooldown,now);
      if(ready===false)continue;
      if(ready===null){const key=String(sourceId)+'>'+String(target.id),record=attackTimes.get(key),last=typeof record==='number'?record:Number(record?.at||0),duration=Math.max(0,number(cooldown,220));if(now-last<duration)continue;attackTimes.set(key,{at:now,duration});}
      damage(target.id,amount);hits++;
    }
    return hits;
  }
  function strike(sourceId,targetName,range,amount,cooldown,objects,physics){
    const source=resolveObject(sourceId,objects),target=resolveObject(targetName,objects);if(!source||!target||!isAlive(sourceId)||!isAlive(target.id))return false;
    const a=position(source,physics),b=position(target,physics);if(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)>Math.max(0,number(range)))return false;
    const now=Date.now(),ready=window.PStudioECSGameplay?.canAttack?.(sourceId,target.id,cooldown,now);
    if(ready===false)return false;
    if(ready===null){const key=String(sourceId)+'>'+String(target.id),record=attackTimes.get(key),last=typeof record==='number'?record:Number(record?.at||0),duration=Math.max(0,number(cooldown,500));if(now-last<duration)return false;attackTimes.set(key,{at:now,duration});}
    damage(target.id,amount);return true;
  }
  function follow(sourceId,targetName,speed,stopDistance,objects,physics){
    const source=resolveObject(sourceId,objects),target=resolveObject(targetName,objects);
    if(!source||!target||!physics?.getBody?.(sourceId))return false;
    const a=position(source,physics),b=position(target,physics),dx=b.x-a.x,dz=b.z-a.z,dist=Math.hypot(dx,dz),stop=Math.max(0,number(stopDistance,1));
    const x=dist<=stop||dist<=0.000001?0:dx/dist,z=dist<=stop||dist<=0.000001?0:dz/dist;
    const queued=window.PStudioECSGameplay?.setMovementIntent?.(sourceId,{
      x,z,maxSpeed:number(speed)>0?Math.max(0.1,number(speed)):0,acceleration:24,airControl:0.25,
      active:true,mode:'manual',targetId:String(target.id)
    });
    if(queued){const ai=window.PStudioECSGameplay?.getAIController?.(sourceId);if(ai)ai.enabled=false;return true;}
    if(number(speed)>0)physics.configureController(sourceId,Math.max(0.1,number(speed)),24,0.25);
    physics.moveCharacter(sourceId,x,z);return true;
  }
  function inventory(id){if(!inventories.has(id))inventories.set(id,new Map());return inventories.get(id);}
  function inventoryEntries(id){
    const state=window.PStudioECSGameplay?.getInventory?.(id);
    return state?.items&&typeof state.items==='object'?Object.entries(state.items):[...inventory(id).entries()];
  }
  function inventoryAdd(id,item,count=1){
    const key=String(item),amount=Math.max(1,Math.floor(number(count,1)));
    const state=window.PStudioECSGameplay?.getInventory?.(id,true);
    if(state){const next=(hasOwn(state.items,key)?Number(state.items[key])||0:0)+amount;setRecordValue(state.items,key,next);return next;}
    const bag=inventory(id),next=(bag.get(key)||0)+amount;bag.set(key,next);return next;
  }
  function inventoryRemove(id,item,count=1){
    const key=String(item),n=Math.max(1,Math.floor(number(count,1)));
    const state=window.PStudioECSGameplay?.getInventory?.(id,true);
    if(state){const old=hasOwn(state.items,key)?Number(state.items[key])||0:0;if(old<n)return false;if(old===n)delete state.items[key];else setRecordValue(state.items,key,old-n);return true;}
    const bag=inventory(id),old=bag.get(key)||0;if(old<n)return false;if(old===n)bag.delete(key);else bag.set(key,old-n);return true;
  }
  function inventoryCount(id,item){
    const state=window.PStudioECSGameplay?.getInventory?.(id);
    const key=String(item);return state?(hasOwn(state.items,key)?Number(state.items[key])||0:0):inventory(id).get(key)||0;
  }
  function defineItem(item,kind,slot,value){itemDefinitions.set(String(item),{kind:String(kind),slot:String(slot||''),value:Math.max(0,number(value))});return true;}
  function equipItem(id,item){
    const def=itemDefinitions.get(String(item));if(!def||def.kind!=='equipment'||inventoryCount(id,item)<=0)return false;
    const slot=def.slot||'main',state=window.PStudioECSGameplay?.getEquipment?.(id,true);
    if(state){setRecordValue(state.slots,slot,String(item));return true;}
    const slots=equipment.get(id)||new Map();slots.set(slot,String(item));equipment.set(id,slots);return true;
  }
  function getEquipment(id){
    const state=window.PStudioECSGameplay?.getEquipment?.(id);
    const entries=state?Object.entries(state.slots||{}):[...(equipment.get(id)||new Map()).entries()];
    return entries.map(([slot,item])=>({slot,item}));
  }
  function useItem(id,item){
    const def=itemDefinitions.get(String(item));if(!def||def.kind!=='consumable'||inventoryCount(id,item)<=0)return false;
    if(!inventoryRemove(id,item,1))return false;if(def.slot==='heal')heal(id,def.value);return true;
  }
  function getInventorySnapshot(id){
    return inventoryEntries(id).map(([item,count])=>({item,count,definition:itemDefinitions.get(item)||null,equipped:getEquipment(id).some(e=>e.item===item)}));
  }
  function questDefine(id,prerequisite,rewardItem,rewardCount){questDefinitions.set(String(id),{prerequisite:String(prerequisite||''),rewardItem:String(rewardItem||''),rewardCount:Math.max(0,Math.floor(number(rewardCount,0)))});return true;}
  function questStart(id){
    const key=String(id),def=questDefinitions.get(key);
    if(def?.prerequisite&&!questIsComplete(def.prerequisite))return false;
    const state=window.PStudioECSGameplay?.getQuestState?.(key,true,{started:true,complete:false,progress:0,target:1,rewarded:false});
    if(state){state.started=true;return true;}
    if(!quests.has(key))quests.set(key,{started:true,complete:false,progress:0,target:1,rewarded:false});else quests.get(key).started=true;
    return true;
  }
  function questComplete(id,ownerId){
    const key=String(id),state=window.PStudioECSGameplay?.getQuestState?.(key,true,{started:true,complete:false,progress:0,target:1,rewarded:false});
    const q=state||quests.get(key)||{started:true,complete:false,progress:0,target:1,rewarded:false};
    q.started=true;q.complete=true;q.progress=q.target;
    if(!q.rewarded&&ownerId){const def=questDefinitions.get(key);if(def?.rewardItem&&def.rewardCount>0)inventoryAdd(ownerId,def.rewardItem,def.rewardCount);q.rewarded=true;}
    if(!state)quests.set(key,q);return true;
  }
  function questIsComplete(id){
    const state=window.PStudioECSGameplay?.getQuestState?.(String(id));
    return state?!!state.complete:!!quests.get(String(id))?.complete;
  }
  function questSetProgress(id,value,target=1){
    const key=String(id),initial={started:true,complete:false,progress:0,target:Math.max(1,number(target,1)),rewarded:false};
    const state=window.PStudioECSGameplay?.getQuestState?.(key,true,initial);
    const q=state||quests.get(key)||initial;
    q.started=true;q.target=Math.max(1,number(target,q.target));q.progress=clamp(number(value),0,q.target);if(q.progress>=q.target)q.complete=true;
    if(!state)quests.set(key,q);return q.progress;
  }
  function questGetProgress(id){
    const state=window.PStudioECSGameplay?.getQuestState?.(String(id));
    const q=state||quests.get(String(id));return q?q.progress:0;
  }
  function defineWeapon(name,range,arcDegrees,damageMultiplier=1){weaponDefinitions.set(String(name),{range:Math.max(0.1,number(range,2)),arc:clamp(number(arcDegrees,100),1,360),multiplier:Math.max(0,number(damageMultiplier,1))});return true;}
  function weaponAttack(sourceId,weapon,radius,amount,comboWindow,objects,physics){
    const source=resolveObject(sourceId,objects);if(!source||!isAlive(sourceId))return 0;
    const weaponDef=weaponDefinitions.get(String(weapon)),attackRange=weaponDef?.range??Math.max(0,number(radius)),minimumFacing=weaponDef?Math.cos(weaponDef.arc*Math.PI/360):0.25,weaponDamage=Math.max(0,number(amount))*(weaponDef?.multiplier??1);
    const now=Date.now(),old=window.PStudioECSGameplay?.getCombo?.(sourceId)||weaponCombos.get(sourceId),windowMs=Math.max(150,number(comboWindow,1100));const combo=old&&now-old.time<=windowMs?old.count%5+1:1;
    const comboState={count:combo,time:now,weapon:String(weapon)};
    if(!window.PStudioECSGameplay?.setCombo?.(sourceId,comboState))weaponCombos.set(sourceId,comboState);
    const a=position(source,physics),forwardX=Math.sin(number(source.rotationY)*Math.PI/180),forwardZ=Math.cos(number(source.rotationY)*Math.PI/180);let hits=0;
    for(const target of objects||[]){if(target.id===sourceId||!physics?.getBody?.(target.id)||!isAlive(target.id))continue;const b=position(target,physics),dx=b.x-a.x,dz=b.z-a.z,dist=Math.hypot(dx,dz);if(dist>attackRange)continue;if(dist>0.001&&(dx/dist)*forwardX+(dz/dist)*forwardZ<minimumFacing)continue;
      const multiplier=[1,1.08,1.22,1.45,1.8][combo-1];damage(target.id,weaponDamage*multiplier);hits++;
    }
    return hits;
  }
  function comboCount(id){return (window.PStudioECSGameplay?.getCombo?.(id)?.count??weaponCombos.get(id)?.count) || 0;}
  function enemyAI(sourceId,targetName,sightRange,attackRange,speed,objects,physics){
    const source=resolveObject(sourceId,objects),target=resolveObject(targetName,objects);
    if(!source||!target||!physics?.getBody?.(sourceId))return 'idle';
    const bridge=window.PStudioECSGameplay;
    const controller=bridge?.setAIController?.(sourceId,{
      targetId:String(target.id),sightRange:Math.max(0,number(sightRange,12)),
      attackRange:Math.max(0,number(attackRange,1.8)),speed:Math.max(0,number(speed,3))
    });
    if(controller){
      const ecs=window.PStudioECS,entity=ecs?.getEntityForSceneObject?.(sourceId);
      const intent=bridge.getMovementIntent?.(sourceId,true),reference=entity!==null&&entity!==undefined?ecs.getComponent(entity,'SceneObjectRef'):null;
      if(entity!==null&&entity!==undefined){
        const sceneReference=reference||{sceneObjectId:String(source.id)};
        updateAIController(entity,controller,intent||{},sceneReference,{
          sceneObjects:objects||[],sourceObject:source,targetObject:target,physics
        });
        controller.skipLegacyEvaluation=true;
      }
      return controller.state||'idle';
    }
    if(!isAlive(sourceId)){aiStates.set(sourceId,'dead');physics.moveCharacter(sourceId,0,0);return 'dead';}
    const a=position(source,physics),b=position(target,physics),dx=b.x-a.x,dz=b.z-a.z,dist=Math.hypot(dx,dz),sight=Math.max(0,number(sightRange,12)),range=Math.max(0,number(attackRange,1.8));
    let state='idle';
    if(!isAlive(target.id)||dist>sight)state='idle';
    else if(getHP(sourceId)<getMaxHP(sourceId)*0.18){state='retreat';const n=Math.max(0.001,dist);physics.moveCharacter(sourceId,-dx/n,-dz/n);}
    else if(dist>range){state='chase';follow(sourceId,targetName,speed,range,objects,physics);}
    else{state='attack';physics.moveCharacter(sourceId,0,0);strike(sourceId,targetName,range,8,650,objects,physics);}
    if(state==='idle')physics.moveCharacter(sourceId,0,0);aiStates.set(sourceId,state);return state;
  }
  function getAIState(id){return (window.PStudioECSGameplay?.getAIState?.(id)??aiStates.get(id)) || 'idle';}
  function updateAIController(entity,controller,intent,reference,context){
    const sourceId=String(reference?.sceneObjectId||''),objects=context?.sceneObjects||sceneObjects||[];
    const source=context?.sourceObject||resolveObject(sourceId,objects);
    const target=context?.targetObject||resolveObject(controller.targetId,objects);
    const physics=context?.physics||window.PStudioPhysics;
    const setIntent=(x,z,active=true)=>{intent.x=x;intent.z=z;intent.maxSpeed=Math.max(0.1,number(controller.speed,3));intent.acceleration=24;intent.airControl=0.25;intent.active=active;intent.mode='ai';intent.targetId=String(controller.targetId||'');};
    if(!source||!target||!physics?.getBody?.(sourceId)){controller.state='idle';setIntent(0,0,false);return;}
    if(!isAlive(sourceId)){controller.state='dead';setIntent(0,0,true);return;}
    const a=position(source,physics),b=position(target,physics),dx=b.x-a.x,dz=b.z-a.z,dist=Math.hypot(dx,dz),sight=Math.max(0,number(controller.sightRange,12)),range=Math.max(0,number(controller.attackRange,1.8));
    if(!isAlive(target.id)||dist>sight){controller.state='idle';setIntent(0,0,true);return;}
    if(getHP(sourceId)<getMaxHP(sourceId)*0.18){
      controller.state='retreat';const n=Math.max(0.001,dist);setIntent(-dx/n,-dz/n,true);return;
    }
    if(dist>range){
      controller.state='chase';let moveX=dx,moveZ=dz;
      const navigation=window.PStudioECSGameplay;
      let start='',goal='';
      if(navigation?.getNearestNavigationNodes){
        const nearest=navigation.getNearestNavigationNodes([a,b]);
        start=nearest[0]?.nodeId||'';goal=nearest[1]?.nodeId||'';
      }else if(fallbackNavNodes.size){
        const nearest=point=>{
          let best='',score=Infinity;
          for(const node of fallbackNavNodes.values()){
            const distance=Math.hypot(node.x-point.x,node.y-point.y,node.z-point.z);
            if(distance<score){score=distance;best=node.id;}
          }
          return best;
        };
        start=nearest(a);goal=nearest(b);
      }
      if(start&&goal){
        const nextNode=navNext(start,goal);
        const node=(navigation?.getNavigationNode?.(nextNode||goal))||fallbackNavNodes.get(nextNode||goal);
        if(node){moveX=node.x-a.x;moveZ=node.z-a.z;}
      }
      const len=Math.hypot(moveX,moveZ);setIntent(len>0.3?moveX/len:0,len>0.3?moveZ/len:0,true);return;
    }
    controller.state='attack';setIntent(0,0,true);strike(sourceId,target.id,range,8,650,objects,physics);
  }
  function openInventory(id){activeUI={type:'inventory',ownerId:String(id)};return true;}
  function openQuestLog(id){activeUI={type:'quests',ownerId:String(id)};return true;}
  function closeUI(){activeUI=null;return true;}
  function showDialogue(speaker,text,choice1,choice2,choice3){
    const choices=[choice1,choice2,choice3].filter(v=>String(v||'').trim()),signature=[speaker,text,...choices].join('|');
    const state=window.PStudioECSGameplay?.getDialogueState?.(true);
    const target=state||dialogueStates;
    if(target.signature!==signature){target.signature=signature;target.choice='';lastDialogueChoice='';}
    target.speaker=String(speaker);target.text=String(text);target.choices=choices;
    if(state)state.active=!target.choice;activeUI=target.choice?null:{type:'dialogue'};return true;
  }
  function chooseDialogue(index){
    const state=window.PStudioECSGameplay?.getDialogueState?.(),target=state||dialogueStates;
    const choice=target.choices?.[Math.max(0,Math.min(target.choices.length-1,Math.floor(number(index))))];
    lastDialogueChoice=choice||'';target.choice=lastDialogueChoice;if(state)state.active=false;activeUI=null;return lastDialogueChoice;
  }
  function getDialogueChoice(){return window.PStudioECSGameplay?.getDialogueState?.()?.choice??lastDialogueChoice;}
  function getUIState(){
    if(!activeUI)return null;
    if(activeUI.type==='dialogue'){
      const state=window.PStudioECSGameplay?.getDialogueState?.()||dialogueStates;
      return {type:'dialogue',speaker:state.speaker,text:state.text,choices:state.choices||[],choice:state.choice||''};
    }
    const id=activeUI.ownerId;
    if(activeUI.type==='inventory')return {type:'inventory',ownerId:id,items:getInventorySnapshot(id),equipment:getEquipment(id),hp:getHP(id),maxHp:getMaxHP(id)};
    const questList=window.PStudioECSGameplay?.listQuests?.()||[...quests.entries()].map(([quest,q])=>({quest,...q}));
    return {type:'quests',ownerId:id,quests:questList};
  }
  function uiAction(action,item,slot){if(!activeUI)return false;const id=activeUI.ownerId;if(action==='use')return useItem(id,item);if(action==='equip')return equipItem(id,item);if(action==='close')return closeUI();if(action==='dialogue')return chooseDialogue(item);return false;}

  function navNodeCount(){
    const navigation=window.PStudioECSGameplay;
    return navigation?.getNavigationNodeCount?.()??fallbackNavNodes.size;
  }
  function navAddNode(id,x,y,z){
    const navigation=window.PStudioECSGameplay;
    if(navigation?.addNavigationNode)return navigation.addNavigationNode(id,number(x),number(y),number(z));
    fallbackNavNodes.set(String(id),{id:String(id),x:number(x),y:number(y),z:number(z),links:new Set()});
    return true;
  }
  function navConnect(a,b){
    const navigation=window.PStudioECSGameplay;
    if(navigation?.connectNavigationNodes)return navigation.connectNavigationNodes(a,b);
    a=fallbackNavNodes.get(String(a));b=fallbackNavNodes.get(String(b));
    if(!a||!b)return false;a.links.add(b.id);b.links.add(a.id);return true;
  }
  function navBuildGrid(x,z,width,depth,cell){
    const step=Math.max(0.5,number(cell,2)),cols=Math.max(1,Math.min(50,Math.floor(number(width)/step))),rows=Math.max(1,Math.min(50,Math.floor(number(depth)/step)));
    if(cols*rows>2500)return 0;
    navClear();
    for(let iz=0;iz<=rows;iz++)for(let ix=0;ix<=cols;ix++){
      const id='grid_'+ix+'_'+iz;
      navAddNode(id,number(x)+(ix/cols)*number(width),0,number(z)+(iz/rows)*number(depth));
    }
    for(let iz=0;iz<=rows;iz++)for(let ix=0;ix<=cols;ix++){
      const id='grid_'+ix+'_'+iz;
      if(ix<cols)navConnect(id,'grid_'+(ix+1)+'_'+iz);
      if(iz<rows)navConnect(id,'grid_'+ix+'_'+(iz+1));
    }
    return navNodeCount();
  }
  function navBlock(id,blocked=true){
    const navigation=window.PStudioECSGameplay;
    if(navigation?.setNavigationNodeBlocked)return navigation.setNavigationNodeBlocked(id,blocked);
    if(!fallbackNavNodes.has(String(id)))return false;
    if(blocked)fallbackBlockedNavNodes.add(String(id));else fallbackBlockedNavNodes.delete(String(id));
    return true;
  }
  function navNext(start,goal){
    const navigation=window.PStudioECSGameplay;
    if(navigation?.findNavigationNext)return navigation.findNavigationNext(start,goal);
    start=String(start);goal=String(goal);
    if(!fallbackNavNodes.has(start)||!fallbackNavNodes.has(goal)||fallbackBlockedNavNodes.has(goal))return '';
    const distance=(a,b)=>{const p=fallbackNavNodes.get(a),q=fallbackNavNodes.get(b);return Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z);};
    const open=[start],came=new Map(),g=new Map([[start,0]]),f=new Map([[start,distance(start,goal)]]),closed=new Set();
    while(open.length){
      open.sort((a,b)=>(f.get(a)||Infinity)-(f.get(b)||Infinity));
      const id=open.shift();if(id===goal)break;closed.add(id);
      for(const next of fallbackNavNodes.get(id).links){
        if(fallbackBlockedNavNodes.has(next)||closed.has(next))continue;
        const score=(g.get(id)||0)+distance(id,next);
        if(score<(g.get(next)??Infinity)){came.set(next,id);g.set(next,score);f.set(next,score+distance(next,goal));if(!open.includes(next))open.push(next);}
      }
    }
    if(start!==goal&&!came.has(goal))return '';
    let step=goal;while(came.get(step)!==start&&came.has(step))step=came.get(step);
    return step===start?'':step;
  }
  function navClear(){
    const navigation=window.PStudioECSGameplay;
    if(navigation?.clearNavigationNodes)navigation.clearNavigationNodes();
    else{fallbackNavNodes.clear();fallbackBlockedNavNodes.clear();}
  }
  function navBuildFromTerrain(x,y,z,width,depth,segments,height,maxSlope=50){const n=Math.max(2,Math.min(48,Math.floor(number(segments,12)))),w=Math.max(1,number(width)),d=Math.max(1,number(depth)),h=Math.max(0,number(height)),baseY=number(y),v=[];const at=(ix,iz)=>{const px=number(x)+(ix/n-.5)*w,pz=number(z)+(iz/n-.5)*d,lx=px-number(x),lz=pz-number(z),py=baseY+h*(Math.sin(lx*.18)*Math.cos(lz*.16)*.5+Math.sin((lx+lz)*.07)*.15);return [px,py,pz];};for(let iz=0;iz<n;iz++)for(let ix=0;ix<n;ix++){const a=at(ix,iz),b=at(ix+1,iz),c=at(ix,iz+1),e=at(ix+1,iz+1);v.push(...a,...c,...b,...b,...c,...e);}return navBuildFromTriangles(v,maxSlope);}
  function navBuildFromTriangles(vertices,maxSlope=50){
    if(!Array.isArray(vertices)||vertices.length<9)return 0;
    const slope=Math.cos(clamp(number(maxSlope,50),0,89)*Math.PI/180),nodes=[],edgeMap=new Map(),count=Math.min(2000,Math.floor(vertices.length/9));
    navClear();
    for(let i=0;i<count;i++){
      const tri=vertices.slice(i*9,i*9+9).map(number),a=tri.slice(0,3),b=tri.slice(3,6),c=tri.slice(6,9);
      const ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
      const nx=ab[1]*ac[2]-ab[2]*ac[1],ny=ab[2]*ac[0]-ab[0]*ac[2],nz=ab[0]*ac[1]-ab[1]*ac[0],len=Math.hypot(nx,ny,nz);
      if(len<1e-8||Math.abs(ny/len)<slope)continue;
      const id='navtri_'+nodes.length;
      const node={id,x:(a[0]+b[0]+c[0])/3,y:(a[1]+b[1]+c[1])/3,z:(a[2]+b[2]+c[2])/3};
      nodes.push(node);
      navAddNode(id,node.x,node.y,node.z);
      const verts=[a,b,c];
      for(let e=0;e<3;e++){
        const v1=verts[e],v2=verts[(e+1)%3];
        const k1=v1.map(v=>Math.round(v*1000)).join(','),k2=v2.map(v=>Math.round(v*1000)).join(',');
        const key=[k1,k2].sort().join('|');
        if(edgeMap.has(key))navConnect(id,edgeMap.get(key));
        else edgeMap.set(key,id);
      }
    }
    return nodes.length;
  }
  function resetTransient(){
    attackTimes.clear();weaponCombos.clear();
    const ecs=window.PStudioECS,bridge=window.PStudioECSGameplay;
    if(ecs&&bridge?.componentTypes?.includes('CombatState')){
      for(const entity of ecs.query(['CombatState'])){const state=ecs.getComponent(entity,'CombatState');state.cooldowns={};state.comboCount=0;state.comboTime=0;state.comboWeapon='';}
    }
  }
  window.PStudioGameplay={setMaxHP,setHP,getHP,getMaxHP,damage,heal,isAlive,attack,strike,follow,inventoryAdd,inventoryRemove,inventoryCount,defineItem,equipItem,useItem,getEquipment,getInventorySnapshot,questDefine,questStart,questComplete,questIsComplete,questSetProgress,questGetProgress,weaponAttack,comboCount,enemyAI,getAIState,openInventory,openQuestLog,closeUI,showDialogue,chooseDialogue,getDialogueChoice,getUIState,uiAction,navAddNode,navConnect,navBuildGrid,navBuildFromTriangles,navBuildFromTerrain,defineWeapon,navBlock,navNext,navClear,resetTransient,initializeECS,persistECS,_ecsUpdateAI:updateAIController,version:'2.2.0'};
})();

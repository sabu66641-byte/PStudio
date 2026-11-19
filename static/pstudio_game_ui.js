/* PStudio Game UI 1.0.0
 * Lightweight DOM overlay for inventory, quest log and dialogue.
 */
(() => {
  'use strict';
  let root=null,lastSignature='';
  const style=(el,values)=>Object.assign(el.style,values);
  function ensureRoot(){
    if(root&&root.isConnected)return root;
    root=document.getElementById('game-ui-overlay');
    if(!root){root=document.createElement('div');root.id='game-ui-overlay';document.querySelector('.game-stage')?.appendChild(root);}
    style(root,{position:'absolute',inset:'0',zIndex:'12',display:'flex',alignItems:'center',justifyContent:'flex-end',padding:'12px',pointerEvents:'none',boxSizing:'border-box'});
    return root;
  }
  function element(tag,text,className){
    const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node;
  }
  function makeButton(text,handler){
    const b=element('button',text);style(b,{border:'1px solid #526071',borderRadius:'7px',padding:'7px 10px',background:'#273243',color:'#edf2f7',font:'12px system-ui',cursor:'pointer'});b.addEventListener('click',handler);return b;
  }
  function render(state){
    const host=ensureRoot();if(!state){host.replaceChildren();lastSignature='';return;}
    const signature=JSON.stringify(state);if(signature===lastSignature)return;lastSignature=signature;
    const panel=element('section');style(panel,{width:'min(340px,100%)',maxHeight:'88%',overflow:'auto',pointerEvents:'auto',padding:'14px',border:'1px solid #536174',borderRadius:'12px',background:'rgba(17,24,39,.96)',boxShadow:'0 14px 42px #0009',color:'#f3f4f6',font:'13px system-ui,sans-serif',boxSizing:'border-box'});
    const header=element('div');style(header,{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'8px',marginBottom:'12px'});
    const title=element('strong',state.type==='inventory'?'Inventory':state.type==='quests'?'Quest Log':state.speaker||'Dialogue');style(title,{fontSize:'15px'});
    header.append(title,makeButton('Close',()=>window.PStudioGameplay?.closeUI?.()));panel.append(header);
    if(state.type==='inventory'){
      const hp=element('div','HP '+Math.round(state.hp)+' / '+Math.round(state.maxHp));style(hp,{color:'#cbd5e1',marginBottom:'10px'});panel.append(hp);
      const eq=element('div','Equipment: '+(state.equipment?.map(x=>x.slot+' — '+x.item).join(', ')||'None'));style(eq,{fontSize:'11px',color:'#9ca3af',marginBottom:'10px'});panel.append(eq);
      if(!state.items?.length)panel.append(element('p','No items yet.'));
      for(const item of state.items||[]){
        const row=element('div');style(row,{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'8px',padding:'8px 0',borderTop:'1px solid #374151'});
        const info=element('div');info.append(element('strong',item.item),element('div','× '+item.count+(item.equipped?' · Equipped':'')));style(info.lastChild,{fontSize:'11px',color:'#9ca3af',marginTop:'3px'});
        const actions=element('div');style(actions,{display:'flex',gap:'5px',flexWrap:'wrap'});
        if(item.definition?.kind==='consumable')actions.append(makeButton('Use',()=>window.PStudioGameplay?.uiAction?.('use',item.item)));
        if(item.definition?.kind==='equipment')actions.append(makeButton('Equip',()=>window.PStudioGameplay?.uiAction?.('equip',item.item)));
        row.append(info,actions);panel.append(row);
      }
    }else if(state.type==='quests'){
      if(!state.quests?.length)panel.append(element('p','No quests started.'));
      for(const quest of state.quests||[]){
        const row=element('div');style(row,{padding:'8px 0',borderTop:'1px solid #374151'});
        row.append(element('strong',quest.quest));
        const progress=element('div',quest.complete?'Completed':quest.started?'Progress: '+quest.progress+' / '+quest.target:'Not started');style(progress,{fontSize:'11px',color:quest.complete?'#86efac':'#cbd5e1',marginTop:'4px'});row.append(progress);panel.append(row);
      }
    }else if(state.type==='dialogue'){
      const body=element('p',state.text);style(body,{whiteSpace:'pre-wrap',lineHeight:'1.6',color:'#e5e7eb'});panel.append(body);
      (state.choices||[]).forEach((choice,index)=>{const row=makeButton(choice,()=>window.PStudioGameplay?.chooseDialogue?.(index));style(row,{display:'block',width:'100%',textAlign:'left',marginTop:'7px'});panel.append(row);});
    }
    host.replaceChildren(panel);
  }
  window.PStudioUI={render,close:()=>window.PStudioGameplay?.closeUI?.(),version:'1.0.0'};
})();

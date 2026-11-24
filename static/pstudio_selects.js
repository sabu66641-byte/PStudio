(() => {
  'use strict';
  if (window.PStudioSelects?.initialized) return;

  const SELECTOR='select:not(.visually-hidden):not(.pstudio-native-select):not([data-native-picker="false"])';
  let active=null;
  let observer=null;
  let sequence=0;

  function optionLabel(option){
    return String(option?.label||option?.textContent||'').replace(/\s+/g,' ').trim();
  }

  function accessibleLabel(select){
    const explicit=select.getAttribute('aria-label')||select.getAttribute('title');
    if(explicit)return explicit;
    const labels=Array.from(select.labels||[]);
    for(const label of labels){
      const text=Array.from(label.childNodes)
        .filter(node=>node.nodeType===Node.TEXT_NODE)
        .map(node=>node.nodeValue||'').join(' ')
        .replace(/\s+/g,' ').trim();
      if(text)return text;
      const value=label.textContent?.replace(/\s+/g,' ').trim();
      if(value)return value;
    }
    return select.id?select.id.replace(/[-_]/g,' '):'Select an option';
  }

  function close(state=active,restoreFocus=false){
    if(!state)return;
    state.menu.hidden=true;
    state.trigger.setAttribute('aria-expanded','false');
    state.wrapper.classList.remove('is-open');
    if(active===state)active=null;
    if(restoreFocus&&!state.select.disabled)state.trigger.focus({preventScroll:true});
  }

  function closeOthers(next){
    if(active&&active!==next)close(active,false);
  }

  function positionMenu(state){
    const rect=state.trigger.getBoundingClientRect();
    const margin=10;
    const maxWidth=Math.max(150,window.innerWidth-margin*2);
    const width=Math.min(maxWidth,Math.max(rect.width,172));
    state.menu.style.width=width+'px';
    state.menu.style.maxWidth=maxWidth+'px';
    const left=Math.max(margin,Math.min(window.innerWidth-width-margin,rect.left));
    const maxHeight=Math.min(Math.max(120,Math.floor(window.innerHeight*.52)),340);
    state.menu.style.maxHeight=maxHeight+'px';
    const menuHeight=Math.min(state.menu.scrollHeight||state.menu.offsetHeight||maxHeight,maxHeight);
    const below=window.innerHeight-rect.bottom-margin;
    const above=rect.top-margin;
    if(below<Math.min(190,menuHeight)&&above>below){
      state.menu.style.top='auto';
      state.menu.style.bottom=Math.max(margin,window.innerHeight-rect.top+6)+'px';
    }else{
      state.menu.style.bottom='auto';
      state.menu.style.top=Math.min(window.innerHeight-margin-menuHeight,rect.bottom+6)+'px';
    }
    state.menu.style.left=left+'px';
  }

  function buildOptions(state){
    const {select,menu}=state;
    const options=Array.from(select.options||[]);
    menu.replaceChildren();
    if(!options.length){
      const empty=document.createElement('div');
      empty.className='pstudio-select-option';
      empty.textContent='—';
      empty.setAttribute('aria-disabled','true');
      menu.appendChild(empty);
      return;
    }
    options.forEach((option,index)=>{
      if(option.hidden)return;
      const item=document.createElement('button');
      item.type='button';
      item.className='pstudio-select-option';
      item.role='option';
      item.dataset.index=String(index);
      item.textContent=optionLabel(option)||'—';
      item.disabled=!!option.disabled||!!select.disabled;
      item.setAttribute('aria-selected',String(select.selectedIndex===index));
      item.tabIndex=-1;
      item.addEventListener('click',()=>{
        if(item.disabled)return;
        const previous=select.value;
        select.selectedIndex=index;
        if(select.value!==previous){
          select.dispatchEvent(new Event('input',{bubbles:true}));
          select.dispatchEvent(new Event('change',{bubbles:true}));
        }
        sync(state);
        close(state,true);
      });
      menu.appendChild(item);
    });
  }

  function sync(state){
    if(!state||!state.select.isConnected)return;
    const {select,trigger}=state;
    const option=select.selectedOptions?.[0]||select.options?.[0];
    trigger.textContent=optionLabel(option)||select.getAttribute('placeholder')||'—';
    const chevron=document.createElement('span');
    chevron.className='pstudio-select-chevron';
    chevron.setAttribute('aria-hidden','true');
    chevron.textContent='⌄';
    trigger.appendChild(chevron);
    trigger.disabled=!!select.disabled;
    trigger.setAttribute('aria-label',accessibleLabel(select)+': '+(optionLabel(option)||'—'));
    if(state.menu.isConnected)buildOptions(state);
    if(active===state&& !state.menu.hidden)positionMenu(state);
  }

  function open(state,focusSelected=false){
    if(state.select.disabled)return;
    closeOthers(state);
    buildOptions(state);
    state.menu.hidden=false;
    state.trigger.setAttribute('aria-expanded','true');
    state.wrapper.classList.add('is-open');
    active=state;
    positionMenu(state);
    if(focusSelected){
      const selected=state.menu.querySelector('[aria-selected="true"]:not(:disabled)');
      (selected||state.menu.querySelector('.pstudio-select-option:not(:disabled)'))?.focus({preventScroll:true});
    }
  }

  function enhance(select){
    if(!(select instanceof HTMLSelectElement)||select.dataset.pstudioSelectReady==='true')return;
    if(select.multiple||select.size>1||select.classList.contains('visually-hidden')||select.id==='global-language')return;

    const instanceId=++sequence;
    const wrapper=document.createElement('span');
    wrapper.className='pstudio-select';
    const parent=select.parentElement;
    if(parent?.classList.contains('object-field'))wrapper.classList.add('pstudio-select--full');
    if(parent?.classList.contains('setting-row'))wrapper.classList.add('pstudio-select--setting');
    if(select.classList.contains('render-quality-select'))wrapper.classList.add('pstudio-select--quality');

    const trigger=document.createElement('button');
    trigger.type='button';
    trigger.className=(''+select.className+' pstudio-select-trigger').trim();
    trigger.id=(select.id||'pstudio-select-'+instanceId)+'-custom-trigger';
    trigger.setAttribute('aria-haspopup','listbox');
    trigger.setAttribute('aria-expanded','false');
    trigger.setAttribute('aria-controls','pstudio-select-menu-'+instanceId);
    const menu=document.createElement('div');
    menu.id='pstudio-select-menu-'+instanceId;
    menu.className='pstudio-select-menu';
    menu.role='listbox';
    menu.hidden=true;
    menu.setAttribute('aria-label',accessibleLabel(select));
    menu.dataset.placement='auto';

    select.parentNode.insertBefore(wrapper,select);
    wrapper.append(trigger,select);
    document.body.appendChild(menu);
    select.classList.add('pstudio-native-select');
    select.dataset.pstudioSelectReady='true';
    select.tabIndex=-1;
    select.setAttribute('aria-hidden','true');

    const state={select,wrapper,trigger,menu,observer:null};
    trigger.addEventListener('click',()=>{
      if(active===state&&!menu.hidden)close(state,false);
      else open(state,false);
    });
    trigger.addEventListener('keydown',event=>{
      if(event.key==='ArrowDown'||event.key==='ArrowUp'||event.key==='Enter'||event.key===' '){
        event.preventDefault();
        open(state,true);
      }else if(event.key==='Escape')close(state,false);
    });
    menu.addEventListener('keydown',event=>{
      const items=Array.from(menu.querySelectorAll('.pstudio-select-option:not(:disabled)'));
      const current=items.indexOf(document.activeElement);
      let next=-1;
      if(event.key==='ArrowDown')next=(current+1+items.length)%items.length;
      else if(event.key==='ArrowUp')next=(current-1+items.length)%items.length;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=items.length-1;
      else if(event.key==='Escape'){event.preventDefault();close(state,true);return;}
      else if(event.key==='Tab'){close(state,false);return;}
      if(next>=0&&items.length){event.preventDefault();items[next].focus({preventScroll:true});}
    });
    select.addEventListener('input',()=>sync(state));
    select.addEventListener('change',()=>sync(state));
    state.observer=new MutationObserver(()=>sync(state));
    state.observer.observe(select,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','label','selected','hidden']});
    sync(state);
    select.__pstudioSelectState=state;
  }

  function scan(root){
    if(!root)return;
    if(root.nodeType===Node.ELEMENT_NODE&&root.matches?.(SELECTOR))enhance(root);
    root.querySelectorAll?.(SELECTOR).forEach(enhance);
  }

  function handleOutsidePointer(event){
    if(!active)return;
    if(active.wrapper.contains(event.target)||active.menu.contains(event.target))return;
    close(active,false);
  }

  document.addEventListener('pointerdown',handleOutsidePointer,true);
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&active)close(active,false);
  });
  window.addEventListener('resize',()=>{if(active)positionMenu(active);},{passive:true});
  window.addEventListener('scroll',()=>{if(active)positionMenu(active);},true);

  function start(){
    scan(document);
    observer=new MutationObserver(records=>{
      for(const record of records){
        for(const node of record.addedNodes){
          if(node.nodeType===Node.ELEMENT_NODE)scan(node);
        }
      }
    });
    observer.observe(document.body,{subtree:true,childList:true});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();

  window.PStudioSelects={initialized:true,refresh:()=>scan(document),closeAll:()=>close(active,false)};
})();
/* PStudio Game Runtime 3.0.0
 * Browser-side, frame-driven interpreter for validated ps ASTs.
 * Normal ps -> C++17 execution remains on /run and is not changed.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('game-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const imageCache = window.imageCache || new Map();
  const keys = new Set();
  const justPressed = new Set();
  const virtualKeys = new Set();
  const virtualAxis = { x: 0, z: 0 };
  let joystickPointer = null;
  let jumpPointer = null;
  let runtime = null;
  const requestFrame = window.PStudioPlatform?.requestFrame?.bind(window.PStudioPlatform) || window.requestAnimationFrame.bind(window);
  const cancelFrame = window.PStudioPlatform?.cancelFrame?.bind(window.PStudioPlatform) || window.cancelAnimationFrame.bind(window);
  let raf = 0;
  let lastTime = 0;
  let touchActive = false;
  let activePointerId = null;
  let pointerPosition = { x: 0, y: 0 };
  let collisionPairs = new Set();
  let collision3DPairs = new Set();
  let particleSequence = 0;
  const ownerAudio=new Map();
  const chunkAudioSuspended=new Set();
  function audioMap(ownerId){const key=String(ownerId);if(!ownerAudio.has(key))ownerAudio.set(key,new Map());return ownerAudio.get(key);}
  function playOwnerSound(ownerId,name,volume,loop){
    const assetList=typeof projectAssets!=='undefined'&&Array.isArray(projectAssets)?projectAssets:[];
    const asset=assetList.find(item=>item?.kind==='audio'&&String(item.name)===String(name));
    if(!asset||typeof (asset.data||asset.url)!=='string')throw new PsRuntimeError('音声アセットが見つかりません: '+String(name));
    const sounds=audioMap(ownerId);let audio=sounds.get(String(name));
    if(audio){audio.pause();try{audio.currentTime=0;}catch(_){} }
    else{audio=new Audio(asset.data||asset.url);audio.preload='auto';sounds.set(String(name),audio);audio.addEventListener('ended',()=>{if(!audio.loop&&sounds.get(String(name))===audio)sounds.delete(String(name));});}
    audio.volume=Math.max(0,Math.min(1,finite(volume,1)));audio.loop=truthy(loop);audio._pstudioResumeAfterChunk=false;
    const promise=audio.play();if(promise?.catch)promise.catch(error=>console.warn('[PStudio] Audio playback was blocked:',error));return true;
  }
  function stopOwnerSound(ownerId,name){const sounds=ownerAudio.get(String(ownerId));if(!sounds)return false;const targets=name===null?[...sounds.values()]:[sounds.get(String(name))].filter(Boolean);for(const audio of targets){audio.pause();try{audio.currentTime=0;}catch(_){}for(const [key,value] of sounds)if(value===audio)sounds.delete(key);}if(!sounds.size)ownerAudio.delete(String(ownerId));return targets.length>0;}
  function setOwnerSoundVolume(ownerId,name,volume){const audio=ownerAudio.get(String(ownerId))?.get(String(name));if(!audio)return false;audio.volume=Math.max(0,Math.min(1,finite(volume,1)));return true;}
  function pauseOwnerAudio(ownerId){for(const audio of ownerAudio.get(String(ownerId))?.values()||[]){audio._pstudioResumeAfterChunk=!audio.paused;if(!audio.paused)audio.pause();}}
  function resumeOwnerAudio(ownerId){for(const audio of ownerAudio.get(String(ownerId))?.values()||[]){if(audio._pstudioResumeAfterChunk){audio._pstudioResumeAfterChunk=false;const promise=audio.play();if(promise?.catch)promise.catch(error=>console.warn('[PStudio] Audio resume was blocked:',error));}}}
  function stopAllOwnerAudio(){for(const ownerId of [...ownerAudio.keys()])stopOwnerSound(ownerId,null);chunkAudioSuspended.clear();}

  class PsRuntimeError extends Error {}
  const truthy = (v) => Array.isArray(v) ? v.length > 0 : !!v;
  const BREAK = Symbol('break');
  const CONTINUE = Symbol('continue');
  const RETURN = Symbol('return');

  function pointFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX-r.left)*canvas.width/r.width, y: (e.clientY-r.top)*canvas.height/r.height };
  }
  window.addEventListener('keydown', e => { const key=e.key.toLowerCase(); if(!keys.has(key))justPressed.add(key); keys.add(key); const target=e.target; const editing=target && (target.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(target.tagName)); if(runtime?.running && !editing && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault(); });
  window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
  function resetVirtualControls() {
    virtualKeys.clear();
    jumpPointer = null;
    $('touch-jump')?.classList.remove('is-pressed');
    virtualAxis.x=0;
    virtualAxis.z=0;
    const knob=$('touch-joystick-knob');
    if(knob)knob.style.transform='translate(0px, 0px)';
  }
  function setTouchControlsEnabled(enabled) {
    const root=$('touch-controls');
    if(!root)return;
    const touchDevice=!!(window.matchMedia?.('(pointer: coarse)')?.matches || navigator.maxTouchPoints>0);
    const active=!!enabled&&touchDevice;
    root.classList.toggle('active',active);
    root.setAttribute('aria-hidden',active?'false':'true');
    if(!active)resetVirtualControls();
  }
  function updateJoystick(e) {
    const base=$('touch-joystick'),knob=$('touch-joystick-knob');
    if(!base||!knob)return;
    const rect=base.getBoundingClientRect();
    const radius=Math.max(1,rect.width*0.5-24);
    let dx=(e.clientX-(rect.left+rect.width/2))/radius;
    let dy=(e.clientY-(rect.top+rect.height/2))/radius;
    const length=Math.hypot(dx,dy);
    if(length>1){dx/=length;dy/=length;}
    virtualAxis.x=dx;
    virtualAxis.z=dy;
    knob.style.transform='translate('+Math.round(dx*radius)+'px, '+Math.round(dy*radius)+'px)';
  }
  (() => {
    const joystick=$('touch-joystick'),jumpButton=$('touch-jump');
    if(joystick){
      joystick.addEventListener('pointerdown',e=>{
        joystickPointer=e.pointerId;
        try{joystick.setPointerCapture(e.pointerId)}catch(_){}
        updateJoystick(e);
        e.preventDefault();
      });
      joystick.addEventListener('pointermove',e=>{if(joystickPointer===e.pointerId){updateJoystick(e);e.preventDefault();}});
      const release=e=>{if(joystickPointer===e.pointerId){joystickPointer=null;virtualAxis.x=0;virtualAxis.z=0;const knob=$('touch-joystick-knob');if(knob)knob.style.transform='translate(0px, 0px)';}};
      joystick.addEventListener('pointerup',release);
      joystick.addEventListener('pointercancel',release);
    }
    if(jumpButton){
      jumpButton.addEventListener('pointerdown',e=>{
        if(jumpPointer!==null)return;
        jumpPointer=e.pointerId;
        virtualKeys.add(' ');
        justPressed.add(' ');
        jumpButton.classList.add('is-pressed');
        try{jumpButton.setPointerCapture(e.pointerId)}catch(_){}
        e.preventDefault();
      });
      const releaseJump=e=>{
        if(jumpPointer===null||(e?.pointerId!==undefined&&e.pointerId!==jumpPointer))return;
        jumpPointer=null;
        virtualKeys.delete(' ');
        jumpButton.classList.remove('is-pressed');
      };
      jumpButton.addEventListener('pointerup',releaseJump);
      jumpButton.addEventListener('pointercancel',releaseJump);
      jumpButton.addEventListener('lostpointercapture',releaseJump);
    }
  })();
  window.addEventListener('blur', () => { keys.clear(); justPressed.clear(); resetVirtualControls(); touchActive=false; activePointerId=null; window.PStudioECSInput?.reset?.(); });
  window.addEventListener('pstudio-model-error', e => {
    const detail=e.detail||{};
    setOutput?.('3D model load failed: '+(detail.name||'unknown')+' — '+(detail.error||'unknown error'),'error');
  });
  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    activePointerId = e.pointerId;
    touchActive = true;
    pointerPosition = pointFromEvent(e);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });
  window.addEventListener('pointerup', e => {
    if (activePointerId === e.pointerId) { touchActive = false; activePointerId = null; }
  });
  window.addEventListener('pointercancel', e => {
    if (activePointerId === e.pointerId) { touchActive = false; activePointerId = null; }
  });
  canvas.addEventListener('pointermove', e => {
    if (activePointerId === null || activePointerId === e.pointerId) pointerPosition = pointFromEvent(e);
  });

  function astForScript(scriptName) {
    return runtime?.asts?.[scriptName] || null;
  }
  function makeContext(object, dt) {
    return {
      object, dt, draw: [], steps: 0, callDepth: 0,
      env: runtime.states.get(object.id) || Object.create(null),
      funcs: Object.create(null),
      output: []
    };
  }
  function setupContext(object, dt=0) {
    const c = makeContext(object, dt);
    const ast = astForScript(object.script);
    if (!ast) return c;
    for (const node of ast.body || []) if (node.type === 'FunctionDef') c.funcs[node.name] = node;
    return c;
  }
  function getVar(c, env, name) {
    if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
    if (name === 'true') return true;
    if (name === 'false') return false;
    throw new PsRuntimeError(`未定義の変数: ${name}`);
  }
  function setTarget(c, env, target, value) {
    if (target.type === 'Variable') env[target.value] = value;
    else if (target.type === 'IndexExpr') {
      const a = getVar(c, env, target.name); a[evalExpr(c, env, target.index)] = value;
    } else if (target.type === 'MemberExpr') {
      const owner=evalExpr(c,env,target.object),property=String(target.property||'');
      if(!owner||typeof owner!=='object'||Array.isArray(owner)||['__proto__','prototype','constructor'].includes(property)||!Object.prototype.hasOwnProperty.call(owner,property)) {
        throw new PsRuntimeError('Component Fieldへの代入先が不正です: '+property);
      }
      owner[property]=value;
    } else throw new PsRuntimeError('代入先が不正です。');
  }
  function callFunction(c, name, args) {
    const fn = c.funcs[name];
    if (!fn) return callBuiltin(c, name, args);
    if (args.length !== fn.params.length) throw new PsRuntimeError(`${name}() の引数は ${fn.params.length} 個必要です。`);
    if (++c.callDepth > 32) { c.callDepth--; throw new PsRuntimeError('関数呼び出しの深さが上限を超えました。'); }
    const old = Object.create(null);
    fn.params.forEach((p,i) => { old[p] = Object.prototype.hasOwnProperty.call(c.env,p) ? c.env[p] : undefined; c.env[p] = args[i]; });
    try { execBlock(c, fn.body || [], c.env); }
    catch (signal) { if (signal && signal.kind === RETURN) return signal.value; throw signal; }
    finally { fn.params.forEach(p => { if (old[p] === undefined) delete c.env[p]; else c.env[p] = old[p]; }); c.callDepth--; }
    return null;
  }
  function callBuiltin(c, name, a) {
    const o = c.object;
    const physics = window.PStudioPhysics;
    const physicsPosition = () => physics?.getPosition?.(o.id);
    const readPosition = axis => physicsPosition()?.[['x','y','z'][axis]] ?? (Number(o[['x','y','z'][axis]])||0);
    const writePosition = (axis,value) => {
      const v=finite(value), field=['x','y','z'][axis];
      if(physics?.getBody?.(o.id)) physics.setPosition(o.id,axis,v);
      o[field]=v;
      return v;
    };
    switch (name) {
      case 'len': if (a.length!==1) break; return a[0]?.length ?? 0;
      case 'range': if (a.length===1) return Array.from({length:Math.max(0,Math.min(100000,Number(a[0])|0))},(_,i)=>i); if (a.length===2||a.length===3) { const step=a.length===3?Number(a[2]):1; if (!step) return []; const out=[]; for(let i=Number(a[0]); step>0?i<Number(a[1]):i>Number(a[1]); i+=step){out.push(i);if(out.length>100000)throw new PsRuntimeError('range() の要素数が上限を超えました。')} return out; } break;
      case 'get_x': if (!a.length) return readPosition(0); break;
      case 'get_y': if (!a.length) return readPosition(1); break;
      case 'get_z': if (!a.length) return readPosition(2); break;
      case 'set_x': if (a.length===1) return writePosition(0,a[0]); break;
      case 'set_y': if (a.length===1) return writePosition(1,a[0]); break;
      case 'set_z': if (a.length===1) return writePosition(2,a[0]); break;
      case 'rotate_x': if (a.length===1) { o.rotationX=(Number(o.rotationX)||0)+finite(a[0]); return o.rotationX; } break;
      case 'rotate_y': if (a.length===1) { o.rotationY=(Number(o.rotationY)||0)+finite(a[0]); return o.rotationY; } break;
      case 'rotate_z': if (a.length===1) { o.rotationZ=(Number(o.rotationZ)||0)+finite(a[0]); return o.rotationZ; } break;
      case 'is_key_down': if (a.length===1) {const k=normalizeKey(a[0]),input=window.PStudioECSInput;return input?input.isKeyDown(k):keys.has(k)||virtualKeys.has(k);} break;
      case 'was_key_pressed': if (a.length===1) {const k=normalizeKey(a[0]),input=window.PStudioECSInput;return input?input.wasKeyPressed(k):justPressed.has(k);} break;
      case 'get_axis': if (a.length===1) {
        const axis=String(a[0]).toLowerCase(),input=window.PStudioECSInput;
        if(input){const value=input.getAxis(axis);if(value!==null)return value;}
        if(axis==='horizontal'||axis==='x')return clampAxis((keys.has('d')||keys.has('arrowright')?1:0)-(keys.has('a')||keys.has('arrowleft')?1:0)+virtualAxis.x);
        if(axis==='vertical'||axis==='z')return clampAxis((keys.has('s')||keys.has('arrowdown')?1:0)-(keys.has('w')||keys.has('arrowup')?1:0)+virtualAxis.z);
        break;
      }
      case 'is_touched': if (!a.length) return window.PStudioECSInput?.isTouched?.()??touchActive; break;
      case 'get_touch_x': if (!a.length) return window.PStudioECSInput?.getTouchX?.()??pointerPosition.x; break;
      case 'get_touch_y': if (!a.length) return window.PStudioECSInput?.getTouchY?.()??pointerPosition.y; break;
      case 'play_sound': if(a.length===3)return window.PStudioECSAudio?window.PStudioECSAudio.play(o.id,String(a[0]),a[1],a[2]):playOwnerSound(o.id,String(a[0]),a[1],a[2]); break;
      case 'stop_sound': if(a.length===1)return window.PStudioECSAudio?window.PStudioECSAudio.stop(o.id,String(a[0])):stopOwnerSound(o.id,String(a[0])); break;
      case 'set_sound_volume': if(a.length===2)return window.PStudioECSAudio?window.PStudioECSAudio.setVolume(o.id,String(a[0]),a[1]):setOwnerSoundVolume(o.id,String(a[0]),a[1]); break;
      case 'get_delta_time': if (!a.length) return c.dt; break;
      case 'get_width': if (!a.length) return Number(o.w)||0; break;
      case 'get_height': if (!a.length) return Number(o.h)||0; break;
      case 'draw_rect': if (a.length===4) { c.draw.push({type:'rect',x:finite(a[0]),y:finite(a[1]),w:finite(a[2]),h:finite(a[3]),color:o.color||'#d1d5db'}); return null; } break;
      case 'draw_hud_text': if(a.length===5){c.draw.push({type:'hud_text',text:String(a[0]),x:finite(a[1]),y:finite(a[2]),size:Math.max(8,Math.min(96,finite(a[3]))),color:String(a[4])});return null;} break;
      case 'draw_hud_bar': if(a.length===7){c.draw.push({type:'hud_bar',value:finite(a[0]),max:Math.max(0.001,finite(a[1])),x:finite(a[2]),y:finite(a[3]),w:Math.max(1,finite(a[4])),h:Math.max(1,finite(a[5])),color:String(a[6])});return null;} break;
      case 'draw_circle': if (a.length===3) { c.draw.push({type:'circle',x:finite(a[0]),y:finite(a[1]),r:Math.max(0,finite(a[2])),color:o.color||'#d1d5db'}); return null; } break;
      case 'draw_sprite': if (a.length===3) { c.draw.push({type:'sprite',name:String(a[0]),x:finite(a[1]),y:finite(a[2])}); return null; } break;
      case 'draw_cube': if (a.length===4) { c.draw.push({type:'cube',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),size:Math.max(0.001,finite(a[3])),color:o.color||'#d1d5db',rotationX:(Number(o.rotationX)||0)*Math.PI/180,rotationY:(Number(o.rotationY)||0)*Math.PI/180,rotationZ:(Number(o.rotationZ)||0)*Math.PI/180}); return null; } break;
      case 'draw_sphere': if (a.length===4) { c.draw.push({type:'sphere',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),radius:Math.max(0.001,finite(a[3])),color:o.color||'#a1a1aa'}); return null; } break;
      case 'draw_box': if (a.length===6) { c.draw.push({type:'box',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),width:Math.max(0.001,finite(a[3])),height:Math.max(0.001,finite(a[4])),depth:Math.max(0.001,finite(a[5])),color:o.color||'#d1d5db',rotationX:(Number(o.rotationX)||0)*Math.PI/180,rotationY:(Number(o.rotationY)||0)*Math.PI/180,rotationZ:(Number(o.rotationZ)||0)*Math.PI/180}); return null; } break;
      case 'draw_plane': if (a.length===5) { c.draw.push({type:'plane',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),width:Math.max(0.001,finite(a[3])),depth:Math.max(0.001,finite(a[4])),color:o.color||'#64748b'}); return null; } break;
      case 'add_triangle_collider': if(a.length===9){c.draw.push({type:'triangle_collider',points:a.map(finite)});return null;} break;
      case 'draw_cylinder': if (a.length===5) { c.draw.push({type:'cylinder',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),radius:Math.max(0.001,finite(a[3])),height:Math.max(0.001,finite(a[4])),color:o.color||'#d1d5db'}); return null; } break;
      case 'draw_cone': if (a.length===5) { c.draw.push({type:'cone',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),radius:Math.max(0.001,finite(a[3])),height:Math.max(0.001,finite(a[4])),color:o.color||'#d1d5db'}); return null; } break;
      case 'draw_capsule': if (a.length===5) { c.draw.push({type:'capsule',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),radius:Math.max(0.001,finite(a[3])),height:Math.max(finite(a[4]),Math.max(0.001,finite(a[3]))*2),color:o.color||'#93c5fd'}); return null; } break;
      case 'set_background': if (a.length===1) { c.draw.push({type:'environment',background:String(a[0])}); return null; } break;
      case 'set_fog': if (a.length===3) { c.draw.push({type:'environment',fogColor:String(a[0]),fogNear:Math.max(0,finite(a[1])),fogFar:Math.max(0.001,finite(a[2]))}); return null; } break;
      case 'set_light': if (a.length===4) { c.draw.push({type:'environment',lightX:finite(a[0]),lightY:finite(a[1]),lightZ:finite(a[2]),lightIntensity:Math.max(0,finite(a[3]))}); return null; } break;
      case 'set_point_light': if(a.length===6){c.draw.push({type:'light',kind:'point',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),intensity:Math.max(0,finite(a[3])),color:String(a[4]),distance:Math.max(0,finite(a[5]))});return null;} break;
      case 'set_spot_light': if(a.length===9){c.draw.push({type:'light',kind:'spot',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),targetX:finite(a[3]),targetY:finite(a[4]),targetZ:finite(a[5]),intensity:Math.max(0,finite(a[6])),color:String(a[7]),angle:Math.max(0.01,Math.min(1.55,finite(a[8])))});return null;} break;
      case 'set_environment': if(a.length===3){c.draw.push({type:'environment',environmentSky:String(a[0]),environmentGround:String(a[1]),environmentIntensity:Math.max(0,finite(a[2]))});return null;} break;
      case 'draw_terrain': if(a.length===7){c.draw.push({type:'terrain',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),width:Math.max(1,finite(a[3])),depth:Math.max(1,finite(a[4])),segments:Math.max(2,Math.min(96,Math.floor(finite(a[5])))),height:Math.max(0,finite(a[6])),color:o.color||'#66835a'});return null;} break;
      case 'draw_water': if(a.length===7){c.draw.push({type:'water',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),width:Math.max(1,finite(a[3])),depth:Math.max(1,finite(a[4])),color:String(a[5]),opacity:Math.max(0.05,Math.min(1,finite(a[6])))});return null;} break;
      case 'emit_particles': if(a.length===7){c.draw.push({type:'particles',burstId:++particleSequence,x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),count:Math.max(1,Math.min(400,Math.floor(finite(a[3])))),color:String(a[4]),speed:Math.max(0,finite(a[5])),lifetime:Math.max(0.05,Math.min(10,finite(a[6]))),dt:c.dt});return null;} break;
      case 'set_point_light': if(a.length===6){c.draw.push({type:'light',kind:'point',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),intensity:Math.max(0,finite(a[3])),color:String(a[4]),distance:Math.max(0,finite(a[5]))});return null;} break;
      case 'set_spot_light': if(a.length===9){c.draw.push({type:'light',kind:'spot',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),targetX:finite(a[3]),targetY:finite(a[4]),targetZ:finite(a[5]),intensity:Math.max(0,finite(a[6])),color:String(a[7]),angle:Math.max(0.01,Math.min(1.55,finite(a[8])))});return null;} break;
      case 'set_environment': if(a.length===3){c.draw.push({type:'environment',environmentSky:String(a[0]),environmentGround:String(a[1]),environmentIntensity:Math.max(0,finite(a[2]))});return null;} break;
      case 'draw_terrain': if(a.length===7){c.draw.push({type:'terrain',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),width:Math.max(1,finite(a[3])),depth:Math.max(1,finite(a[4])),segments:Math.max(2,Math.min(96,Math.floor(finite(a[5])))),height:Math.max(0,finite(a[6])),color:o.color||'#66835a'});return null;} break;
      case 'draw_water': if(a.length===7){c.draw.push({type:'water',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),width:Math.max(1,finite(a[3])),depth:Math.max(1,finite(a[4])),color:String(a[5]),opacity:Math.max(0.05,Math.min(1,finite(a[6])))});return null;} break;
      case 'physics_body': if (a.length===6) { if(!physics)throw new PsRuntimeError('Physics module is unavailable.'); physics.createBody(o.id,finite(a[0]),finite(a[1]),finite(a[2]),Math.max(0.05,finite(a[3])),Math.max(0.1,finite(a[4])),Math.max(0.001,finite(a[5]))); return null; } break;
      case 'set_gravity': if (a.length===3) { physics?.setGravity(o.id,finite(a[0]),finite(a[1]),finite(a[2])); return null; } break;
      case 'apply_force': if (a.length===3) { physics?.applyForce(o.id,finite(a[0]),finite(a[1]),finite(a[2])); return null; } break;
      case 'apply_impulse': if (a.length===3) { physics?.applyImpulse(o.id,finite(a[0]),finite(a[1]),finite(a[2])); return null; } break;
      case 'get_velocity_x': if (!a.length) return physics?.getVelocity(o.id,0) ?? 0; break;
      case 'get_velocity_y': if (!a.length) return physics?.getVelocity(o.id,1) ?? 0; break;
      case 'get_velocity_z': if (!a.length) return physics?.getVelocity(o.id,2) ?? 0; break;
      case 'set_velocity_x': if (a.length===1) return physics?.setVelocity(o.id,0,finite(a[0])); break;
      case 'set_velocity_y': if (a.length===1) return physics?.setVelocity(o.id,1,finite(a[0])); break;
      case 'set_velocity_z': if (a.length===1) return physics?.setVelocity(o.id,2,finite(a[0])); break;
      case 'character_controller': if (a.length===3) { physics?.configureController(o.id,finite(a[0]),finite(a[1]),finite(a[2])); return null; } break;
      case 'set_step_height': if(a.length===1){physics?.setStepHeight(o.id,finite(a[0]));return null;} break;
      case 'set_max_slope': if(a.length===1){physics?.setMaxSlope(o.id,finite(a[0]));return null;} break;
      case 'move_character': if (a.length===2) {
        let moveX=finite(a[0]),moveZ=finite(a[1]);
        const basis=window.PStudio3D?.getCameraBasis?.();
        if(basis){
          const worldX=basis.rightX*moveX-basis.forwardX*moveZ;
          const worldZ=basis.rightZ*moveX-basis.forwardZ*moveZ;
          moveX=worldX;moveZ=worldZ;
        }
        physics?.moveCharacter(o.id,moveX,moveZ);
        return null;
      } break;
      case 'jump': if (a.length===1) return physics?.jump(o.id,finite(a[0])) ?? false; break;
      case 'is_grounded': if (!a.length) return physics?.isGrounded(o.id) ?? false; break;
      case 'set_max_hp': if(a.length===1)return window.PStudioGameplay?.setMaxHP(o.id,a[0]); break;
      case 'set_hp': if(a.length===1)return window.PStudioGameplay?.setHP(o.id,a[0]); break;
      case 'get_hp': if(!a.length)return window.PStudioGameplay?.getHP(o.id)??100; break;
      case 'get_max_hp': if(!a.length)return window.PStudioGameplay?.getMaxHP(o.id)??100; break;
      case 'damage': if(a.length===1)return window.PStudioGameplay?.damage(o.id,a[0]); break;
      case 'heal': if(a.length===1)return window.PStudioGameplay?.heal(o.id,a[0]); break;
      case 'is_alive': if(!a.length)return window.PStudioGameplay?.isAlive(o.id)??true; break;
      case 'apply_damage': if(a.length===2){const target=(sceneObjects||[]).find(x=>x.id===String(a[0])||x.name===String(a[0]));return target?window.PStudioGameplay?.damage(target.id,a[1]):false;} break;
      case 'attack_hitbox': if(a.length===2)return window.PStudioGameplay?.attack(o.id,a[0],a[1],sceneObjects,physics)??0; break;
      case 'use_skill': if(a.length===3)return window.PStudioGameplay?.attack(o.id,a[0],a[1],sceneObjects,physics,a[2])??0; break;
      case 'enemy_attack': if(a.length===4)return window.PStudioGameplay?.strike(o.id,a[0],a[1],a[2],a[3],sceneObjects,physics)??false; break;
      case 'enemy_follow': if(a.length===3)return window.PStudioGameplay?.follow(o.id,a[0],a[1],a[2],sceneObjects,physics)??false; break;
      case 'inventory_add': if(a.length===2)return window.PStudioGameplay?.inventoryAdd(o.id,a[0],a[1]); break;
      case 'inventory_remove': if(a.length===2)return window.PStudioGameplay?.inventoryRemove(o.id,a[0],a[1]); break;
      case 'inventory_count': if(a.length===1)return window.PStudioGameplay?.inventoryCount(o.id,a[0])??0; break;
      case 'quest_start': if(a.length===1)return window.PStudioGameplay?.questStart(a[0])??false; break;
      case 'quest_complete': if(a.length===1)return window.PStudioGameplay?.questComplete(a[0],o.id)??false; break;
      case 'quest_is_complete': if(a.length===1)return window.PStudioGameplay?.questIsComplete(a[0])??false; break;
      case 'quest_set_progress': if(a.length===3)return window.PStudioGameplay?.questSetProgress(a[0],a[1],a[2])??0; break;
      case 'quest_get_progress': if(a.length===1)return window.PStudioGameplay?.questGetProgress(a[0])??0; break;
      case 'nav_add_node': if(a.length===4)return window.PStudioGameplay?.navAddNode(a[0],a[1],a[2],a[3])??false; break;
      case 'nav_connect': if(a.length===2)return window.PStudioGameplay?.navConnect(a[0],a[1])??false; break;
      case 'nav_build_grid': if(a.length===5)return window.PStudioGameplay?.navBuildGrid(a[0],a[1],a[2],a[3],a[4])??0; break;
      case 'nav_block_node': if(a.length===2)return window.PStudioGameplay?.navBlock(a[0],truthy(a[1]))??false; break;
      case 'nav_next_node': if(a.length===2)return window.PStudioGameplay?.navNext(a[0],a[1])??''; break;
      case 'nav_clear': if(!a.length)return window.PStudioGameplay?.navClear(); break;
      case 'nav_build_from_triangles': if(a.length===2)return window.PStudioGameplay?.navBuildFromTriangles(a[0],a[1])??0; break;
      case 'nav_build_from_terrain': if(a.length===8)return window.PStudioGameplay?.navBuildFromTerrain(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7])??0; break;
      case 'nav_build_from_model': if(a.length===6){const triangles=window.PStudio3D?.getModelCollisionTriangles?.({name:String(a[0]),x:finite(a[1]),y:finite(a[2]),z:finite(a[3]),scale:finite(a[4])});return triangles?window.PStudioGameplay?.navBuildFromTriangles(triangles,finite(a[5]))??0:0;} break;
      case 'weapon_define': if(a.length===4)return window.PStudioGameplay?.defineWeapon(a[0],a[1],a[2],a[3])??false; break;
      case 'weapon_attack': if(a.length===4)return window.PStudioGameplay?.weaponAttack(o.id,a[0],a[1],a[2],a[3],sceneObjects,physics)??0; break;
      case 'combo_count': if(!a.length)return window.PStudioGameplay?.comboCount(o.id)??0; break;
      case 'enemy_ai': if(a.length===4)return window.PStudioGameplay?.enemyAI(o.id,a[0],a[1],a[2],a[3],sceneObjects,physics)??'idle'; break;
      case 'ai_state': if(!a.length)return window.PStudioGameplay?.getAIState(o.id)??'idle'; break;
      case 'define_item': if(a.length===4)return window.PStudioGameplay?.defineItem(a[0],a[1],a[2],a[3])??false; break;
      case 'equip_item': if(a.length===1)return window.PStudioGameplay?.equipItem(o.id,a[0])??false; break;
      case 'use_item': if(a.length===1)return window.PStudioGameplay?.useItem(o.id,a[0])??false; break;
      case 'open_inventory': if(!a.length)return window.PStudioGameplay?.openInventory(o.id)??false; break;
      case 'open_quest_log': if(!a.length)return window.PStudioGameplay?.openQuestLog(o.id)??false; break;
      case 'close_game_ui': if(!a.length)return window.PStudioGameplay?.closeUI()??false; break;
      case 'show_dialogue': if(a.length===5)return window.PStudioGameplay?.showDialogue(a[0],a[1],a[2],a[3],a[4])??false; break;
      case 'dialogue_choice': if(!a.length)return window.PStudioGameplay?.getDialogueChoice()??''; break;
      case 'quest_define': if(a.length===4)return window.PStudioGameplay?.questDefine(a[0],a[1],a[2],a[3])??false; break;
      case 'load_model': if (a.length===5) { c.draw.push({type:'model',name:String(a[0]),x:finite(a[1]),y:finite(a[2]),z:finite(a[3]),scale:Math.max(0.001,finite(a[4])),rotationX:(Number(o.rotationX)||0)*Math.PI/180,rotationY:(Number(o.rotationY)||0)*Math.PI/180,rotationZ:(Number(o.rotationZ)||0)*Math.PI/180,dt:c.dt}); return null; } break;
      case 'character_animation': if (a.length===6) {
        c.draw.push({type:'locomotion',idle:String(a[0]),walk:String(a[1]),run:String(a[2]),jump:String(a[3]),fall:String(a[4]),land:String(a[5])});
        return null;
      } break;
      case 'play_animation': if (a.length===1) { c.draw.push({type:'animation',clipName:String(a[0]),loop:true}); return null; } break;
      case 'play_animation_once': if (a.length===1) { c.draw.push({type:'animation',clipName:String(a[0]),loop:false}); return null; } break;
      case 'animation_layer': if(a.length===3){c.draw.push({type:'animation_layer',clip:String(a[0]),weight:Math.max(0,Math.min(1,finite(a[1]))),additive:truthy(a[2])});return null;} break;
      case 'blend_animations': if(a.length===3){c.draw.push({type:'animation_blend',first:String(a[0]),second:String(a[1]),weight:clampAxis(finite(a[2]))});return null;} break;
      case 'stop_animation': if (!a.length) { c.draw.push({type:'animation',stop:true}); return null; } break;
      case 'set_animation_speed': if (a.length===1) { c.draw.push({type:'animation',speed:finite(a[0])}); return null; } break;
      case 'draw_grid': if (a.length===2) { c.draw.push({type:'grid',size:Math.max(1,finite(a[0])),divisions:Math.max(1,Math.min(200,Math.floor(finite(a[1]))))}); return null; } break;
      case 'set_material': if (a.length===2) { c.draw.push({type:'material',roughness:Math.max(0,Math.min(1,finite(a[0]))),metalness:Math.max(0,Math.min(1,finite(a[1])))}); return null; } break;
      case 'set_shader': if(a.length===1){const mode=String(a[0]).toLowerCase();if(!['standard','toon','unlit','normal','wireframe'].includes(mode))throw new PsRuntimeError('Shader preset must be standard, toon, unlit, normal or wireframe.');c.draw.push({type:'material',shader:mode});return null;} break;
      case 'set_toon_material': if(a.length===14){
        const color=(value,fallback)=>/^#[0-9a-f]{6}$/i.test(String(value))?String(value):fallback;
        const bounded=(value,min,max)=>Math.max(min,Math.min(max,finite(value)));
        c.draw.push({type:'toon_material',toon:{
          enabled:true,shadowColor:color(a[0],'#46516f'),midColor:color(a[1],'#9eafd0'),highlightColor:color(a[2],'#ffffff'),
          shadowThreshold:bounded(a[3],0.02,0.95),highlightThreshold:bounded(a[4],0.05,0.99),
          rimColor:color(a[5],'#b8dcff'),rimIntensity:bounded(a[6],0,4),rimPower:bounded(a[7],0.5,8),
          outlineColor:color(a[8],'#182235'),outlineWidth:bounded(a[9],0.005,0.45),
          sssColor:color(a[10],'#f0a5a0'),sssIntensity:bounded(a[11],0,1.5),
          windStrength:bounded(a[12],0,2.5),windSpeed:bounded(a[13],0,4)
        }});return null;
      } break;
      case 'set_model_material': if(a.length===4){c.draw.push({type:'model_material',name:String(a[0]),roughness:Math.max(0,Math.min(1,finite(a[1]))),metalness:Math.max(0,Math.min(1,finite(a[2]))),color:String(a[3])});return null;} break;
      case 'set_postprocessing': if(a.length===3){c.draw.push({type:'postfx',bloom:truthy(a[0]),ssao:truthy(a[1]),strength:finite(a[2])});return null;} break;
      case 'particle_emitter': if(a.length===6){c.draw.push({type:'particle_emitter',emitterId:String(a[0]),x:readPosition(0),y:readPosition(1),z:readPosition(2),rate:Math.max(0,finite(a[1])),color:String(a[2]),speed:Math.max(0,finite(a[3])),lifetime:Math.max(0.05,Math.min(20,finite(a[4]))),maxCount:Math.max(1,Math.min(1200,Math.floor(finite(a[5])))),dt:c.dt});return null;} break;
      case 'stop_particle_emitter': if(a.length===1){c.draw.push({type:'particle_emitter_stop',emitterId:String(a[0])});return null;} break;
      case 'solve_ik': if(a.length===7){c.draw.push({type:'ik',rootBone:String(a[0]),endBone:String(a[1]),target:[finite(a[2]),finite(a[3]),finite(a[4])],iterations:Math.max(1,Math.min(20,Math.floor(finite(a[5])))),weight:Math.max(0,Math.min(1,finite(a[6])))});return null;} break;
      case 'animation_layer': if(a.length===3){c.draw.push({type:'animation_layer',clip:String(a[0]),weight:Math.max(0,Math.min(1,finite(a[1]))),additive:truthy(a[2])});return null;} break;
      case 'camera_shake': if(a.length===2){
        const intensity=Math.max(0,Math.min(2,finite(a[0])));
        const duration=Math.max(0,Math.min(8,finite(a[1])));
        if(runtime)runtime.requires3D=true;
        const triggered=window.PStudio3D?.cameraShake?.(intensity,duration)??false;
        c.draw.push({type:'camera_shake'});
        return triggered;
      } break;
      case 'set_time_scale': if(a.length===1){
        if(!runtime)throw new PsRuntimeError('set_time_scale() はゲーム実行中のみ使用できます。');
        runtime.timeScale=Math.max(0,Math.min(4,finite(a[0])));
        return runtime.timeScale;
      } break;
      case 'draw_trail': if(a.length===4){
        if(runtime)runtime.requires3D=true;
        const targetKey=String(a[0]);
        const target=(sceneObjects||[]).find(item=>String(item.id)===targetKey||String(item.name)===targetKey);
        if(!target)throw new PsRuntimeError('draw_trail(): 対象の Game Object が見つかりません: '+targetKey);
        const targetPhysicsPosition=window.PStudioPhysics?.getPosition?.(target.id);
        const x=Number.isFinite(Number(targetPhysicsPosition?.x))?Number(targetPhysicsPosition.x):((Number(target.x)||0)+(Number(target.w)||64)/2-480)/100;
        const y=Number.isFinite(Number(targetPhysicsPosition?.y))?Number(targetPhysicsPosition.y):(270-((Number(target.y)||0)+(Number(target.h)||64)/2))/100;
        const z=Number.isFinite(Number(targetPhysicsPosition?.z))?Number(targetPhysicsPosition.z):(Number(target.z)||0)/100;
        c.draw.push({type:'trail',targetId:String(target.id),x,y,z,color:String(a[1]),width:Math.max(0.001,Math.min(1,finite(a[2]))),duration:Math.max(0.05,Math.min(10,finite(a[3]))),dt:c.dt});
        return true;
      } break;
      case 'set_god_rays': if(a.length===2){
        if(runtime)runtime.requires3D=true;
        const enabled=truthy(a[0]),intensity=Math.max(0,Math.min(2,finite(a[1])));
        const result=window.PStudio3D?.setGodRays?.(enabled,intensity)??null;
        c.draw.push({type:'camera_fx'});
        return result;
      } break;
      case 'set_camera': if (a.length===6) { c.draw.push({type:'camera',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),targetX:finite(a[3]),targetY:finite(a[4]),targetZ:finite(a[5]),smoothing:0,dt:c.dt,cameraOwnerId:o.id}); return null; } break;
      case 'set_camera_follow': if (a.length===7) { c.draw.push({type:'camera',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),targetX:finite(a[3]),targetY:finite(a[4]),targetZ:finite(a[5]),smoothing:Math.max(0,Math.min(30,finite(a[6]))),dt:c.dt,cameraOwnerId:o.id}); return null; } break;
      case 'ps': c.output.push(String(a[0] ?? '')); return null;
    }
    throw new PsRuntimeError(`未対応の関数、または引数の数が不正です: ${name}()`);
  }
  function finite(v) { const n=Number(v); if(!Number.isFinite(n)) throw new PsRuntimeError('座標・サイズには有限の数値を指定してください。'); return n; }
  function normalizeKey(value) {
    const k=String(value).toLowerCase();
    const aliases={left:'arrowleft',right:'arrowright',up:'arrowup',down:'arrowdown',space:' '};
    return aliases[k]||k;
  }
  function clampAxis(value) { return Math.max(-1,Math.min(1,value)); }
  function evalExpr(c, env, n) {
    if (!n) return null;
    switch(n.type) {
      case 'Literal': { const s=n.value; if(s==='true')return true;if(s==='false')return false;if(s[0]==='"') { try{return JSON.parse(s)}catch(_){return s.slice(1,-1)} } const v=Number(s);return Number.isFinite(v)?v:s; }
      case 'Variable': return getVar(c,env,n.value);
      case 'ArrayLiteral': return (n.elements||[]).map(x=>evalExpr(c,env,x));
      case 'IndexExpr': return getVar(c,env,n.name)[evalExpr(c,env,n.index)];
      case 'MemberExpr': {
        const owner=evalExpr(c,env,n.object),property=String(n.property||'');
        if(!owner||typeof owner!=='object'||Array.isArray(owner)||['__proto__','prototype','constructor'].includes(property)||!Object.prototype.hasOwnProperty.call(owner,property)) {
          throw new PsRuntimeError('Component Fieldを読み取れません: '+property);
        }
        return owner[property];
      }
      case 'UnaryExpr': { const v=evalExpr(c,env,n.right); if(n.op==='!')return !truthy(v);if(n.op==='+')return +v;if(n.op==='-')return -v;if(n.op==='~')return ~v;if(n.op==='++'||n.op==='--'){const nv=v+(n.op==='++'?1:-1);setTarget(c,env,n.right,nv);return nv;}break; }
      case 'PostfixExpr': {const v=evalExpr(c,env,n.value);setTarget(c,env,n.value,v+(n.op==='++'?1:-1));return v;}
      case 'BinaryExpr': {const l=evalExpr(c,env,n.left);if(n.op==='&&')return truthy(l)&&truthy(evalExpr(c,env,n.right));if(n.op==='||')return truthy(l)||truthy(evalExpr(c,env,n.right));const r=evalExpr(c,env,n.right);switch(n.op){case '+':return l+r;case '-':return l-r;case '*':return l*r;case '/':if(r===0)throw new PsRuntimeError('0で割ることはできません。');return l/r;case '%':return l%r;case '**':return l**r;case '&':return l&r;case '|':return l|r;case '^':return l^r;case '<<':return l<<r;case '>>':return l>>r;case '==':return l===r;case '!=':return l!==r;case '<':return l<r;case '>':return l>r;case '<=':return l<=r;case '>=':return l>=r;}break;}
      case 'CallExpr': return callFunction(c,n.name,(n.args||[]).map(x=>evalExpr(c,env,x)));
    }
    throw new PsRuntimeError(`未対応の式: ${n.type}`);
  }
  function execBlock(c, nodes, env) {
    for(let i=0;i<nodes.length;i++) {
      if(++c.steps>5000) throw new PsRuntimeError('1フレーム内の処理量が上限を超えました。無限ループの可能性があります。');
      const n=nodes[i];
      if(n.type==='IfStatement') { let matched=false; if(truthy(evalExpr(c,env,n.condition))){execBlock(c,n.body||[],env);matched=true;} while(i+1<nodes.length&&['ElifStatement','ElseStatement'].includes(nodes[i+1].type)){const b=nodes[++i];if(!matched&&(b.type==='ElseStatement'||truthy(evalExpr(c,env,b.condition)))){execBlock(c,b.body||[],env);matched=true;}} continue; }
      if(n.type==='ElifStatement'||n.type==='ElseStatement') continue;
      switch(n.type) {
        case 'FunctionDef': break;
        case 'AssignmentExpression': env[n.variable]=evalExpr(c,env,n.value);break;
        case 'CompoundAssignment': {const v=getVar(c,env,n.variable),r=evalExpr(c,env,n.value),op=n.op.slice(0,-1);env[n.variable]=binary(op,v,r);break;}
        case 'ArrayAssignStatement': {getVar(c,env,n.name)[evalExpr(c,env,n.index)]=evalExpr(c,env,n.value);break;}
        case 'ArrayCompoundAssignStatement': {const a=getVar(c,env,n.name),k=evalExpr(c,env,n.index);a[k]=binary(n.op.slice(0,-1),a[k],evalExpr(c,env,n.value));break;}
        case 'MemberAssignment': setTarget(c,env,n.target,evalExpr(c,env,n.value));break;
        case 'MemberCompoundAssignment': {const current=evalExpr(c,env,n.target),value=evalExpr(c,env,n.value);setTarget(c,env,n.target,binary(n.op.slice(0,-1),current,value));break;}
        case 'ComponentDef': case 'SystemDef': case 'FunctionDef': break;
        case 'PrintStatement': c.output.push(String(evalExpr(c,env,n.value)));break;
        case 'ExpressionStatement': evalExpr(c,env,n.value);break;
        case 'WhileStatement': {let guard=0;while(truthy(evalExpr(c,env,n.condition))){if(++guard>1000)throw new PsRuntimeError('while の反復回数が上限を超えました。');try{execBlock(c,n.body||[],env)}catch(s){if(s===BREAK)break;if(s===CONTINUE)continue;throw s;}}break;}
        case 'ForStatement': {const values=evalExpr(c,env,n.range);let guard=0;for(const v of values){if(++guard>100000)throw new PsRuntimeError('for の反復回数が上限を超えました。');env[n.variable]=v;try{execBlock(c,n.body||[],env)}catch(s){if(s===BREAK)break;if(s===CONTINUE)continue;throw s;}}break;}
        case 'BREAKStatement': throw BREAK;
        case 'CONTINUEStatement': throw CONTINUE;
        case 'ReturnStatement': throw {kind:RETURN,value:n.value?evalExpr(c,env,n.value):null};
        default: throw new PsRuntimeError(`未対応の命令: ${n.type}`);
      }
    }
  }
  function binary(op,a,b){switch(op){case '+':return a+b;case '-':return a-b;case '*':return a*b;case '/':if(!b)throw new PsRuntimeError('0で割ることはできません。');return a/b;case '%':return a%b;case '&':return a&b;case '|':return a|b;case '^':return a^b;case '<<':return a<<b;case '>>':return a>>b;}throw new PsRuntimeError(`演算子 ${op} は未対応です。`)}

  function imageByName(name) {
    const asset=(projectAssets||[]).find(a=>a.kind==='image'&&a.name===name);
    if(!asset)return null;
    let img=imageCache.get(name);if(!img){img=new Image();img.src=asset.data;img.onload=()=>renderFrame();imageCache.set(name,img);}return img.complete&&img.naturalWidth?img:null;
  }
  function drawScene(commandsByObject) {
    ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#171d26';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle='#28313d';ctx.lineWidth=1;for(let x=0;x<canvas.width;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke()}for(let y=0;y<canvas.height;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke()}
    for(const o of sceneObjects||[]){const img=o.sprite?imageByName(o.sprite):null;if(img)ctx.drawImage(img,o.x,o.y,o.w,o.h);else{ctx.fillStyle=o.color||'#d1d5db';if(o.shape==='circle'){ctx.beginPath();ctx.arc(o.x+o.w/2,o.y+o.h/2,Math.max(o.w,o.h)/2,0,Math.PI*2);ctx.fill()}else ctx.fillRect(o.x,o.y,o.w,o.h);}ctx.fillStyle='#e5e7eb';ctx.font='12px sans-serif';ctx.fillText(o.name||'',o.x,o.y-8);}
    for(const list of commandsByObject.values())for(const d of list){if(d.type==='rect'){ctx.fillStyle=d.color;ctx.fillRect(d.x,d.y,d.w,d.h)}else if(d.type==='circle'){ctx.fillStyle=d.color;ctx.beginPath();ctx.arc(d.x,d.y,d.r,0,Math.PI*2);ctx.fill()}else if(d.type==='sprite'){const im=imageByName(d.name);if(im)ctx.drawImage(im,d.x,d.y);}}
    const selected=(sceneObjects||[]).find(o=>o.id===selectedObjectId);if(selected){ctx.strokeStyle='#f4f4f5';ctx.lineWidth=2;ctx.setLineDash([6,4]);if(selected.shape==='circle'){ctx.beginPath();ctx.arc(selected.x+selected.w/2,selected.y+selected.h/2,Math.max(selected.w,selected.h)/2+4,0,Math.PI*2);ctx.stroke()}else{ctx.strokeRect(selected.x-4,selected.y-4,selected.w+8,selected.h+8)}ctx.setLineDash([])}
  }
  function collides(a,b) {
    if(a.shape==='circle'&&b.shape==='circle'){const ax=a.x+a.w/2,ay=a.y+a.h/2,bx=b.x+b.w/2,by=b.y+b.h/2;const r=(Math.max(a.w,a.h)+Math.max(b.w,b.h))/2;return (ax-bx)**2+(ay-by)**2<=r*r;}
    if(a.shape==='circle'||b.shape==='circle'){const c=a.shape==='circle'?a:b,r=a.shape==='circle'?b:a;const cx=c.x+c.w/2,cy=c.y+c.h/2,nx=Math.max(r.x,Math.min(cx,r.x+r.w)),ny=Math.max(r.y,Math.min(cy,r.y+r.h));return (cx-nx)**2+(cy-ny)**2<=(Math.max(c.w,c.h)/2)**2;}
    return a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
  }
  function dispatchCollision(object, other) {
    const state=runtime.states.get(object.id);if(!state)return;
    const c=setupContext(object,0);c.steps=0;
    if(c.funcs.on_collision){callFunction(c,'on_collision',[other.name||other.id]);runtime.states.set(object.id,c.env);if(c.output.length)setOutput?.(c.output.join('\n'),'normal');}
  }
  function updateCollisions() {
    const objs=(sceneObjects||[]).filter(o=>o.collider&&window.PStudio3D?.isOwnerChunkActive?.(o.id)!==false);
    const now=new Set();
    for(let i=0;i<objs.length;i++)for(let j=i+1;j<objs.length;j++){const a=objs[i],b=objs[j];if(collides(a,b)){const key=[a.id,b.id].sort().join('|');now.add(key);window.PStudioECSCollision?.observePair?.('2d',a,b);if(!collisionPairs.has(key)){dispatchCollision(a,b);dispatchCollision(b,a);}}}
    collisionPairs=now;
  }

  // 3D AABB collision is isolated from the existing 2D collider system.
  function bounds3D(command) {
    const x=Number(command.x)||0, y=Number(command.y)||0, z=Number(command.z)||0;
    let hx=0,hy=0,hz=0;
    if (command.type === 'sphere') {
      hx=hy=hz=Math.max(0,Number(command.radius)||0);
    } else if (command.type === 'cube' || command.type === 'box') {
      const a=command.type==='cube' ? Math.max(0,Number(command.size)||0)/2 : Math.max(0,Number(command.width)||0)/2;
      const b=command.type==='cube' ? a : Math.max(0,Number(command.height)||0)/2;
      const c=command.type==='cube' ? a : Math.max(0,Number(command.depth)||0)/2;
      const rx=Number(command.rotationX)||0, ry=Number(command.rotationY)||0, rz=Number(command.rotationZ)||0;
      const c1=Math.cos(rx),s1=Math.sin(rx),c2=Math.cos(ry),s2=Math.sin(ry),c3=Math.cos(rz),s3=Math.sin(rz);
      hx=Math.abs(c2*c3)*a+Math.abs(c2*s3)*b+Math.abs(s2)*c;
      hy=Math.abs(s1*s2*c3+c1*s3)*a+Math.abs(s1*s2*s3-c1*c3)*b+Math.abs(s1*c2)*c;
      hz=Math.abs(c1*s2*c3-s1*s3)*a+Math.abs(c1*s2*s3+s1*c3)*b+Math.abs(c1*c2)*c;
    } else if (command.type==='cylinder' || command.type==='cone') {
      hx=hz=Math.max(0,Number(command.radius)||0); hy=Math.max(0,Number(command.height)||0)/2;
    } else if (command.type==='capsule') {
      hx=hz=Math.max(0,Number(command.radius)||0); hy=Math.max(0,Number(command.height)||0)/2;
    } else return null;
    return {minX:x-hx,maxX:x+hx,minY:y-hy,maxY:y+hy,minZ:z-hz,maxZ:z+hz};
  }
  function overlaps3D(a,b) {
    return a.minX<=b.maxX&&a.maxX>=b.minX&&
      a.minY<=b.maxY&&a.maxY>=b.minY&&
      a.minZ<=b.maxZ&&a.maxZ>=b.minZ;
  }
  function update3DCollisions(commandsByObject) {
    const colliders=[];
    for (const [id,draws] of commandsByObject) {
      const owner=(sceneObjects||[]).find(o=>o.id===id);
      if (!owner||window.PStudio3D?.isOwnerChunkActive?.(id)===false) continue;
      for (const draw of draws) {
        const bounds=bounds3D(draw);
        if (bounds) colliders.push({owner,bounds});
      }
    }
    const now=new Set();
    for(let i=0;i<colliders.length;i++) for(let j=i+1;j<colliders.length;j++) {
      const a=colliders[i],b=colliders[j];
      if(a.owner.id===b.owner.id||!overlaps3D(a.bounds,b.bounds)) continue;
      const key=[a.owner.id,b.owner.id].sort().join('|');
      if(now.has(key)) continue;
      now.add(key);
      window.PStudioECSCollision?.observePair?.('3d',a.owner,b.owner);
      if(!collision3DPairs.has(key)) {
        dispatchCollision(a.owner,b.owner);
        dispatchCollision(b.owner,a.owner);
      }
    }
    collision3DPairs=now;
  }
  let renderMode = 'auto';
  function updateViewModeButtons() {
    for (const mode of ['auto','2d','3d']) {
      const button = $('view-mode-' + mode);
      if (button) {
        const active=renderMode===mode;
        button.classList.toggle('active',active);
        button.setAttribute('aria-pressed',active?'true':'false');
        button.setAttribute('aria-label','View mode '+mode.toUpperCase()+(active?' active':' inactive'));
        button.title='View mode: '+mode.toUpperCase()+(active?' · ACTIVE':' · INACTIVE');
      }
    }
  }
  function buildScenePreview3D() {
    window.syncEcsSceneMaterials?.();
    const commands = new Map();
    commands.set('__scene__',[{type:'grid',size:500,divisions:100},{type:'environment',preset:sceneEnvironment?.preset||'day'},{type:'camera',x:6,y:5,z:8,targetX:0,targetY:0,targetZ:0}]);
    for (const o of sceneObjects || []) {
      const x = ((Number(o.x)||0) + (Number(o.w)||64)/2 - 480) / 100;
      const y = (270 - ((Number(o.y)||0) + (Number(o.h)||64)/2)) / 100;
      const z = (Number(o.z)||0) / 100;
      const w = Math.max(0.05,(Number(o.w)||64)/100);
      const h = Math.max(0.05,(Number(o.h)||64)/100);
      const color = o.color || '#d1d5db';
      const draw = o.model
        ? {type:'model',name:String(o.model),x,y,z,scale:Math.max(0.001,Number(o.modelScale)||1),rotationX:(Number(o.rotationX)||0)*Math.PI/180,rotationY:(Number(o.rotationY)||0)*Math.PI/180,rotationZ:(Number(o.rotationZ)||0)*Math.PI/180,dt:0,ecsRenderableFallback:true}
        : o.shape === 'circle'
          ? {type:'sphere',x,y,z,radius:Math.max(w,h)/2,color}
          : {type:'box',x,y,z,width:w,height:h,depth:Math.max(0.12,Math.min(w,h)*0.35),color,rotationX:(Number(o.rotationX)||0)*Math.PI/180,rotationY:(Number(o.rotationY)||0)*Math.PI/180,rotationZ:(Number(o.rotationZ)||0)*Math.PI/180};
      const objectCommands=[];
      if(o.toonMaterialSettings)objectCommands.push({type:'toon_material',toon:o.toonMaterialSettings});
      if(o.postProcessing)objectCommands.push({type:'postfx',bloom:!!o.postProcessing.bloom,ssao:!!o.postProcessing.ssao,strength:Number.isFinite(Number(o.postProcessing.strength))?Number(o.postProcessing.strength):0.45});
      for(const override of o.modelMaterialOverrides||[])objectCommands.push({type:'model_material',name:override.name,roughness:override.roughness,metalness:override.metalness,color:override.color,doubleSide:override.doubleSide,recomputeNormals:override.recomputeNormals,emissive:override.emissive,emissiveIntensity:override.emissiveIntensity,toon:override.toon});
      if(o.shaderFragment)objectCommands.push({type:'material',shader:'custom',fragmentShader:o.shaderFragment});
      if(o.particleEmitter?.enabled)objectCommands.push({type:'particle_emitter',emitterId:'inspector',x,y,z,rate:Number(o.particleEmitter.rate)||12,color:o.particleEmitter.color||'#ffffff',speed:Number(o.particleEmitter.speed)||2,lifetime:Number(o.particleEmitter.lifetime)||1,maxCount:Number(o.particleEmitter.maxCount)||200,dt:0.016});
      objectCommands.push(draw);commands.set(o.id,objectCommands);
    }
    window.PStudioECSMaterials?.collectCommands?.(commands, sceneObjects || []);
    window.PStudioECSRendering?.collectCommands?.(commands, sceneObjects || [], 0);
    window.PStudioECSVisualFX?.collectCommands?.(commands, sceneObjects || [], 0);
    return commands;
  }
  function setViewMode(mode) {
    if (!['auto','2d','3d'].includes(mode)) return;
    renderMode = mode; updateViewModeButtons();
    if (runtime?.running) { renderFrame(); return; }
    const c2=$('game-canvas'), c3=$('game-3d-canvas');
    if (mode === '3d') {
      if(c2)c2.style.display='none'; if(c3)c3.style.display='block';
      if(!window.PStudio3D){setOutput?.('3D renderer is unavailable. Check the Three.js connection.','error');return;}
      try{
        window.PStudio3D.render(buildScenePreview3D());
        const modelNames=new Set((sceneObjects||[]).map(object=>object.model).filter(Boolean).map(String));
        for(const name of modelNames)window.PStudio3D.retryModelAsset?.(name);
      }catch(err){
        const message='3D view error: '+String(err?.message||err);
        setOutput?.(message,'error');
        const status=$('game-status');if(status)status.textContent='3D VIEW ERROR';
      }
    } else { if(c3)c3.style.display='none'; if(c2)c2.style.display='block'; if(typeof renderGamePreview==='function')renderGamePreview(); }
  }
  function renderHud(commands) {
    const canvas=$('game-hud-canvas');if(!canvas)return;const context=canvas.getContext('2d');if(!context)return;
    context.clearRect(0,0,canvas.width,canvas.height);
    for(const draw of commands){
      if(draw.type==='hud_text'){context.save();context.font='600 '+draw.size+'px system-ui,sans-serif';context.fillStyle=draw.color||'#ffffff';context.textBaseline='top';context.shadowColor='#000000';context.shadowBlur=3;context.fillText(String(draw.text),draw.x,draw.y);context.restore();}
      else if(draw.type==='hud_bar'){const ratio=clampAxis(Number(draw.value)/Math.max(0.001,Number(draw.max)));context.save();context.fillStyle='#111827cc';context.fillRect(draw.x,draw.y,draw.w,draw.h);context.fillStyle=draw.color||'#22c55e';context.fillRect(draw.x,draw.y,draw.w*ratio,draw.h);context.strokeStyle='#ffffffaa';context.lineWidth=1;context.strokeRect(draw.x,draw.y,draw.w,draw.h);context.restore();}
    }
  }
  function renderFrame() {
    const commands=new Map();
    commands.set('__scene__',[{type:'environment',preset:sceneEnvironment?.preset||'day'}]);
    for(const [id,draws] of runtime?.contexts||[])commands.set(id,Array.isArray(draws)?draws:(draws?.draw||[]));
    const activeCommands=new Map([...commands].filter(([id])=>id==='__scene__'||window.PStudio3D?.isOwnerChunkActive?.(id)!==false));
    const drawCommands=new Map([...activeCommands].filter(([id])=>id!=='__scene__'));
    const draws=[...drawCommands.values()].flat();
    const hudDraws=draws.filter(d=>d.type==='hud_text'||d.type==='hud_bar');
    const allDraws=draws;
    const has3D=allDraws.some(d=>['cube','box','sphere','plane','cylinder','cone','capsule','grid','camera','environment','model','terrain','water','light','particles','particle_emitter','particle_emitter_stop','postfx','trail','camera_shake','camera_fx'].includes(d.type));
    const use3D=renderMode==='3d'||(renderMode==='auto'&&(!!runtime?.requires3D||has3D));
    const c2=$('game-canvas'),c3=$('game-3d-canvas');
    if(use3D){if(c2)c2.style.display='none';if(c3)c3.style.display='block';if(!window.PStudio3D)throw new PsRuntimeError('3D renderer is unavailable. Check the Three.js connection.');window.PStudio3D.render(commands);}
    else{if(c3)c3.style.display='none';if(c2)c2.style.display='block';drawScene(drawCommands);}
    renderHud(hudDraws);
    const status=$('game-status'); if(status&&runtime?.running){const m=status.textContent.match(/([0-9.]+) FPS/);status.textContent='RUNNING · '+(m?m[1]:'0')+' FPS · '+(sceneObjects||[]).length+' objects · VIEW '+(use3D?'3D':'2D')+' · '+draws.length+' draw calls';}
  }
  function tick(time) {
    if(!runtime?.running)return;
    const raw=lastTime?Math.max(0,(time-lastTime)/1000):0;lastTime=time;const timeScale=Math.max(0,Math.min(4,Number(runtime?.timeScale??1)));const dt=Math.min(0.1,raw*timeScale);
    try {
      window.PStudioECSCollision?.beginFrame?.();
      const commands=new Map();
      for(const object of sceneObjects||[]){
        const active=window.PStudio3D?.isOwnerChunkActive?.(object.id)!==false;
        window.PStudioPhysics?.setActive?.(object.id,active);
        window.PStudioECS?.setSceneObjectActive?.(object.id,active);
        if(!active&&!chunkAudioSuspended.has(String(object.id))){pauseOwnerAudio(object.id);chunkAudioSuspended.add(String(object.id));}
        else if(active&&chunkAudioSuspended.has(String(object.id))){resumeOwnerAudio(object.id);chunkAudioSuspended.delete(String(object.id));}
      }
      window.PStudioECSInput?.captureFrame?.({keys,pressed:justPressed,virtualKeys,axisX:virtualAxis.x,axisZ:virtualAxis.z,touched:touchActive,touchX:pointerPosition.x,touchY:pointerPosition.y});
      window.PStudioPhysics?.beginFrame?.();
      const ecs = window.PStudioECS;
      if (ecs?.hasActiveSystems?.()) {
        const ecsContext = { sceneObjects: sceneObjects || [], runtime };
        ecs.syncSceneObjects(sceneObjects || []);
        for(const object of sceneObjects||[])ecs.setSceneObjectActive?.(object.id,window.PStudio3D?.isOwnerChunkActive?.(object.id)!==false);
        ecs.update(dt, ecsContext);
        ecs.updatePhase?.('prePhysics', dt, ecsContext);
        ecs.applySceneObjectTransforms(sceneObjects || []);
      }
      for(const o of sceneObjects||[]){
        if(window.PStudio3D?.isOwnerChunkActive?.(o.id)===false){const previous=runtime.contexts.get(o.id);if(previous)commands.set(o.id,previous);continue;}
        const script=astForScript(o.script);if(!script)continue;
        const c=setupContext(o,dt);c.steps=0;
        if(!runtime.initialized.has(o.id)){
          runtime.initialized.add(o.id);
          const topLevel=(script.body||[]).filter(n=>n.type!=='FunctionDef');
          if(topLevel.length)execBlock(c,topLevel,c.env);
        }
        if(!runtime.started.has(o.id)){
          runtime.started.add(o.id);
          if(c.funcs.start)callFunction(c,'start',[]);
        }
        c.dt=dt;
        if(c.funcs.update)callFunction(c,'update',[dt]);
        runtime.states.set(o.id,c.env);
        const objectDraws=c.draw.slice();
        if(o.toonMaterialSettings)objectDraws.unshift({type:'toon_material',toon:o.toonMaterialSettings});
        if(o.postProcessing)objectDraws.unshift({type:'postfx',bloom:!!o.postProcessing.bloom,ssao:!!o.postProcessing.ssao,strength:Number.isFinite(Number(o.postProcessing.strength))?Number(o.postProcessing.strength):0.45});
        if(o.particleEmitter?.enabled)objectDraws.push({type:'particle_emitter',emitterId:'inspector',x:((Number(o.x)||0)+(Number(o.w)||64)/2-480)/100,y:(270-((Number(o.y)||0)+(Number(o.h)||64)/2))/100,z:(Number(o.z)||0)/100,rate:Number(o.particleEmitter.rate)||12,color:o.particleEmitter.color||'#ffffff',speed:Number(o.particleEmitter.speed)||2,lifetime:Number(o.particleEmitter.lifetime)||1,maxCount:Number(o.particleEmitter.maxCount)||200,dt});
        if(o.modelMaterialOverrides?.length)for(const override of o.modelMaterialOverrides)objectDraws.unshift({type:'model_material',name:override.name,roughness:override.roughness,metalness:override.metalness,color:override.color,doubleSide:override.doubleSide,recomputeNormals:override.recomputeNormals,emissive:override.emissive,emissiveIntensity:override.emissiveIntensity,toon:override.toon});
        if(o.shaderFragment)objectDraws.unshift({type:'material',shader:'custom',fragmentShader:o.shaderFragment});
        if(o.model&&!objectDraws.some(d=>d.type==='model')){
          const mx=((Number(o.x)||0)+(Number(o.w)||64)/2-480)/100;
          const my=(270-((Number(o.y)||0)+(Number(o.h)||64)/2))/100;
          objectDraws.unshift({type:'model',name:String(o.model),x:mx,y:my,z:(Number(o.z)||0)/100,scale:Math.max(0.001,Number(o.modelScale)||1),rotationX:(Number(o.rotationX)||0)*Math.PI/180,rotationY:(Number(o.rotationY)||0)*Math.PI/180,rotationZ:(Number(o.rotationZ)||0)*Math.PI/180,dt,ecsRenderableFallback:true});
        }
        commands.set(o.id,objectDraws);
        if(c.output.length)setOutput?.(c.output.join('\n'),'normal');
      }

      // Scene-only render settings (models and particle emitters) remain active without scripts.
      for(const o of sceneObjects||[]){
        if(window.PStudio3D?.isOwnerChunkActive?.(o.id)===false)continue;
        if(o.script||(!o.model&&!o.postProcessing&&!o.particleEmitter?.enabled&&!o.toonMaterialSettings))continue;
        const x=((Number(o.x)||0)+(Number(o.w)||64)/2-480)/100;
        const y=(270-((Number(o.y)||0)+(Number(o.h)||64)/2))/100;
        const z=(Number(o.z)||0)/100;
        const list=[];
        if(o.toonMaterialSettings)list.push({type:'toon_material',toon:o.toonMaterialSettings});
        if(o.postProcessing)list.push({type:'postfx',bloom:!!o.postProcessing.bloom,ssao:!!o.postProcessing.ssao,strength:Number.isFinite(Number(o.postProcessing.strength))?Number(o.postProcessing.strength):0.45});
        for(const override of o.modelMaterialOverrides||[])list.push({type:'model_material',name:override.name,roughness:override.roughness,metalness:override.metalness,color:override.color,doubleSide:override.doubleSide,recomputeNormals:override.recomputeNormals,emissive:override.emissive,emissiveIntensity:override.emissiveIntensity,toon:override.toon});
        if(o.particleEmitter?.enabled)list.push({type:'particle_emitter',emitterId:'inspector',x,y,z,rate:Number(o.particleEmitter.rate)||12,color:o.particleEmitter.color||'#ffffff',speed:Number(o.particleEmitter.speed)||2,lifetime:Number(o.particleEmitter.lifetime)||1,maxCount:Number(o.particleEmitter.maxCount)||200,dt});
        if(o.model)list.push({type:'model',name:String(o.model),x,y,z,scale:Math.max(0.001,Number(o.modelScale)||1),rotationX:(Number(o.rotationX)||0)*Math.PI/180,rotationY:(Number(o.rotationY)||0)*Math.PI/180,rotationZ:(Number(o.rotationZ)||0)*Math.PI/180,dt,ecsRenderableFallback:true});
        if(list.length)commands.set(o.id,list);
      }

      const ecsAfterScripts = window.PStudioECS;
      if (ecsAfterScripts?.hasActiveSystems?.()) {
        const ecsContext = { sceneObjects: sceneObjects || [], runtime };
        ecsAfterScripts.updatePhase?.('postUpdate', dt, ecsContext);
        ecsAfterScripts.applySceneObjectTransforms(sceneObjects || []);
      }
      window.PStudioECSStreaming?.sync?.(sceneObjects || []);
      window.PStudioECSRendering?.collectCommands?.(commands, sceneObjects || [], dt);
      window.PStudioECSVisualFX?.collectCommands?.(commands, sceneObjects || [], dt);
      window.PStudioECSMaterials?.collectCommands?.(commands, sceneObjects || []);
      for(const [ownerId,draws] of commands){
        const owner=(sceneObjects||[]).find(item=>String(item.id)===String(ownerId));
        const ecs=window.PStudioECS;
        const entity=ecs?.getEntityForSceneObject?.(String(ownerId));
        const meshCollider=entity!==null&&entity!==undefined&&ecs?.hasComponent?.(entity,'MeshCollider')
          ? ecs.getComponent(entity,'MeshCollider') : null;
        const colliderEnabled=meshCollider ? meshCollider.enabled===true : owner?.collider===true;
        if(colliderEnabled){
          const modelDraw=draws.find(d=>d.type==='model');
          if(modelDraw&&!draws.some(d=>d.type==='model_mesh_collider')){
            const triangles=window.PStudio3D?.getModelCollisionTriangles?.(modelDraw);
            if(triangles?.length)draws.push({type:'model_mesh_collider',triangles});
          }
        }
      }
      const physicsCommands=new Map([...commands].filter(([id])=>window.PStudio3D?.isOwnerChunkActive?.(id)!==false));
      const transforms=window.PStudioPhysics?.step?.(dt,physicsCommands)||new Map();
      const ownersById=new Map((sceneObjects||[]).map(item=>[String(item.id),item]));
      for(const pair of window.PStudioPhysics?.getContactPairs?.()||[]){
        const [aId,bId]=pair;
        const a=ownersById.get(String(aId))||{id:String(aId),name:String(aId)};
        const b=ownersById.get(String(bId))||{id:String(bId),name:String(bId)};
        window.PStudioECSCollision?.observePair?.('physics',a,b);
      }
      const ecsAfterPhysics = window.PStudioECS;
      if (ecsAfterPhysics?.hasActiveSystems?.()) {
        const ecsContext = { sceneObjects: sceneObjects || [], runtime, physicsTransforms: transforms };
        ecsAfterPhysics.updatePhase?.('postPhysics', dt, ecsContext);
        ecsAfterPhysics.applySceneObjectTransforms(sceneObjects || []);
      }
      for(const [id,transform] of transforms){
        const owner=ownersById.get(id);
        const draws=commands.get(id)||[];

        // Rotate a controlled character toward its actual world-space travel direction.
        if(owner&&transform.controlled&&transform.horizontalSpeed>0.12){
          const current=(Number(owner.rotationY)||0)*Math.PI/180;
          const desired=Math.atan2(transform.velocityX,transform.velocityZ);
          const delta=Math.atan2(Math.sin(desired-current),Math.cos(desired-current));
          const turnAlpha=1-Math.exp(-14*Math.max(0,Math.min(0.1,dt)));
          owner.rotationY=(current+delta*turnAlpha)*180/Math.PI;
        }

        if(transform.landed){
          runtime.nextLandSequence=(runtime.nextLandSequence||0)+1;
          runtime.landSequences.set(id,runtime.nextLandSequence);
        }

        for(const draw of draws){
          if(draw.type==='camera'){
            draw.x=finite(draw.x)+transform.dx;
            draw.y=finite(draw.y)+transform.dy;
            draw.z=finite(draw.z)+transform.dz;
            draw.targetX=finite(draw.targetX)+transform.dx;
            draw.targetY=finite(draw.targetY)+transform.dy;
            draw.targetZ=finite(draw.targetZ)+transform.dz;
            continue;
          }
          if(draw.type==='light'){
            draw.x=finite(draw.x)+transform.dx;
            draw.y=finite(draw.y)+transform.dy;
            draw.z=finite(draw.z)+transform.dz;
            draw.targetX=finite(draw.targetX)+transform.dx;
            draw.targetY=finite(draw.targetY)+transform.dy;
            draw.targetZ=finite(draw.targetZ)+transform.dz;
            continue;
          }
          if(['cube','box','sphere','plane','cylinder','cone','capsule','model'].includes(draw.type)){
            draw.x=finite(draw.x)+transform.dx;
            draw.y=finite(draw.y)+transform.dy;
            draw.z=finite(draw.z)+transform.dz;
            if(owner&&transform.controlled){
              draw.rotationY=(Number(owner.rotationY)||0)*Math.PI/180;
            }
          }
          if(draw.type==='locomotion'){
            draw.grounded=transform.grounded;
            draw.speed=transform.horizontalSpeed;
            draw.velocityY=transform.velocityY;
            draw.landSequence=runtime.landSequences.get(id)||0;
          }
        }
      }
      runtime.contexts=commands;
      updateCollisions();
      update3DCollisions(commands);
      window.PStudioECSCollision?.commitContacts?.();
      renderFrame();
      window.PStudioECSCollision?.endFrame?.();
      window.PStudioUI?.render?.(window.PStudioGameplay?.getUIState?.()||null);
      justPressed.clear();
      raf=requestFrame(tick);
    } catch(err) {
      stopGame();
      setOutput?.(`Game runtime error: ${err.message}`,'error');
    }
  }
  function ecsBindingName(name){
    return String(name).replace(/([A-Z]+)([A-Z][a-z])/g,'$1_$2').replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
  }
  function ecsSystemRuntimeId(filename,systemName){
    const source=String(filename)+'\\0'+String(systemName);
    let hash=2166136261;
    for(let i=0;i<source.length;i++)hash=Math.imul(hash^source.charCodeAt(i),16777619);
    return 'ps.'+(hash>>>0).toString(36);
  }
  function cloneEcsDefault(value){return Array.isArray(value)?value.map(cloneEcsDefault):value;}
  function ecsLiteralValue(node){
    if(!node||typeof node!=='object')throw new PsRuntimeError('ECS Component初期値が不正です。');
    if(node.type==='Literal'){
      const raw=String(node.value??'');
      if(raw==='true')return true;
      if(raw==='false')return false;
      if(raw.startsWith('"')){try{return JSON.parse(raw);}catch(_){throw new PsRuntimeError('ECS文字列初期値が不正です。');}}
      const number=Number(raw);
      if(!Number.isFinite(number))throw new PsRuntimeError('ECS数値初期値が不正です。');
      return number;
    }
    if(node.type==='ArrayLiteral')return (node.elements||[]).map(ecsLiteralValue);
    throw new PsRuntimeError('ECS Component初期値はリテラルまたは配列のみ対応しています。');
  }
  function cleanupEcsRuntime(){
    const ecs=window.PStudioECS;
    if(!runtime||!ecs)return;
    for(const id of runtime.ecsSystemIds||[]){try{ecs.unregisterSystem(id);}catch(error){console.warn('[PStudio ECS] System cleanup failed:',id,error);}}
    runtime.ecsSystemIds=[];
    window.PStudioGameplay?.persistECS?.(sceneObjects || []);
    ecs.clearSceneObjects?.();
    for(const type of [...(runtime.ecsComponentTypes||[])].reverse()){
      try{ecs.unregisterComponent?.(type);}catch(error){console.warn('[PStudio ECS] Component cleanup failed:',type,error);}
    }
    runtime.ecsComponentTypes=[];
    runtime.ecsStates?.clear?.();
  }
  function registerEcsRuntime(asts){
    const ecs=window.PStudioECS;
    const componentDefs=[],systemDefs=[];
    for(const [filename,ast] of Object.entries(asts||{})){
      for(const node of ast?.body||[]){
        if(node.type==='ComponentDef')componentDefs.push({filename,node});
        else if(node.type==='SystemDef')systemDefs.push({filename,node});
      }
    }
    if(!componentDefs.length&&!systemDefs.length)return;
    if(!ecs)throw new PsRuntimeError('PStudioECSが初期化されていません。');
    const definitions=new Map();
    for(const item of componentDefs){
      const name=String(item.node.name);
      if(definitions.has(name))throw new PsRuntimeError('Componentが複数回定義されています: '+name);
      const existingDefinition=ecs.getComponentDefinition?.(name);
      if(existingDefinition && existingDefinition.source!==item.filename)throw new PsRuntimeError('Component名が既存ECS型と衝突しています: '+name);
      const defaults=Object.create(null);
      const schema=Object.create(null);
      for(const field of item.node.body||[]){
        const value=ecsLiteralValue(field.value);
        defaults[field.variable]=value;
        const rawLiteral=String(field.value?.value??'');
        const type=typeof value==='boolean'?'boolean':typeof value==='string'?'string':Array.isArray(value)?'array':Number.isInteger(value)&&!/[.eE]/.test(rawLiteral)?'integer':'number';
        schema[field.variable]={type,default:cloneEcsDefault(value),label:field.variable};
      }
      definitions.set(name,{defaults,schema,source:item.filename});
    }
    runtime.ecsComponentTypes=[];
    runtime.ecsSystemIds=[];
    runtime.ecsStates=new Map();
    try{
      for(const [name,definition] of definitions){
        const create=()=>Object.fromEntries(Object.entries(definition.defaults).map(([key,value])=>[key,cloneEcsDefault(value)]));
        if(!ecs.hasComponentType?.(name)){
          ecs.registerComponent(name,{
            create,
            schema:definition.schema,
            additionalProperties:false,
            source:definition.source
          });
          runtime.ecsComponentTypes.push(name);
        }else{
          const existing=ecs.getComponentDefinition?.(name);
          if(existing?.source!==definition.source){
            throw new PsRuntimeError('Component定義の所有元が一致しません: '+name);
          }
          ecs.updateComponentDefinition?.(name,{
            create,
            schema:definition.schema,
            additionalProperties:false,
            source:definition.source
          });
        }
      }
      // Restore Component values after all declarations have been registered.
      ecs.syncSceneObjects?.(sceneObjects || []);
      // Backward compatibility: scenes without an explicit ECS assignment list keep
      // the first-bridge behavior. An explicit [] means no custom Component is attached.
      for(const object of sceneObjects||[]){
        const entity=ecs.getEntityForSceneObject?.(object.id);
        if(!entity)continue;
        if(!Array.isArray(object.ecsComponents)){
          for(const name of definitions.keys()){
            if(!ecs.hasComponent(entity,name))ecs.addComponent(entity,name);
          }
        }
      }
      for(const {filename,node} of systemDefs){
        const systemId=ecsSystemRuntimeId(filename,node.name);
        const componentNames=(node.components||[]).map(String);
        const registered=ecs.registerSystem({
          id:systemId,
          name:String(node.name),
          source:filename,
          components:componentNames,
          phase:'update',
          update:(dt,api)=>{
            api.forEach(componentNames,(entity,...values)=>{
              const sceneRef=api.hasComponent(entity,'SceneObjectRef')?api.getComponent(entity,'SceneObjectRef'):null;
              const object=(sceneObjects||[]).find(item=>sceneRef&&String(item.id)===String(sceneRef.sceneObjectId))||{id:'ecs-'+entity,name:'ECS Entity '+entity};
              const stateKey=systemId+':'+entity;
              const c=makeContext(object,dt);
              c.env=runtime.ecsStates.get(stateKey)||Object.create(null);
              c.env.entity=entity;c.env.dt=dt;
              componentNames.forEach((component,index)=>{c.env[ecsBindingName(component)]=values[index];});
              c.funcs=Object.create(null);
              for(const fn of asts[filename]?.body||[])if(fn.type==='FunctionDef')c.funcs[fn.name]=fn;
              c.steps=0;
              try{execBlock(c,node.body||[],c.env);}
              catch(signal){if(!(signal&&signal.kind===RETURN))throw signal;}
              runtime.ecsStates.set(stateKey,c.env);
              if(c.output.length)setOutput?.(c.output.join('\\n'),'normal');
            });
          }
        });
        runtime.ecsSystemIds.push(registered);
      }
    }catch(error){
      for(const id of runtime.ecsSystemIds||[])try{ecs.unregisterSystem(id);}catch(_){}
      runtime.ecsSystemIds=[];
      ecs.clearSceneObjects?.();
      for(const type of [...(runtime.ecsComponentTypes||[])].reverse())try{ecs.unregisterComponent?.(type);}catch(_){}
      runtime.ecsComponentTypes=[];
      throw error;
    }
  }

  async function startGame() {
    if(runtime?.running)return;
    if(projectFiles[activeProjectFile]?.type==='ps' && typeof codeEditor!=='undefined') projectFiles[activeProjectFile].content=codeEditor.value;
    if(typeof persistProject==='function')persistProject();
    const scripts={};for(const [name,file] of Object.entries(projectFiles||{}))if(file.type==='ps')scripts[name]=file.content;
    if(!Object.keys(scripts).length){setOutput?.('No .ps scripts found in this project.','error');return;}
    const attached=(sceneObjects||[]).filter(o=>o.script);
    if(!attached.length){setOutput?.('Inspector で Game Object に ps script を割り当ててください。','error');return;}
    try {
      const hasECS3D=(sceneObjects||[]).some(object=>!!object.model||object.collider===true||object.shaderFragment!==undefined||object.toonMaterialSettings!==undefined||object.modelMaterialOverrides!==undefined||object.postProcessing!==undefined||object.particleEmitter!==undefined||Array.isArray(object.ecsComponents)&&object.ecsComponents.some(entry=>['Camera','Light','Renderable','Animation','WorldPartition','StreamingInterest','Environment','Fog','Water','PostFX','ParticleEmitter','Trail','ToonMaterial','MaterialOverrides','ShaderMaterial','MeshCollider'].includes(entry?.type)&&entry.data?.enabled!==false));
      const needs3D=hasECS3D||Object.values(scripts).some(source=>/\b(draw_cube|draw_box|draw_sphere|draw_plane|draw_cylinder|draw_cone|draw_capsule|draw_grid|set_camera|set_camera_follow|set_material|set_toon_material|set_background|set_fog|set_light|load_model|physics_body|character_controller|move_character|character_animation|camera_shake|draw_trail|set_god_rays)\s*\(/.test(source));
      if(needs3D&&window.PStudio3DReady){
        const ready=await Promise.race([window.PStudio3DReady,new Promise(resolve=>setTimeout(()=>resolve(false),6000))]);
        if(!ready)throw new Error('3D renderer could not initialize. Check the connection to Three.js / GLTFLoader.');
      }
      const res=await fetch('/game/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scripts})});const data=await res.json();if(!data.success)throw new Error(data.error||'Script validation failed');
      keys.clear();justPressed.clear();resetVirtualControls();touchActive=false;activePointerId=null;window.PStudioECSInput?.reset?.();
      window.PStudioPhysics?.clear?.();
      window.PStudioECS?.clearSceneObjects?.();
      window.PStudioECS?.syncSceneObjects?.(sceneObjects || []);
      window.syncEcsSceneMaterials?.();
      runtime={running:true,asts:data.scripts,states:new Map(),initialized:new Set(),started:new Set(),contexts:new Map(),landSequences:new Map(),nextLandSequence:0,timeScale:1,requires3D:needs3D,ecsSystemIds:[],ecsComponentTypes:[],ecsStates:new Map()};collisionPairs=new Set();collision3DPairs=new Set();window.PStudioECSCollision?.clear?.();window.PStudioECSAudio?.clear?.();lastTime=0;
      for(const o of sceneObjects||[])runtime.states.set(o.id,Object.create(null));
      registerEcsRuntime(data.scripts);
      window.PStudioGameplay?.initializeECS?.(sceneObjects || []);
      window.PStudioECSInspector?.refresh?.();
      if(typeof switchWorkspaceView==='function')switchWorkspaceView('game');
      $('game-status').textContent='STARTING · PStudio Runtime 3.0.0';
      setTouchControlsEnabled(needs3D);
      $('engine-play')?.setAttribute('disabled','disabled');$('engine-stop')?.removeAttribute('disabled');
      raf=requestFrame(tick);
    } catch(err) {cleanupEcsRuntime();window.PStudioECS?.clearSceneObjects?.();window.PStudioECSInspector?.refresh?.();setOutput?.(`Game start failed: ${err.message}`,'error');}
  }
  function stopGame() {
    if(raf)cancelFrame(raf);raf=0;if(runtime)runtime.running=false;cleanupEcsRuntime();runtime=null;stopAllOwnerAudio();window.PStudioECSAudio?.clear?.();collisionPairs.clear();collision3DPairs.clear();window.PStudioECSCollision?.clear?.();keys.clear();touchActive=false;activePointerId=null;resetVirtualControls();setTouchControlsEnabled(false);
    $('engine-play')?.removeAttribute('disabled');$('engine-stop')?.setAttribute('disabled','disabled');
    window.PStudioECSStreaming?.clear?.();
    window.PStudioECSVisualFX?.clear?.();
    window.PStudioECSUI?.clear?.();
    if(typeof window.PStudio3D?.clear==='function')window.PStudio3D.clear();
    window.PStudioPhysics?.clear?.();
    window.PStudioECS?.clearSceneObjects?.();
    window.PStudioECSInspector?.refresh?.();
    justPressed.clear();window.PStudioECSInput?.reset?.();
    if(typeof renderGamePreview==='function')renderGamePreview();
    setViewMode(renderMode);
    const status=$('game-status');if(status)status.textContent='STOPPED · Scene preview · 960 × 540 · VIEW '+(renderMode==='3d'?'3D':'2D');
  }
  function modelProgressLabel(stage){
    const labels={
      'worker-read':'モデルデータを読み込み中','worker-parse-start':'GLBを解析中','worker-serialize-complete':'解析結果を転送中',
      'worker-glb-parse':'GLBを解析中','worker-glb-parsed':'GLB解析完了','scene-decode-start':'glTFシーンの解析を開始中','main-thread-gltf-json-start':'glTF JSONを読み込み中',
      'main-thread-parser-fallback':'互換読み込みへ切替中','main-thread-fetch':'モデルデータを読み込み中',
      'scene-hydrate-nodes':'3Dシーンを構築中','scene-hydrate-geometry':'ジオメトリを構築中',
      'instance-clone-and-materials':'モデル階層とマテリアルを準備中',
      'scene-decoded':'3Dシーン構築完了','gpu-textures':'GPUテクスチャを準備中','shader-precompile':'シェーダーを準備中',
      'prepared':'モデル表示準備完了','gpu-preparation-fallback':'GPU準備の通常描画へ切替中','ready':'モデルデータ読込完了','instance-build':'3Dインスタンスを構築中'
    };
    return labels[stage]||String(stage||'モデルを読み込み中');
  }
  window.addEventListener('pstudio-model-load-progress',event=>{
    if(runtime?.running)return;
    const detail=event.detail||{},status=$('game-status');
    if(!status||!detail.name)return;
    const label=modelProgressLabel(detail.stage);
    const loaded=Number(detail.loaded),total=Number(detail.total);
    const hasCounts=Number.isFinite(loaded)&&Number.isFinite(total)&&total>0;
    const rawProgress=Number(detail.progress);
    const progress=Number.isFinite(rawProgress)?rawProgress:(hasCounts?loaded/total:0);
    const count=hasCounts
      ?' · '+Math.min(loaded,total)+'/'+total+' ('+Math.round(Math.max(0,Math.min(1,progress))*100)+'%)':'';
    status.textContent='MODEL · '+String(detail.name)+' · '+label+count;
    status.title=status.textContent;
  });
  window.addEventListener('pstudio-asset-import-progress',event=>{
    if(runtime?.running)return;
    const detail=event.detail||{},status=$('game-status');
    if(!status||!detail.name)return;
    const labels={
      'worker-inspection':'GLB構造を検査中',
      'validated':'GLBの構造検査完了',
      'main-thread-fallback':'互換検査へ切替中',
      'storage':'IndexedDBへ保存中',
      'stored':'IndexedDBへの保存完了'
    };
    const info=detail.info||{};
    const nodes=Number(info.nodeCount),meshes=Number(info.meshCount);
    const summary=Number.isFinite(nodes)&&nodes>0
      ?' · '+nodes.toLocaleString()+' nodes'+(Number.isFinite(meshes)&&meshes>0?' / '+meshes.toLocaleString()+' meshes':''):'';
    status.textContent='ASSET · '+String(detail.name)+' · '+(labels[detail.stage]||String(detail.stage||'アセットを処理中'))+summary;
    status.title=status.textContent;
  });
  window.addEventListener('pstudio-model-visibility',event=>{
    const detail=event.detail||{},name=String(detail.name||'モデル');
    const visibleMeshes=Math.max(0,Number(detail.visibleMeshes)||0);
    const activeChunks=Number(detail.activeStreamChunks)||0,totalChunks=Number(detail.streamChunkCount)||0;
    if(visibleMeshes>0&&detail.rootVisible&&detail.withinDrawDistance){
      setOutput?.('3Dモデル「'+name+'」をシーンに配置しました。描画メッシュ: '+visibleMeshes+'/'+(Number(detail.meshCount)||visibleMeshes)+
        (totalChunks?' / ストリーミング範囲: '+activeChunks+'/'+totalChunks+' チャンク':''),'success');
      return;
    }
    const reason=detail.preparing?'GPU準備がまだ完了していません。':
      !detail.withinDrawDistance?'モデルの境界球が描画距離外と判定されています。':
      !detail.boundsInCameraFrustum?'モデルの範囲が現在のカメラ視野に入っていません。Frameで選択モデルへ移動できます。':
      'メッシュまたはストリーミングチャンクが非表示になっています。';
    setOutput?.('3Dモデル「'+name+'」の読み込みは完了しましたが、現在の描画対象を確認できません。\n'+reason+
      '\nroot visible: '+String(!!detail.rootVisible)+' / meshes: '+visibleMeshes+'/'+(Number(detail.meshCount)||0)+
      ' / chunks: '+activeChunks+'/'+totalChunks,'error');
  });
  window.addEventListener('pstudio-model-error',event=>{
    const detail=event.detail||{},name=String(detail.name||'モデル');
    const stack=String(detail.stack||'').split('\n').slice(0,10).join('\n');
    const message='3Dモデル「'+name+'」の処理に失敗しました。\n段階: '+String(detail.stage||'unknown')+'\n原因: '+String(detail.error||'不明なエラー')+
      (stack?'\n詳細スタック:\n'+stack:'')+
      (detail.retryable===false?'\nこの端末のメモリ安全基準により読み込みを停止しました。':'\n3D表示を再選択するか Refresh で再試行できます。');
    const status=$('game-status');if(status&&!runtime?.running)status.textContent='MODEL ERROR · '+name;
    setOutput?.(message,'error');
  });
  function refreshSceneView(){
    if(runtime?.running){renderFrame();return true;}
    if(renderMode==='3d'){setViewMode('3d');return true;}
    if(typeof renderGamePreview==='function')renderGamePreview();
    return true;
  }
  window.PStudioAudioService=Object.freeze({
    play:playOwnerSound,
    stop:stopOwnerSound,
    setVolume:setOwnerSoundVolume,
    hasSound:(ownerId,name)=>!!ownerAudio.get(String(ownerId))?.has(String(name)),
    hasAsset:name=>{
      const assets=typeof projectAssets!=='undefined'&&Array.isArray(projectAssets)?projectAssets:[];
      return assets.some(item=>item?.kind==='audio'&&String(item.name)===String(name)&&typeof (item.data||item.url)==='string');
    },
    getStats:()=>({owners:ownerAudio.size,instances:[...ownerAudio.values()].reduce((count,sounds)=>count+sounds.size,0)})
  });
  window.PStudioEngine={start:startGame,stop:stopGame,isRunning:()=>!!runtime?.running,setViewMode,refreshSceneView,version:'3.1.0'};
  window.setPStudioViewMode=setViewMode;
  window.startPStudioGame=startGame;window.stopPStudioGame=stopGame;
  updateViewModeButtons();
})();

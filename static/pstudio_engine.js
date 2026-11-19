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
  let runtime = null;
  let raf = 0;
  let lastTime = 0;
  let touchActive = false;
  let activePointerId = null;
  let pointerPosition = { x: 0, y: 0 };
  let collisionPairs = new Set();
  let collision3DPairs = new Set();

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
        virtualKeys.add(' ');
        justPressed.add(' ');
        try{jumpButton.setPointerCapture(e.pointerId)}catch(_){}
        e.preventDefault();
      });
      const releaseJump=()=>virtualKeys.delete(' ');
      jumpButton.addEventListener('pointerup',releaseJump);
      jumpButton.addEventListener('pointercancel',releaseJump);
      jumpButton.addEventListener('lostpointercapture',releaseJump);
    }
  })();
  window.addEventListener('blur', () => { keys.clear(); justPressed.clear(); resetVirtualControls(); });
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
      case 'is_key_down': if (a.length===1) {const k=normalizeKey(a[0]);return keys.has(k)||virtualKeys.has(k);} break;
      case 'was_key_pressed': if (a.length===1) return justPressed.has(normalizeKey(a[0])); break;
      case 'get_axis': if (a.length===1) {
        const axis=String(a[0]).toLowerCase();
        if(axis==='horizontal'||axis==='x')return clampAxis((keys.has('d')||keys.has('arrowright')?1:0)-(keys.has('a')||keys.has('arrowleft')?1:0)+virtualAxis.x);
        if(axis==='vertical'||axis==='z')return clampAxis((keys.has('s')||keys.has('arrowdown')?1:0)-(keys.has('w')||keys.has('arrowup')?1:0)+virtualAxis.z);
        break;
      }
      case 'is_touched': if (!a.length) return touchActive; break;
      case 'get_touch_x': if (!a.length) return pointerPosition.x; break;
      case 'get_touch_y': if (!a.length) return pointerPosition.y; break;
      case 'get_delta_time': if (!a.length) return c.dt; break;
      case 'get_width': if (!a.length) return Number(o.w)||0; break;
      case 'get_height': if (!a.length) return Number(o.h)||0; break;
      case 'draw_rect': if (a.length===4) { c.draw.push({type:'rect',x:finite(a[0]),y:finite(a[1]),w:finite(a[2]),h:finite(a[3]),color:o.color||'#d1d5db'}); return null; } break;
      case 'draw_circle': if (a.length===3) { c.draw.push({type:'circle',x:finite(a[0]),y:finite(a[1]),r:Math.max(0,finite(a[2])),color:o.color||'#d1d5db'}); return null; } break;
      case 'draw_sprite': if (a.length===3) { c.draw.push({type:'sprite',name:String(a[0]),x:finite(a[1]),y:finite(a[2])}); return null; } break;
      case 'draw_cube': if (a.length===4) { c.draw.push({type:'cube',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),size:Math.max(0.001,finite(a[3])),color:o.color||'#d1d5db',rotationX:(Number(o.rotationX)||0)*Math.PI/180,rotationY:(Number(o.rotationY)||0)*Math.PI/180,rotationZ:(Number(o.rotationZ)||0)*Math.PI/180}); return null; } break;
      case 'draw_sphere': if (a.length===4) { c.draw.push({type:'sphere',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),radius:Math.max(0.001,finite(a[3])),color:o.color||'#a1a1aa'}); return null; } break;
      case 'draw_box': if (a.length===6) { c.draw.push({type:'box',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),width:Math.max(0.001,finite(a[3])),height:Math.max(0.001,finite(a[4])),depth:Math.max(0.001,finite(a[5])),color:o.color||'#d1d5db',rotationX:(Number(o.rotationX)||0)*Math.PI/180,rotationY:(Number(o.rotationY)||0)*Math.PI/180,rotationZ:(Number(o.rotationZ)||0)*Math.PI/180}); return null; } break;
      case 'draw_plane': if (a.length===5) { c.draw.push({type:'plane',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),width:Math.max(0.001,finite(a[3])),depth:Math.max(0.001,finite(a[4])),color:o.color||'#64748b'}); return null; } break;
      case 'draw_cylinder': if (a.length===5) { c.draw.push({type:'cylinder',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),radius:Math.max(0.001,finite(a[3])),height:Math.max(0.001,finite(a[4])),color:o.color||'#d1d5db'}); return null; } break;
      case 'draw_cone': if (a.length===5) { c.draw.push({type:'cone',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),radius:Math.max(0.001,finite(a[3])),height:Math.max(0.001,finite(a[4])),color:o.color||'#d1d5db'}); return null; } break;
      case 'draw_capsule': if (a.length===5) { c.draw.push({type:'capsule',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),radius:Math.max(0.001,finite(a[3])),height:Math.max(finite(a[4]),Math.max(0.001,finite(a[3]))*2),color:o.color||'#93c5fd'}); return null; } break;
      case 'set_background': if (a.length===1) { c.draw.push({type:'environment',background:String(a[0])}); return null; } break;
      case 'set_fog': if (a.length===3) { c.draw.push({type:'environment',fogColor:String(a[0]),fogNear:Math.max(0,finite(a[1])),fogFar:Math.max(0.001,finite(a[2]))}); return null; } break;
      case 'set_light': if (a.length===4) { c.draw.push({type:'environment',lightX:finite(a[0]),lightY:finite(a[1]),lightZ:finite(a[2]),lightIntensity:Math.max(0,finite(a[3]))}); return null; } break;
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
      case 'move_character': if (a.length===2) { physics?.moveCharacter(o.id,finite(a[0]),finite(a[1])); return null; } break;
      case 'jump': if (a.length===1) return physics?.jump(o.id,finite(a[0])) ?? false; break;
      case 'is_grounded': if (!a.length) return physics?.isGrounded(o.id) ?? false; break;
      case 'load_model': if (a.length===5) { c.draw.push({type:'model',name:String(a[0]),x:finite(a[1]),y:finite(a[2]),z:finite(a[3]),scale:Math.max(0.001,finite(a[4])),rotationX:(Number(o.rotationX)||0)*Math.PI/180,rotationY:(Number(o.rotationY)||0)*Math.PI/180,rotationZ:(Number(o.rotationZ)||0)*Math.PI/180,dt:c.dt}); return null; } break;
      case 'play_animation': if (a.length===1) { c.draw.push({type:'animation',clipName:String(a[0]),loop:true}); return null; } break;
      case 'play_animation_once': if (a.length===1) { c.draw.push({type:'animation',clipName:String(a[0]),loop:false}); return null; } break;
      case 'stop_animation': if (!a.length) { c.draw.push({type:'animation',stop:true}); return null; } break;
      case 'set_animation_speed': if (a.length===1) { c.draw.push({type:'animation',speed:finite(a[0])}); return null; } break;
      case 'draw_grid': if (a.length===2) { c.draw.push({type:'grid',size:Math.max(1,finite(a[0])),divisions:Math.max(1,Math.min(200,Math.floor(finite(a[1]))))}); return null; } break;
      case 'set_camera': if (a.length===6) { c.draw.push({type:'camera',x:finite(a[0]),y:finite(a[1]),z:finite(a[2]),targetX:finite(a[3]),targetY:finite(a[4]),targetZ:finite(a[5])}); return null; } break;
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
    const objs=(sceneObjects||[]).filter(o=>o.collider);
    const now=new Set();
    for(let i=0;i<objs.length;i++)for(let j=i+1;j<objs.length;j++){const a=objs[i],b=objs[j];if(collides(a,b)){const key=[a.id,b.id].sort().join('|');now.add(key);if(!collisionPairs.has(key)){dispatchCollision(a,b);dispatchCollision(b,a);}}}
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
      if (!owner) continue;
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
      if (button) { button.classList.toggle('active', renderMode === mode); button.setAttribute('aria-pressed', renderMode === mode ? 'true' : 'false'); }
    }
  }
  function buildScenePreview3D() {
    const commands = new Map();
    commands.set('__scene__',[{type:'grid',size:12,divisions:12},{type:'camera',x:6,y:5,z:8,targetX:0,targetY:0,targetZ:0}]);
    for (const o of sceneObjects || []) {
      const x = ((Number(o.x)||0) + (Number(o.w)||64)/2 - 480) / 100;
      const y = (270 - ((Number(o.y)||0) + (Number(o.h)||64)/2)) / 100;
      const z = (Number(o.z)||0) / 100;
      const w = Math.max(0.05,(Number(o.w)||64)/100);
      const h = Math.max(0.05,(Number(o.h)||64)/100);
      const color = o.color || '#d1d5db';
      const draw = o.shape === 'circle'
        ? {type:'sphere',x,y,z,radius:Math.max(w,h)/2,color}
        : {type:'box',x,y,z,width:w,height:h,depth:Math.max(0.12,Math.min(w,h)*0.35),color,rotationX:(Number(o.rotationX)||0)*Math.PI/180,rotationY:(Number(o.rotationY)||0)*Math.PI/180,rotationZ:(Number(o.rotationZ)||0)*Math.PI/180};
      commands.set(o.id,[draw]);
    }
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
      try{window.PStudio3D.render(buildScenePreview3D());}catch(err){setOutput?.('3D view error: '+err.message,'error');}
    } else { if(c3)c3.style.display='none'; if(c2)c2.style.display='block'; if(typeof renderGamePreview==='function')renderGamePreview(); }
  }
  function renderFrame() {
    const commands=new Map(); for(const [id,draws] of runtime?.contexts||[])commands.set(id,Array.isArray(draws)?draws:(draws?.draw||[]));
    const draws=[...commands.values()].flat();
    const has3D=draws.some(d=>['cube','box','sphere','plane','cylinder','cone','capsule','grid','camera','environment'].includes(d.type));
    const use3D=renderMode==='3d'||(renderMode==='auto'&&has3D);
    const c2=$('game-canvas'),c3=$('game-3d-canvas');
    if(use3D){if(c2)c2.style.display='none';if(c3)c3.style.display='block';if(!window.PStudio3D)throw new PsRuntimeError('3D renderer is unavailable. Check the Three.js connection.');window.PStudio3D.render(commands);}
    else{if(c3)c3.style.display='none';if(c2)c2.style.display='block';drawScene(commands);}
    const status=$('game-status'); if(status&&runtime?.running){const m=status.textContent.match(/([0-9.]+) FPS/);status.textContent='RUNNING · '+(m?m[1]:'0')+' FPS · '+(sceneObjects||[]).length+' objects · VIEW '+(use3D?'3D':'2D')+' · '+draws.length+' draw calls';}
  }
  function tick(time) {
    if(!runtime?.running)return;
    const raw=lastTime?Math.max(0,(time-lastTime)/1000):0;lastTime=time;const dt=Math.min(raw,0.1);
    try {
      const commands=new Map();
      window.PStudioPhysics?.beginFrame?.();
      for(const o of sceneObjects||[]){const script=astForScript(o.script);if(!script)continue;const c=setupContext(o,dt);c.steps=0;
        if(!runtime.initialized.has(o.id)){runtime.initialized.add(o.id);const topLevel=(script.body||[]).filter(n=>n.type!=='FunctionDef');if(topLevel.length)execBlock(c,topLevel,c.env);}
        if(!runtime.started.has(o.id)){runtime.started.add(o.id);if(c.funcs.start)callFunction(c,'start',[]);}
        c.dt=dt;if(c.funcs.update)callFunction(c,'update',[dt]);runtime.states.set(o.id,c.env);commands.set(o.id,c.draw);
        if(c.output.length)setOutput?.(c.output.join('\n'),'normal');
      }
      const transforms=window.PStudioPhysics?.step?.(dt,commands)||new Map();
      for(const [id,transform] of transforms){
        const draws=commands.get(id)||[];
        for(const draw of draws){
          if(['cube','box','sphere','plane','cylinder','cone','capsule','model'].includes(draw.type)){
            draw.x=finite(draw.x)+transform.dx;
            draw.y=finite(draw.y)+transform.dy;
            draw.z=finite(draw.z)+transform.dz;
          }
        }
      }
      runtime.contexts=commands;updateCollisions();update3DCollisions(commands);renderFrame();
      justPressed.clear();
      // renderFrame() owns the detailed status, including VIEW mode and draw-call count.
      raf=requestAnimationFrame(tick);
    } catch(err) { stopGame();setOutput?.(`Game runtime error: ${err.message}`,'error'); }
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
      const needs3D=Object.values(scripts).some(source=>/\b(draw_cube|draw_box|draw_sphere|draw_plane|draw_cylinder|draw_cone|draw_capsule|draw_grid|set_camera|set_background|set_fog|set_light|load_model)\s*\(/.test(source));
      if(needs3D&&window.PStudio3DReady){
        const ready=await Promise.race([window.PStudio3DReady,new Promise(resolve=>setTimeout(()=>resolve(false),6000))]);
        if(!ready)throw new Error('3D renderer could not initialize. Check the connection to Three.js / GLTFLoader.');
      }
      const res=await fetch('/game/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scripts})});const data=await res.json();if(!data.success)throw new Error(data.error||'Script validation failed');
      window.PStudioPhysics?.clear?.();
      runtime={running:true,asts:data.scripts,states:new Map(),initialized:new Set(),started:new Set(),contexts:new Map()};collisionPairs=new Set();collision3DPairs=new Set();lastTime=0;
      for(const o of sceneObjects||[])runtime.states.set(o.id,Object.create(null));
      if(typeof switchWorkspaceView==='function')switchWorkspaceView('game');
      $('game-status').textContent='STARTING · PStudio Runtime 3.0.0';
      setTouchControlsEnabled(needs3D);
      $('engine-play')?.setAttribute('disabled','disabled');$('engine-stop')?.removeAttribute('disabled');
      raf=requestAnimationFrame(tick);
    } catch(err) {setOutput?.(`Game start failed: ${err.message}`,'error');}
  }
  function stopGame() {
    if(raf)cancelAnimationFrame(raf);raf=0;if(runtime)runtime.running=false;runtime=null;collisionPairs.clear();collision3DPairs.clear();keys.clear();touchActive=false;activePointerId=null;resetVirtualControls();setTouchControlsEnabled(false);
    $('engine-play')?.removeAttribute('disabled');$('engine-stop')?.setAttribute('disabled','disabled');
    if(typeof window.PStudio3D?.clear==='function')window.PStudio3D.clear();
    window.PStudioPhysics?.clear?.();
    justPressed.clear();
    if(typeof renderGamePreview==='function')renderGamePreview();
    setViewMode(renderMode);
    const status=$('game-status');if(status)status.textContent='STOPPED · Scene preview · 960 × 540 · VIEW '+(renderMode==='3d'?'3D':'2D');
  }
  window.PStudioEngine={start:startGame,stop:stopGame,isRunning:()=>!!runtime?.running,setViewMode,version:'3.0.0'};
  window.setPStudioViewMode=setViewMode;
  window.startPStudioGame=startGame;window.stopPStudioGame=stopGame;
  updateViewModeButtons();
})();

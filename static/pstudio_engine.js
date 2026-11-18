/* PStudio Game Runtime 1.2.0
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
  let runtime = null;
  let raf = 0;
  let lastTime = 0;
  let touchActive = false;
  let activePointerId = null;
  let pointerPosition = { x: 0, y: 0 };
  let collisionPairs = new Set();

  class PsRuntimeError extends Error {}
  const truthy = (v) => Array.isArray(v) ? v.length > 0 : !!v;
  const BREAK = Symbol('break');
  const CONTINUE = Symbol('continue');
  const RETURN = Symbol('return');

  function pointFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX-r.left)*canvas.width/r.width, y: (e.clientY-r.top)*canvas.height/r.height };
  }
  window.addEventListener('keydown', e => { keys.add(e.key.toLowerCase()); const target=e.target; const editing=target && (target.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(target.tagName)); if(runtime?.running && !editing && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault(); });
  window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());
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
    switch (name) {
      case 'len': if (a.length!==1) break; return a[0]?.length ?? 0;
      case 'range': if (a.length===1) return Array.from({length:Math.max(0,Math.min(100000,Number(a[0])|0))},(_,i)=>i); if (a.length===2||a.length===3) { const step=a.length===3?Number(a[2]):1; if (!step) return []; const out=[]; for(let i=Number(a[0]); step>0?i<Number(a[1]):i>Number(a[1]); i+=step){out.push(i);if(out.length>100000)throw new PsRuntimeError('range() の要素数が上限を超えました。')} return out; } break;
      case 'get_x': if (!a.length) return Number(o.x)||0; break;
      case 'get_y': if (!a.length) return Number(o.y)||0; break;
      case 'get_z': if (!a.length) return Number(o.z)||0; break;
      case 'set_x': if (a.length===1) { o.x=finite(a[0]); return o.x; } break;
      case 'set_y': if (a.length===1) { o.y=finite(a[0]); return o.y; } break;
      case 'set_z': if (a.length===1) { o.z=finite(a[0]); return o.z; } break;
      case 'rotate_x': if (a.length===1) { o.rotationX=(Number(o.rotationX)||0)+finite(a[0]); return o.rotationX; } break;
      case 'rotate_y': if (a.length===1) { o.rotationY=(Number(o.rotationY)||0)+finite(a[0]); return o.rotationY; } break;
      case 'rotate_z': if (a.length===1) { o.rotationZ=(Number(o.rotationZ)||0)+finite(a[0]); return o.rotationZ; } break;
      case 'is_key_down': if (a.length===1) { const k=String(a[0]).toLowerCase(); const aliases={left:'arrowleft',right:'arrowright',up:'arrowup',down:'arrowdown',space:' '}; return keys.has(aliases[k]||k); } break;
      case 'is_touched': if (!a.length) return touchActive; break;
      case 'get_touch_x': if (!a.length) return pointerPosition.x; break;
      case 'get_touch_y': if (!a.length) return pointerPosition.y; break;
      case 'get_delta_time': if (!a.length) return c.dt; break;
      case 'get_width': if (!a.length) return Number(o.w)||0; break;
      case 'get_height': if (!a.length) return Number(o.h)||0; break;
      case 'draw_rect': if (a.length===4) { c.draw.push({type:'rect',x:finite(a[0]),y:finite(a[1]),w:finite(a[2]),h:finite(a[3]),color:o.color||'#d1d5db'}); return null; } break;
      case 'draw_circle': if (a.length===3) { c.draw.push({type:'circle',x:finite(a[0]),y:finite(a[1]),r:Math.max(0,finite(a[2])),color:o.color||'#d1d5db'}); return null; } break;
      case 'draw_sprite': if (a.length===3) { c.draw.push({type:'sprite',name:String(a[0]),x:finite(a[1]),y:finite(a[2])}); return null; } break;
      case 'ps': c.output.push(String(a[0] ?? '')); return null;
    }
    throw new PsRuntimeError(`未対応の関数、または引数の数が不正です: ${name}()`);
  }
  function finite(v) { const n=Number(v); if(!Number.isFinite(n)) throw new PsRuntimeError('座標・サイズには有限の数値を指定してください。'); return n; }
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
    const selected=(sceneObjects||[]).find(o=>o.id===selectedObjectId);if(selected){ctx.strokeStyle='#f4f4f5';ctx.lineWidth=2;ctx.setLineDash([6,4]);ctx.strokeRect(selected.x-4,selected.y-4,selected.w+8,selected.h+8);ctx.setLineDash([])}
  }
  function collides(a,b) {
    if(a.shape==='circle'&&b.shape==='circle'){const ax=a.x+a.w/2,ay=a.y+a.h/2,bx=b.x+b.w/2,by=b.y+b.h/2;const r=(Math.max(a.w,a.h)+Math.max(b.w,b.h))/2;return (ax-bx)**2+(ay-by)**2<=r*r;}
    if(a.shape==='circle'||b.shape==='circle'){const c=a.shape==='circle'?a:b,r=a.shape==='circle'?b:a;const cx=c.x+c.w/2,cy=c.y+c.h/2,nx=Math.max(r.x,Math.min(cx,r.x+r.w)),ny=Math.max(r.y,Math.min(cy,r.y+r.h));return (cx-nx)**2+(cy-ny)**2<=(Math.max(c.w,c.h)/2)**2;}
    return a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
  }
  function dispatchCollision(object, other) {
    const state=runtime.states.get(object.id);if(!state)return;
    const c=setupContext(object,0);c.steps=0;
    if(c.funcs.on_collision){callFunction(c,'on_collision',[other.name||other.id]);runtime.states.set(object.id,c.env);}
  }
  function updateCollisions() {
    const objs=(sceneObjects||[]).filter(o=>o.collider);
    const now=new Set();
    for(let i=0;i<objs.length;i++)for(let j=i+1;j<objs.length;j++){const a=objs[i],b=objs[j];if(collides(a,b)){const key=[a.id,b.id].sort().join('|');now.add(key);if(!collisionPairs.has(key)){dispatchCollision(a,b);dispatchCollision(b,a);}}}
    collisionPairs=now;
  }
  function renderFrame() {
    const commands=new Map();for(const [id,c] of runtime?.contexts||[])commands.set(id,c.draw||[]);drawScene(commands);
  }
  function tick(time) {
    if(!runtime?.running)return;
    const raw=lastTime?Math.max(0,(time-lastTime)/1000):0;lastTime=time;const dt=Math.min(raw,0.1);
    try {
      const commands=new Map();
      for(const o of sceneObjects||[]){const script=astForScript(o.script);if(!script)continue;const c=setupContext(o,dt);c.steps=0;
        if(!runtime.initialized.has(o.id)){runtime.initialized.add(o.id);const topLevel=(script.body||[]).filter(n=>n.type!=='FunctionDef');if(topLevel.length)execBlock(c,topLevel,c.env);}
        if(!runtime.started.has(o.id)){runtime.started.add(o.id);if(c.funcs.start)callFunction(c,'start',[]);}
        c.dt=dt;if(c.funcs.update)callFunction(c,'update',[dt]);runtime.states.set(o.id,c.env);commands.set(o.id,c.draw);
        if(c.output.length)setOutput?.(c.output.join('\n'),'normal');
      }
      runtime.contexts=commands;updateCollisions();renderFrame();
      const status=$('game-status');if(status)status.textContent=`RUNNING · ${(raw>0?1/raw:0).toFixed(0)} FPS · ${(sceneObjects||[]).length} objects`;
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
      const res=await fetch('/game/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scripts})});const data=await res.json();if(!data.success)throw new Error(data.error||'Script validation failed');
      runtime={running:true,asts:data.scripts,states:new Map(),initialized:new Set(),started:new Set(),contexts:new Map()};collisionPairs=new Set();lastTime=0;
      for(const o of sceneObjects||[])runtime.states.set(o.id,Object.create(null));
      if(typeof switchWorkspaceView==='function')switchWorkspaceView('game');
      $('game-status').textContent='STARTING · PStudio Runtime 1.0.0';
      $('engine-play')?.setAttribute('disabled','disabled');$('engine-stop')?.removeAttribute('disabled');
      raf=requestAnimationFrame(tick);
    } catch(err) {setOutput?.(`Game start failed: ${err.message}`,'error');}
  }
  function stopGame() {
    if(raf)cancelAnimationFrame(raf);raf=0;if(runtime)runtime.running=false;runtime=null;collisionPairs.clear();keys.clear();touchActive=false;activePointerId=null;
    $('engine-play')?.removeAttribute('disabled');$('engine-stop')?.setAttribute('disabled','disabled');
    if(typeof renderGamePreview==='function')renderGamePreview();
    const status=$('game-status');if(status)status.textContent='STOPPED · Scene preview · 960 × 540';
  }
  window.PStudioEngine={start:startGame,stop:stopGame,isRunning:()=>!!runtime?.running,version:'1.2.0'};
  window.startPStudioGame=startGame;window.stopPStudioGame=stopGame;
})();

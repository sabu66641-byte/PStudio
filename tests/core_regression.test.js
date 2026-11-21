const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');const root=path.join(__dirname,'..');const load=(f,c)=>vm.runInNewContext(fs.readFileSync(path.join(root,f),'utf8'),c,{filename:f});
test('core managers load together and bridge lifecycle events',()=>{const c={console,Date,Map,Set,Promise,Error,TypeError,AbortController,Math,Number,String,Object,Array,JSON,performance:{now:()=>1},setTimeout,clearTimeout};c.globalThis=c;c.window=c;c.dispatchEvent=()=>true;for(const f of ['static/pstudio_events.js','static/pstudio_platform.js','static/pstudio_jobs.js','static/pstudio_resources.js','static/pstudio_modules.js','static/pstudio_ecs.js'])load(f,c);for(const k of ['PStudioEvents','PStudioPlatform','PStudioJobs','PStudioResources','PStudioModules','PStudioECS'])assert.ok(c[k],k);const seen=[];for(const name of ['ecs.entity-created','module.registered','resource.register'])c.PStudioEvents.on(name,()=>seen.push(name));c.PStudioECS.createEntity();c.PStudioModules.register({id:'regression.module'});c.PStudioResources.register('regression','asset',{ok:true},{category:'cpu',sizeBytes:1});assert.deepEqual(seen,['ecs.entity-created','module.registered','resource.register']);});
test('legacy runtime files remain and platform scheduling is wired',()=>{for(const f of ['app.py','static/pstudio_engine.js','static/pstudio_physics.js','static/pstudio_gameplay.js','static/pstudio_3d_engine.js','templates/index.html'])assert.ok(fs.statSync(path.join(root,f)).size>0,f);const engine=fs.readFileSync(path.join(root,'static/pstudio_engine.js'),'utf8');assert.match(engine,/PStudioPlatform/);assert.match(engine,/requestFrame\(tick\)/);const html=fs.readFileSync(path.join(root,'templates/index.html'),'utf8');assert.match(html,/pstudio_events\.js/);assert.match(html,/pstudio_ecs\.js/);});
test('ps script globals, lifecycle and local System state use ECS Components',()=>{
  const engine=fs.readFileSync(path.join(root,'static/pstudio_engine.js'),'utf8');
  assert.match(engine,/env:\s*getScriptState\(object\.id\)/);
  assert.match(engine,/getScriptLifecycle\(o\.id\)/);
  assert.match(engine,/commitScriptState\(o\.id,c\.env\)/);
  assert.match(engine,/ScriptSystemState/);
  assert.match(engine,/LocomotionState/);
  assert.match(engine,/updateLocomotionSequence\(id\)/);
  assert.match(engine,/getLocomotionSequence\(id\)/);
});

test('Play runtime obtains rendering and collider configuration from ECS presentation Components',()=>{
  const engine=fs.readFileSync(path.join(root,'static/pstudio_engine.js'),'utf8');
  const bridge=fs.readFileSync(path.join(root,'static/pstudio_ecs_scene.js'),'utf8');
  assert.match(engine,/function getRuntimePresentation\(object\)/);
  assert.match(engine,/PStudioECSScene\?\.getRenderState\?\.\(object\)/);
  assert.match(engine,/PStudioECSScene\?\.syncSceneObjects\?\.\(sceneObjects \|\| \[\]\)/);
  assert.match(engine,/const presentation=getRuntimePresentation\(o\)/);
  assert.match(engine,/presentation\.spriteRenderer/);
  assert.match(engine,/presentation\.meshRenderer/);
  assert.match(engine,/presentation\.material/);
  assert.match(engine,/presentation\.postProcessing/);
  assert.match(engine,/presentation\.particleEmitter/);
  assert.match(engine,/\.map\(getCollisionObject\)/);
  assert.match(engine,/ownerPresentation\.meshCollider\.enabled/);
  for(const type of ['SpriteRenderer','MeshRenderer','MaterialSettings','PostProcessingSettings','ParticleEmitter','Collider2D','MeshCollider']){
    assert.ok(bridge.includes("register('"+type+"'"),type);
  }
});

test('2D draw path and collision enter tracking use ECS-owned presentation and contacts',()=>{
  const engine=fs.readFileSync(path.join(root,'static/pstudio_engine.js'),'utf8');
  const bridge=fs.readFileSync(path.join(root,'static/pstudio_ecs_scene.js'),'utf8');
  assert.match(engine,/const state=getRuntimePresentation\(o\),sprite=state\.spriteRenderer/);
  assert.match(engine,/sprite\.visible===false/);
  assert.match(engine,/sprite\.shape==='circle'/);
  assert.match(engine,/bridge\?\.syncCollisionContacts/);
  assert.match(engine,/syncRuntimeCommands\?\.\(commands\)/);
  assert.match(bridge,/function syncCollisionContacts\(ownerIds, pairs, dimension\)/);
  assert.match(bridge,/commitCollisionState\(id, dimension, \[\.\.\.peers\]\)/);
  assert.match(engine,/syncOwnerAudioState\(ownerId\)/);
  assert.match(engine,/PStudioECSScene\?\.syncAudioState\?\.\(String\(ownerId\),entries\)/);
});

test('ps input builtins read the world-scoped ECS InputState snapshot',()=>{
  const engine=fs.readFileSync(path.join(root,'static/pstudio_engine.js'),'utf8');
  const bridge=fs.readFileSync(path.join(root,'static/pstudio_ecs_scene.js'),'utf8');
  assert.match(engine,/syncInputState\?\.\(\{/);
  assert.match(engine,/function getInputSnapshot\(\)/);
  assert.match(engine,/getInputSnapshot\(\)\.pressedKeys\.includes/);
  assert.match(engine,/getInputSnapshot\(\)\.justPressedKeys\.includes/);
  assert.match(engine,/input\.axisX/);
  assert.match(engine,/input\.axisZ/);
  assert.match(engine,/getInputSnapshot\(\)\.touchActive/);
  assert.match(bridge,/function syncInputState\(snapshot\)/);
  assert.match(bridge,/function getInputState\(\)/);
});

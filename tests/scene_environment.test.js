const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const presets = require(path.join(root, 'static', 'pstudio_scene_environment.js'));
const renderer = fs.readFileSync(path.join(root, 'static', 'pstudio_3d_engine.js'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'static', 'pstudio_engine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

test('scene environment module defines four independent environment presets', () => {
  const items = presets.listPresets();
  assert.deepEqual(items.map(item => item.name), ['day', 'dusk', 'night', 'studio']);
  for (const { name } of items) {
    const profile = presets.getPreset(name);
    for (const field of [
      'skyTop', 'skyMid', 'horizon', 'ground', 'fogColor', 'fogNear', 'fogFar',
      'lightColor', 'lightIntensity', 'lightX', 'lightY', 'lightZ',
      'hemisphereSky', 'hemisphereGround', 'hemisphereIntensity', 'environmentIntensity'
    ]) assert.ok(Object.prototype.hasOwnProperty.call(profile, field), name + ': ' + field);
    assert.ok(profile.fogFar > profile.fogNear, name + ' fog range');
    assert.ok(profile.lightIntensity > 0, name + ' key light intensity');
    assert.ok(profile.hemisphereIntensity > 0, name + ' hemisphere intensity');
  }
  const mutableCopy=presets.getPreset('day');
  mutableCopy.skyTop='#FFFFFF';
  assert.notEqual(mutableCopy.skyTop,presets.getPreset('day').skyTop,'editing a returned profile must not mutate the internal preset');
});

test('scene environment preset normalization defaults invalid and missing names to daytime', () => {
  assert.equal(presets.normalizePreset(undefined), 'day');
  assert.equal(presets.normalizePreset(null), 'day');
  assert.equal(presets.normalizePreset('not-a-preset'), 'day');
  assert.equal(presets.normalizePreset('NIGHT'), 'night');
  assert.deepEqual(
    ['day', 'dusk', 'night', 'studio'].map(name => presets.normalizePreset(name)),
    ['day', 'dusk', 'night', 'studio']
  );
});

test('new scenes default to day and project persistence includes scene environment', () => {
  assert.match(html, /let sceneEnvironment=\{preset:'day'\}/);
  assert.match(html, /environment:sceneEnvironment/);
  assert.match(html, /function normalizeSceneEnvironment\(value\)/);
  assert.match(html, /\['day','dusk','night','studio'\]\.includes\(preset\)/);
});

test('old scene files without environment data remain compatible and load as daytime', () => {
  assert.match(html, /function serializeScene\(\)\{return JSON\.stringify\(\{width:960,height:540,objects:sceneObjects,environment:normalizeSceneEnvironment\(sceneEnvironment\)\}/);
  assert.match(html, /sceneEnvironment=normalizeSceneEnvironment\(data\.environment\)/);
  assert.match(html, /saved\.environment\|\|legacySceneEnvironment/);
  assert.match(html, /legacySceneEnvironment=JSON\.parse\(projectFiles\['main\.scene'\]\?\.content\|\|'null'\)\?\.environment/);
});

test('Inspector exposes all four scene presets with explicit accessible active states', () => {
  for (const name of ['day', 'dusk', 'night', 'studio']) {
    assert.match(html, new RegExp('id="scene-environment-' + name + '"'));
    assert.match(html, new RegExp("setSceneEnvironmentPreset\\('" + name + "'\\)"));
  }
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /button\.setAttribute\('aria-pressed',active\?'true':'false'\)/);
  assert.match(html, /\.environment-preset-btn\.active/);
});

test('renderer builds a procedural sky panorama and falls back safely if Canvas or PMREM is unavailable', () => {
  for (const token of [
    'function createProceduralSkyTexture(T,profile)',
    'new T.CanvasTexture(canvas)',
    'T.EquirectangularReflectionMapping',
    'context.createLinearGradient',
    'context.createRadialGradient',
    'function applySceneEnvironmentPreset(T,presetName,hasCustomEnvironment=false)',
    'Procedural atmosphere texture creation failed; a solid horizon fallback will be used',
    'Procedural sky PMREM generation failed; using the equirectangular texture directly',
    "else scene.background=new T.Color(profile.horizon||profile.skyMid||'#79BCE0')"
  ]) assert.ok(renderer.includes(token), token);
});

test('default environment configures fog, hemisphere light, sun light and existing CSM shadow path', () => {
  assert.match(renderer, /applySceneEnvironmentPreset\(T,environment\?\.preset\|\|'day'/);
  assert.match(renderer, /scene\.fog=new T\.Fog\(profile\.fogColor,profile\.fogNear,profile\.fogFar\)/);
  assert.match(renderer, /hemisphereLight\.color\.set\(profile\.hemisphereSky\)/);
  assert.match(renderer, /hemisphereLight\.groundColor\.set\(profile\.hemisphereGround\)/);
  assert.match(renderer, /light\.castShadow=true/);
  assert.match(renderer,/renderer\.shadowMap\.type=profile\.shadowMode==='vsm'&&effectsEnabled\?window\.THREE\.VSMShadowMap:window\.THREE\.PCFSoftShadowMap/);
  assert.doesNotMatch(renderer, /scene\.fog=null/);
});

test('script-authored environment commands and old ps environment APIs remain supported', () => {
  assert.match(renderer, /if\(environment\.environmentSky&&environment\.environmentGround\)/);
  assert.match(renderer, /if\(environment\.fogColor\)/);
  assert.match(renderer, /if\(Number\.isFinite\(environment\.lightIntensity\)\)/);
  assert.match(engine, /case 'set_environment': if\(a\.length===3\)/);
  assert.match(engine, /case 'set_background': if \(a\.length===1\)/);
  assert.match(engine, /case 'set_fog': if \(a\.length===3\)/);
  assert.match(engine, /case 'set_light': if \(a\.length===4\)/);
  assert.match(app, /"set_environment": 3/);
  assert.match(app, /"set_background": 1/);
  assert.match(app, /"set_fog": 3/);
  assert.match(app, /"set_light": 4/);
});

test('large editor workspace grid and selected environment are sent to the 3D renderer', () => {
  assert.match(engine, /commands\.set\('__scene__',\[\{type:'grid',size:500,divisions:100\},\{type:'environment',preset:sceneEnvironment\?\.preset\|\|'day'\}/);
  assert.match(html, /function setSceneEnvironmentPreset\(preset\)/);
  assert.match(html, /window\.PStudioEngine\?\.refreshSceneView\?\.\(\)/);
});

test('runtime scene environment does not force a 2D-only game into the 3D renderer', () => {
  assert.match(engine, /commands\.set\('__scene__',\[\{type:'environment',preset:sceneEnvironment\?\.preset\|\|'day'\}\]\)/);
  assert.match(engine, /const drawCommands=new Map\(\[\.\.\.activeCommands\]\.filter\(\(\[id\]\)=>id!=='__scene__'\)\)/);
  assert.match(engine, /const allDraws=draws/);
  assert.match(engine, /drawScene\(drawCommands\)/);
  assert.match(engine, /window\.PStudio3D\.render\(commands\)/);
});

test('GLB material inspector exposes sidedness, normal recalculation, roughness, metalness and emissive controls', () => {
  for (const id of [
    'obj-model-material-roughness', 'obj-model-material-metalness', 'obj-model-material-color',
    'obj-model-double-side', 'obj-model-recompute-normals',
    'obj-model-material-emissive', 'obj-model-material-emissive-intensity'
  ]) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /doubleSide:!!document\.getElementById\('obj-model-double-side'\)\?\.checked/);
  assert.match(html, /recomputeNormals:!!document\.getElementById\('obj-model-recompute-normals'\)\?\.checked/);
  assert.match(html, /emissiveIntensity:Math\.max\(0,Math\.min\(8/);
  assert.match(engine, /doubleSide:override\.doubleSide,recomputeNormals:override\.recomputeNormals,emissive:override\.emissive,emissiveIntensity:override\.emissiveIntensity/);
});

test('GLB material overrides restore source defaults and use per-instance geometry clones for normal recalculation', () => {
  for (const token of [
    'materialDefaults.set(copy,{',
    'emissive:material.emissive?.clone?.()||null',
    'side:material.side??T.FrontSide',
    'material.side=override.doubleSide?window.THREE.DoubleSide:(defaults.side??window.THREE.FrontSide)',
    'material.emissive.set(override.emissive)',
    'geometryOriginals=new Map(),normalGeometryClones=new Map()',
    'const original=object.userData?.pstudioLightmapGeometry?object.geometry:',
    'normalized=original.clone()',
    'normalized.computeVertexNormals()',
    "normalized.deleteAttribute('tangent')",
    'scheduleGeometryBVH(normalized)',
    'object.geometry=normalized',
    'if(normalized&&object.geometry===normalized)object.geometry=original',
    'for(const geometry of instance.normalGeometryClones?.values?.()||[])'
  ]) assert.ok(renderer.includes(token), token);
});

test('model material instances do not capture geometry before LOD or lightmap setup', () => {
  assert.match(renderer,/normalGeometrySignature=overrides\.some\(item=>item\.recomputeNormals===true\)/);
  assert.doesNotMatch(renderer,/geometryOriginals\.set\(object,object\.geometry\)/);
  assert.match(renderer,/const original=object\.userData\?\.pstudioLightmapGeometry\?object\.geometry/);
  assert.match(renderer,/normalGeometryClones\?\.set\(original,normalized\)/);
});
test('normal overrides follow LOD and lightmap geometry revisions without per-frame mesh scans',()=>{
  assert.match(renderer,/function markModelGeometryChanged\(object\)/);
  assert.match(renderer,/object\.geometry=levels\[selected\]\.geometry;\s*markModelGeometryChanged\(object\)/);
  assert.match(renderer,/object\.geometry=working;object\.userData\.pstudioLightmapGeometry=true;markModelGeometryChanged\(object\)/);
  assert.match(renderer,/object\.geometry=working;working=null;object\.userData\.pstudioLightmapGeometry=true;markModelGeometryChanged\(object\)/);
  assert.match(renderer,/object\.geometry=object\.userData\.pstudioLightmapOriginalGeometry;markModelGeometryChanged\(object\)/);
  assert.match(renderer,/normalGeometrySignature=overrides\.some\(item=>item\.recomputeNormals===true\)\s*\?Number\(instance\.root\?\.userData\?\.pstudioGeometryRevision\)\|\|0/);
});

test('PStudio retains existing ps material API arity and does not change parser or generated code interface', () => {
  assert.match(app, /"set_model_material": 4/);
  assert.match(engine, /case 'set_model_material': if\(a\.length===4\)/);
  assert.match(engine, /case 'set_environment': if\(a\.length===3\)/);
});

test('project backups preserve scene environment presets and restore old backups as daytime',()=>{
  assert.match(html,/environment:normalizeSceneEnvironment\(sceneEnvironment\)/);
  assert.match(html,/let sourceEnvironment=archive\.project\.environment\|\|null/);
  assert.match(html,/JSON\.parse\(files\['main\.scene'\]\?\.content\|\|'null'\)\?\.environment/);
  assert.match(html,/const environment=\{preset:\['day','dusk','night','studio'\]\.includes\(sourcePreset\)\?sourcePreset:'day'\}/);
  assert.match(html,/next\.files\['main\.scene'\]\.content=JSON\.stringify\(\{width:960,height:540,objects:next\.objects,environment:next\.environment\}/);
  assert.match(html,/const nextState=\{files:next\.files,assets:next\.assets,objects:next\.objects,environment:next\.environment,active:next\.active\}/);
  assert.match(html,/sceneEnvironment=next\.environment/);
  assert.match(html,/environment:sceneEnvironment/);
});
test('project backup restores sanitized GLB material overrides without trusting arbitrary input',()=>{
  assert.match(html,/sourceOverrides\.length>64/);
  assert.match(html,/sourceOverrides\.map\(override=>/);
  assert.match(html,/doubleSide:override\.doubleSide===true/);
  assert.match(html,/recomputeNormals:override\.recomputeNormals===true/);
  assert.match(html,/emissiveIntensity:bounded\(override\.emissiveIntensity,0,8\)/);
  assert.match(html,/\^\#\[0-9a-fA-F\]\{6\}\$/);
  assert.match(html,/modelMaterialOverrides=sourceOverrides\.map/);
});
test('procedural scene environment releases the unused room PMREM when switching to the preset PMREM',()=>{
  assert.match(renderer,/if\(environmentTarget\)\{environmentTarget\.dispose\?\.\(\);environmentTarget=null;\}/);
  assert.match(renderer,/scenePresetTarget=nextTarget/);
  assert.match(renderer,/scene\.environment=scenePresetTarget\.texture/);
});


test('atmosphere renderer calibrates physical-sky exposure and always draws a detailed authored panorama in the editor',()=>{
  assert.ok(html.includes("three/addons/objects/Sky.js"));
  assert.ok(html.includes("window.PStudioSky = null"));
  for(const token of [
    'new window.PStudioSky()','PStudioPhysicalSky','uniforms.sunPosition.value.copy(sunDirection).multiplyScalar(450000)',
    'enhancePhysicalSkyShader','pStudioHorizonBand','pStudioTwilight',
    'pStudioAtmosphereExposure','pStudioTwilightStrength',
    'uniforms.turbidity.value','uniforms.rayleigh.value','createPhysicalSkyEnvironmentTarget',
    'pmremGenerator.fromScene(skyScene,0.04)','scenePresetUsesPhysicalSky=!!(physicalSkyReady&&nextTarget)',
    'if(physicalSky)physicalSky.visible=false'
  ])assert.ok(renderer.includes(token),token);
  assert.ok(renderer.includes('function createProceduralSkyTexture(T,profile)'));
  assert.ok(renderer.includes('const width=2048,height=1024;'));
  assert.ok(renderer.includes('for(let i=0;i<12000;i++)'));
  assert.ok(renderer.includes('scene.background=scenePresetTexture'));
  assert.ok(renderer.includes('pmremGenerator.fromEquirectangular(nextTexture)'));
  assert.ok(renderer.includes('uniforms.pStudioAtmosphereExposure.value=Math.max(.1,Math.min(1,Number(profile.skyExposure)||.45))'));
});

test('night moon is a real spherical mesh with one-time surface texture creation and camera-relative placement',()=>{
  assert.match(renderer,/A dark, periodic starfield with a structured Milky Way/);
  assert.match(renderer,/for\(let i=0;i<12000;i\+\+\)/);
  assert.match(renderer,/function createMoonSurfaceTexture\(T\)/);
  assert.match(renderer,/function ensureMoonMesh\(T\)/);
  assert.match(renderer,/new T\.SphereGeometry\(1,64,48\)/);
  assert.match(renderer,/if\(moonMesh\?\.parent===scene\)return moonMesh/);
  assert.match(renderer,/function configureMoonSky\(T,profile\)/);
  assert.match(renderer,/function updateMoonSkyMesh\(\)/);
  assert.match(renderer,/moonMesh\.position\.copy\(camera\.position\)\.addScaledVector\(moonDirection,distance\)/);
  assert.match(renderer,/moonMesh\.scale\.setScalar\(radius\)/);
  assert.match(renderer,/updateMoonSkyMesh\(\)/);
  assert.doesNotMatch(renderer,/const moonRadius=48|context\.ellipse\(moon\.x/);
});
test('night moon sphere has finer surface detail, a larger apparent size and a real lunar aureole',()=>{
  assert.match(renderer,/canvas\.width=1024;canvas\.height=512/);
  assert.ok(renderer.includes("for(let i=0;i<280;i++)"));
  assert.ok(renderer.includes("for(let i=0;i<900;i++)"));
  assert.ok(renderer.includes("Math.tan(2.25*Math.PI/180)"));
  assert.match(renderer,/const moonAura=context\.createRadialGradient/);
  assert.match(renderer,/uMoonGlare/);
  assert.match(renderer,/mesh\.material\.uniforms\.uMoonIntensity\.value=moonIntensity/);
});
 
test('daylight sun is a one-time spherical photosphere with aligned direction and no stretched panorama disc',()=>{
  assert.match(renderer,/function createSunSurfaceTexture\(T\)/);
  assert.match(renderer,/function ensureSunMesh\(T\)/);
  assert.match(renderer,/new T\.SphereGeometry\(1,48,32\)/);
  assert.match(renderer,/sunMesh\.name='PStudioSunSphere'/);
  assert.match(renderer,/function configureSunSky\(T,profile\)/);
  assert.match(renderer,/function updateSunSkyMesh\(\)/);
  assert.match(renderer,/sunMesh\.position\.copy\(camera\.position\)\.addScaledVector\(sunDirection,distance\)/);
  assert.match(renderer,/sunMesh\.scale\.setScalar\(radius\)/);
  assert.match(renderer,/configureSunSky\(T,profile\)/);
  assert.match(renderer,/updateSunSkyMesh\(\)/);
  assert.doesNotMatch(renderer,/context\.arc\(sun\.x,sun\.y,sunRadius/);
});
 
test('day and dusk panoramas use a spherical photosphere, richer cloud layers and distinct warm twilight treatment',()=>{
  assert.match(renderer,/const directionUv=\(x,y,z\)=>/);
  assert.match(renderer,/const sun=directionUv\(/);
  assert.match(renderer,/Soft, broken cloud banks and fine cirrus/);
  assert.match(renderer,/pStudioWarmHorizon/);
  assert.ok(presets.getPreset('dusk').skySunY<presets.getPreset('day').skySunY);
});

test('editor grid adapts density and opacity at distance and disposes GridHelper material arrays safely',()=>{
  assert.match(renderer,/function gridDivisionsForDistance\(baseDivisions,distance\)/);
  assert.match(renderer,/function updateEditorGridPresentation\(\)/);
  assert.match(renderer,/const opacity=distance>900\?\.14:distance>520\?\.19:distance>280\?\.25:distance>140\?\.32:\.42/);
  assert.match(renderer,/function disposeGrid\(grid\)/);
  assert.match(renderer,/for\(const material of gridMaterials\(grid\)\)material\?\.dispose\?\.\(\)/);
  assert.match(renderer,/for\(const grid of gridCache\.values\(\)\)\{gridGroup\.remove\(grid\);disposeGrid\(grid\);\}/);
});

test('editor orbit reaches near-vertical top-down and bottom-up views while gameplay camera keeps its full pitch range',()=>{
  assert.match(renderer,/function clampEditorOrbitPitch\(value\)/);
  assert.match(renderer,/if\(window\.PStudioEngine\?\.isRunning\?\.\(\)\)return Math\.max\(-1\.35,Math\.min\(1\.35,pitch\)\)/);
  assert.match(renderer,/const maxElevation=Math\.PI\/2-0\.002/);
  assert.match(renderer,/const minPitch=baseElevation-maxElevation/);
  assert.match(renderer,/const maxPitch=baseElevation\+maxElevation/);
  assert.match(renderer,/offset\.set\(Math\.sin\(azimuth\)\*horizontal,Math\.sin\(elevation\)\*radius/);
  assert.match(renderer,/orbitPitch=clampEditorOrbitPitch\(orbitPitch\)/);
});


test('day dusk night and studio define physically distinct sun elevations and atmosphere controls',()=>{
  const day=presets.getPreset('day'),dusk=presets.getPreset('dusk'),night=presets.getPreset('night'),studio=presets.getPreset('studio');
  for(const [name,profile] of Object.entries({day,dusk,night,studio})){
    for(const field of ['starBrightness','moonGlow','sunIntensity','sunAngularRadius','sunColor','cloudDensity','cloudCoverage','cloudDetail','cloudBase','cloudTop','skySunX','skySunY','skySunZ','skyTurbidity','skyRayleigh','skyMieCoefficient','skyMieDirectionalG','skyExposure','twilightStrength','atmosphereSunColor','moonDirectionX','moonDirectionY','moonDirectionZ','moonIntensity','moonPhase','fogDensity','fogHeightFalloff','fogBaseHeight','fogAnisotropy'])
      assert.ok(Object.prototype.hasOwnProperty.call(profile,field),name+': '+field);
    assert.ok(Math.hypot(profile.skySunX,profile.skySunY,profile.skySunZ)>.9,name+' sun direction');
    assert.ok(profile.fogDensity>0,name+' fog density');
  }
  for(const profile of [day,dusk,studio]){
    assert.ok(Math.abs(profile.skySunX+profile.lightX)<.02,'visible sun and direct light X must align: '+profile.name);
    assert.ok(Math.abs(profile.skySunY+profile.lightY)<.02,'visible sun and direct light Y must align: '+profile.name);
    assert.ok(Math.abs(profile.skySunZ+profile.lightZ)<.02,'visible sun and direct light Z must align: '+profile.name);
  }
  assert.ok(day.sunIntensity>1,'day should retain a bright solar photosphere');
  assert.ok(dusk.sunIntensity>1.2,'dusk should retain a bright warm solar photosphere');
  assert.ok(dusk.sunAngularRadius>0.4&&dusk.sunAngularRadius<0.8,'the dusk sun should retain a natural, restrained angular diameter');
  assert.ok(renderer.includes("const glowRadius=sunRadius*(dusk?2.6:10)"));
  assert.match(renderer,/const horizonBand=context\.createLinearGradient/,'dusk should include a layered horizon afterglow');
  assert.ok(renderer.includes("const glowRadiusX=width*.17,glowRadiusY=height*.045"));
  assert.ok(day.cloudDetail>.75&&dusk.cloudDetail>.8,'day and dusk require high-detail layered clouds');
  assert.equal(night.sunIntensity,0);
  assert.equal(day.moonIntensity,0);
  assert.equal(dusk.moonIntensity,0);
  assert.ok(night.moonIntensity>.5,'night moon should be visible');
  assert.ok(Math.abs(night.moonDirectionX+night.lightX)<.02,'night moon and moonlight X must align');
  assert.ok(Math.abs(night.moonDirectionY+night.lightY)<.02,'night moon and moonlight Y must align');
  assert.ok(Math.abs(night.moonDirectionZ+night.lightZ)<.02,'night moon and moonlight Z must align');
  assert.ok(day.skySunY>.8,'day sun should be high in the sky');
  assert.ok(dusk.skySunY>0&&dusk.skySunY<.1,'dusk sun should sit close to the horizon');
  assert.ok(night.skySunY<0,'night sun should be below the horizon');
  assert.equal(night.sunRadius,0,'night fallback must not draw a sun disc');
  assert.equal(night.sunGlow,0,'night fallback must not draw a solar halo');
  assert.ok(dusk.skyTurbidity>day.skyTurbidity,'dusk needs a richer aerosol scattering profile');
  assert.ok(day.skyExposure<.6,'physical daylight sky must be calibrated below PStudio global exposure');
  assert.ok(dusk.twilightStrength>.8,'dusk shader needs a deliberate warm horizon treatment');
  assert.ok(night.moonIntensity>1,'night moonlight should be stronger');
  assert.ok(night.lightIntensity>.8&&night.hemisphereIntensity>.3,'night uses stronger but balanced moonlight fill');
  assert.ok(night.starBrightness>1.4&&night.moonGlow>.6,'night lifts star brightness and lunar aureole');
  assert.ok(night.fogDensity<day.fogDensity,'night haze should be subtler than daytime haze');
});


test('night preset uses a dedicated dark procedural panorama and never exposes the daylight physical-sky scattering mesh',()=>{
  const night=presets.getPreset('night');
  assert.ok(night.skyTop.toLowerCase()==='#030817');
  assert.ok(night.skyMid.toLowerCase()==='#0b1930');
  assert.ok(night.horizon.toLowerCase()==='#1b2a43');
  assert.match(renderer,/profile\.name!=='night'&&updatePhysicalSkyPreset\(T,profile\)/);
  assert.match(renderer,/if\(physicalSky\)physicalSky\.visible=false/);
  assert.match(renderer,/if\(scenePresetTexture\)scene\.background=scenePresetTexture/);
});

test('physical-sky PMREM failure activates the procedural panorama as both visible sky and available environment source',()=>{
  assert.match(renderer,/scenePresetUsesPhysicalSky=!!\(physicalSkyReady&&nextTarget\)/);
  assert.match(renderer,/try\{nextTexture=createProceduralSkyTexture\(T,profile\);?\}/);
  assert.match(renderer,/if\(!nextTarget&&nextTexture&&pmremGenerator\)/);
  assert.match(renderer,/if\(scenePresetTexture\)scene\.background=scenePresetTexture/);
  assert.match(renderer,/else scene\.background=new T\.Color\(profile\.horizon\|\|profile\.skyMid\|\|'#79BCE0'\)/);
});


test('night sky uses a more populated, brighter starfield while preserving the navy-blue palette',()=>{
  assert.ok(renderer.includes("const starBrightness=Math.max(.75,Math.min(1.8,Number(profile.starBrightness)||1))"));
  assert.ok(renderer.includes("for(let i=0;i<12000;i++)"));
  assert.ok(renderer.includes("for(let i=0;i<2600;i++)"));
  assert.ok(renderer.includes("(.12+random()*.55+band*.2)"));
  assert.ok(renderer.includes("const alpha=(.045+random()*.09)*starBrightness;"));
  assert.ok(renderer.includes("nightStars:name==='night'?14600:0"));
  assert.ok(renderer.includes("nightPrimaryStars:name==='night'?12000:0"));
});

test('night sky uses a periodic multi-octave Milky Way field and a dense fine-star distribution',()=>{
  assert.match(renderer,/makeNoiseGrid=\(gridWidth,gridHeight\)=>/);
  assert.match(renderer,/sampleNoise=\(grid,u,v\)=>/);
  assert.match(renderer,/x1=\(x0\+1\)%grid\.width/);
  assert.match(renderer,/galaxyWidth=width,galaxyHeight=height/);
  assert.match(renderer,/const structure=clamp01\(/);
  assert.match(renderer,/const dust=clamp01\(/);
  assert.match(renderer,/globalCompositeOperation='screen'/);
  assert.match(renderer,/for\(let i=0;i<12000;i\+\+\)/);
  assert.match(renderer,/night:\[\[0,'#01040B'/);
  assert.ok(renderer.includes("nightStars:name==='night'?14600:0"));
});

test('studio preset disables both painted and volumetric cloud layers',()=>{
  const cloudStart=renderer.indexOf("if(name==='day'||name==='dusk'){");
  const cloudEnd=renderer.indexOf('const glowRadius=',cloudStart);
  assert.ok(cloudStart>=0&&cloudEnd>cloudStart,'static cloud rendering must be explicitly gated by day/dusk presets');
  assert.match(renderer,/activeEnvironmentPreset='day'/);
  assert.match(renderer,/activeEnvironmentPreset=String\(profile\.name\|\|'day'\)/);
  assert.match(renderer,/cloudTierActive=!memorySafetyApplied/);
  assert.match(renderer,/volumetricCloudsEnabled=activeEnvironmentPreset!=='studio'&&!!\(cloudTier\?\.clouds&&cloudTierActive&&volumetricCloudPass\)/);
  assert.match(renderer,/volumetricCloudsEnabled=effects&&!!base\.clouds&&!!volumetricCloudPass&&activeEnvironmentPreset!=='studio'/);
  assert.match(renderer,/volumetricCloudsEnabled=!!enabled&&!!volumetricCloudPass&&activeEnvironmentPreset!=='studio'/);
  assert.equal(presets.getPreset('studio').name,'studio');
});


test('night panorama keeps full-resolution Milky Way detail and wraps its longitude seam',()=>{
  assert.match(renderer,/galaxyWidth=width,galaxyHeight=height/);
  assert.match(renderer,/texture\.wrapS=T\.RepeatWrapping;texture\.wrapT=T\.ClampToEdgeWrapping/);
  assert.match(renderer,/texture\.mapping=T\.EquirectangularReflectionMapping/);
});

test('moon has a larger angular diameter and higher sphere tessellation',()=>{
  assert.match(renderer,/new T\.SphereGeometry\(1,64,48\)/);
  assert.match(renderer,/Math\.tan\(3\.0\*Math\.PI\/180\)/);
});

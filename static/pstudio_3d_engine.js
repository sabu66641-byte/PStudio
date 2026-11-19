/* PStudio isolated 3D renderer.
 * This module only owns the additional WebGL canvas; the existing 2D renderer is untouched.
 */
(() => {
  'use strict';
  const canvas = document.getElementById('game-3d-canvas');
  if (!canvas) return;
  let renderer = null;
  let scene = null;
  let camera = null;
  let primitiveGroup = null;
  let modelGroup = null;
  let selectionGroup = null;
  const modelCache = new Map();
  const modelPromises = new Map();
  const modelRevisions = new Map();
  const modelInstances = new Map();
  const modelLoadErrors = new Map();
  let lastCommands = null;
  let selectedOwnerId = null;
  let selectionSignature = '';
  let gridGroup = null;
  let hemisphereLight = null;
  let keyLight = null;
  const meshCache = new Map();
  const gridCache = new Map();
  let lastSize = { width: 0, height: 0 };
  let orbitYaw = 0, orbitPitch = 0, zoom = 1, pointerMode = null, pointerStart = null, dragInfo = null;
  let raycaster = null, pointerNdc = null, controlsReady = false;
  const activePointers = new Map();
  let pinchDistance = 0;
  let pinchGestureStart = null;
  let pinchGestureMode = null;
  let cameraTarget = [0, 0, 0];
  let cameraBase = [6, 5, 8];
  let cameraPan = null;
  let pinchMidpoint = null;

  function setupControls() {
    if (controlsReady) return;
    controlsReady = true;
    raycaster = new window.THREE.Raycaster(); pointerNdc = new window.THREE.Vector2();
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', e => {
      if (!renderer || !camera) return;
      activePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(activePointers.size===2){const pts=[...activePointers.values()];pinchDistance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);pinchMidpoint={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};pinchGestureStart={distance:pinchDistance,midpoint:{...pinchMidpoint}};pinchGestureMode=null;pointerMode='pinch';dragInfo=null;try{canvas.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault();return;}
      if(e.button===1 || e.button===2 || (e.button===0 && e.shiftKey)){pointerMode='pan';pointerStart={x:e.clientX,y:e.clientY};try{canvas.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault();return;}
      const rect=canvas.getBoundingClientRect();
      pointerNdc.set(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
      raycaster.setFromCamera(pointerNdc,camera);
      const hit=raycaster.intersectObjects([primitiveGroup,modelGroup].filter(Boolean),true).find(h=>h.object.userData.ownerId);
      pointerStart={x:e.clientX,y:e.clientY};
      if(hit){
        const mesh=hit.object.userData.modelRoot || hit.object,ownerId=mesh.userData.ownerId;
        window.PStudioSceneInteraction?.select?.(ownerId);
        // Drag on a camera-facing plane so horizontal and vertical finger movement
        // both translate the object naturally in the editor view.
        const normal=new window.THREE.Vector3();
        camera.getWorldDirection(normal);
        const plane=new window.THREE.Plane().setFromNormalAndCoplanarPoint(normal,mesh.position);
        const point=new window.THREE.Vector3();
        if(raycaster.ray.intersectPlane(plane,point)){pointerMode='object';dragInfo={mesh,ownerId,plane,startPoint:point,startPosition:mesh.position.clone()};}
        else pointerMode='orbit';
      }else{pointerMode='orbit';dragInfo=null;}
      try{canvas.setPointerCapture(e.pointerId)}catch(_){} e.preventDefault();
    });
    canvas.addEventListener('pointermove',e=>{
      if(!pointerMode||!renderer)return;
      if(activePointers.has(e.pointerId))activePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointerMode==='pinch'&&activePointers.size>=2){const pts=[...activePointers.values()];const distance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);const midpoint={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};if(!pinchGestureMode&&pinchGestureStart){const zoomDelta=Math.abs(distance-pinchGestureStart.distance);const panDelta=Math.hypot(midpoint.x-pinchGestureStart.midpoint.x,midpoint.y-pinchGestureStart.midpoint.y);if(Math.max(zoomDelta,panDelta)>5)pinchGestureMode=zoomDelta>panDelta*1.15?'zoom':'pan';}if(pinchGestureMode==='zoom'&&pinchDistance>0)zoom=Math.max(0.25,Math.min(4,zoom*(distance/Math.max(1,pinchDistance))));else if(pinchGestureMode==='pan'&&pinchMidpoint)panCamera(midpoint.x-pinchMidpoint.x,midpoint.y-pinchMidpoint.y);pinchDistance=distance;pinchMidpoint=midpoint;}
      else if(pointerMode==='orbit'){
        const dx=e.clientX-pointerStart.x,dy=e.clientY-pointerStart.y;
        orbitYaw+=dx*0.006;orbitPitch=Math.max(-1.35,Math.min(1.35,orbitPitch+dy*0.006));pointerStart={x:e.clientX,y:e.clientY};
      }else if(pointerMode==='pan'){panCamera(e.clientX-pointerStart.x,e.clientY-pointerStart.y);pointerStart={x:e.clientX,y:e.clientY};}else if(pointerMode==='object'&&dragInfo){
        const rect=canvas.getBoundingClientRect();pointerNdc.set(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);raycaster.setFromCamera(pointerNdc,camera);
        const point=new window.THREE.Vector3();
        if(raycaster.ray.intersectPlane(dragInfo.plane,point)){
          const pos=dragInfo.startPosition.clone().add(point.sub(dragInfo.startPoint));
          dragInfo.mesh.position.copy(pos);
          window.PStudioSceneInteraction?.moveWorld?.(dragInfo.ownerId,pos.x,pos.y,pos.z);
          refreshSelectionOutline();
          renderer.render(scene,camera);
        }
      }
      if(pointerMode==='orbit' || pointerMode==='pinch' || pointerMode==='pan') updateCamera();
      e.preventDefault();
    });
    const end=e=>{activePointers.delete(e.pointerId);if(activePointers.size===1){const remaining=[...activePointers.values()][0];pointerMode='orbit';pointerStart={x:remaining.x,y:remaining.y};}else if(activePointers.size===0){pointerMode=null;dragInfo=null;pointerStart=null;pinchDistance=0;pinchMidpoint=null;pinchGestureStart=null;pinchGestureMode=null;}};
    canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
    canvas.addEventListener('wheel',e=>{zoom=Math.max(0.25,Math.min(4,zoom*Math.exp(e.deltaY*0.00075)));updateCamera();e.preventDefault();},{passive:false});
    canvas.addEventListener('contextmenu',e=>e.preventDefault());
  }
  function ensureRenderer() {
    if (renderer) return true;
    if (!window.THREE || !window.THREE.WebGLRenderer) return false;
    const T = window.THREE;
    renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x171d26, 1);
    scene = new T.Scene();
    scene.background = new T.Color(0x171d26);
    camera = new T.PerspectiveCamera(55, 16 / 9, 0.1, 1000);
    camera.position.set(6, 5, 8);
    camera.lookAt(0, 0, 0);
    primitiveGroup = new T.Group();
    modelGroup = new T.Group();
    gridGroup = new T.Group();
    selectionGroup = new T.Group();
    scene.add(primitiveGroup, modelGroup, gridGroup, selectionGroup);
    cameraPan = new T.Vector3();
    hemisphereLight = new T.HemisphereLight(0xffffff, 0x394150, 2.0);
    scene.add(hemisphereLight);
    keyLight = new T.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(5, 8, 6);
    scene.add(keyLight);
    setupControls();
    return true;
  }

  function disposeGroup(group) {
    while (group.children.length) {
      const child = group.children[group.children.length - 1];
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    }
  }

  function resize() {
    if (!renderer) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (width !== lastSize.width || height !== lastSize.height) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastSize = { width, height };
    }
  }

  function panCamera(dx, dy) {
    if (!camera || !window.THREE) return;
    const T = window.THREE;
    const target = new T.Vector3(cameraTarget[0], cameraTarget[1], cameraTarget[2]).add(cameraPan || new T.Vector3());
    const distance = camera.position.distanceTo(target);
    const scale = Math.max(0.001, distance * 0.00125);
    const right = new T.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new T.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    cameraPan.addScaledVector(right, -dx * scale);
    cameraPan.addScaledVector(up, dy * scale);
  }

  function updateCamera() {
    if (!renderer || !camera || !window.THREE) return;
    const T = window.THREE;
    const target = new T.Vector3(cameraTarget[0], cameraTarget[1], cameraTarget[2]).add(cameraPan || new T.Vector3());
    const offset = new T.Vector3(cameraBase[0], cameraBase[1], cameraBase[2]).sub(target).multiplyScalar(zoom);
    offset.applyAxisAngle(new T.Vector3(0, 1, 0), orbitYaw);
    const right = new T.Vector3(1, 0, 0).applyAxisAngle(new T.Vector3(0, 1, 0), orbitYaw);
    offset.applyAxisAngle(right, orbitPitch);
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
    resize();
    renderer.render(scene, camera);
  }

  function refreshSelectionOutline() {
    if (!selectionGroup || !window.THREE) return;
    if (!selectedOwnerId || !primitiveGroup) {
      if(selectionGroup.children.length)disposeGroup(selectionGroup);
      selectionSignature='';
      return;
    }
    const T = window.THREE;
    const meshes = [];
    primitiveGroup.traverse(object => { if (object.isMesh && object.userData.ownerId === selectedOwnerId) meshes.push(object); });
    if (modelGroup) modelGroup.traverse(object => { if (object.isMesh && object.userData.ownerId === selectedOwnerId) meshes.push(object); });
    const signature=selectedOwnerId+':'+meshes.map(mesh=>mesh.uuid+':'+mesh.geometry?.uuid).join('|');
    if(signature!==selectionSignature){
      disposeGroup(selectionGroup);
      for (const mesh of meshes) {
        if(!mesh.geometry)continue;
        const edges = mesh.geometry.type === 'SphereGeometry' ? new T.WireframeGeometry(mesh.geometry) : new T.EdgesGeometry(mesh.geometry, 1);
        const material = new T.LineDashedMaterial({
          color: 0xffffff, dashSize: 0.12, gapSize: 0.08,
          transparent: true, opacity: 0.98, depthTest: false
        });
        const outline = new T.LineSegments(edges, material);
        outline.computeLineDistances();
        outline.renderOrder = 10;
        outline.userData.isSelectionOutline = true;
        outline.userData.sourceMesh = mesh;
        selectionGroup.add(outline);
      }
      selectionSignature=signature;
    }
    for(const outline of selectionGroup.children){
      const mesh=outline.userData.sourceMesh;
      if(!mesh)continue;
      mesh.updateWorldMatrix(true,false);
      mesh.matrixWorld.decompose(outline.position,outline.quaternion,outline.scale);
      outline.scale.multiplyScalar(1.015);
    }
  }
  function geometrySignature(d) {
    const n = v => Math.max(0.001, Number(v) || 0.001);
    switch (d.type) {
      case 'cube': return ['cube',n(d.size)].join(':');
      case 'box': return ['box',n(d.width),n(d.height),n(d.depth)].join(':');
      case 'sphere': return ['sphere',n(d.radius)].join(':');
      case 'plane': return ['plane',n(d.width),n(d.depth)].join(':');
      case 'cylinder': return ['cylinder',n(d.radius),n(d.height)].join(':');
      case 'cone': return ['cone',n(d.radius),n(d.height)].join(':');
      case 'capsule': return ['capsule',n(d.radius),Math.max(n(d.radius)*2,n(d.height))].join(':');
      default: return null;
    }
  }

  function createGeometry(d) {
    const T=window.THREE;
    switch (d.type) {
      case 'cube': return new T.BoxGeometry(d.size,d.size,d.size);
      case 'box': return new T.BoxGeometry(d.width,d.height,d.depth);
      case 'sphere': return new T.SphereGeometry(d.radius,24,16);
      case 'plane': return new T.PlaneGeometry(d.width,d.depth);
      case 'cylinder': return new T.CylinderGeometry(d.radius,d.radius,d.height,24);
      case 'cone': return new T.ConeGeometry(d.radius,d.height,24);
      case 'capsule': {
        const radius=Math.min(d.radius,d.height/2);
        const cylinderLength=Math.max(0.001,d.height-radius*2);
        const points=[];
        for(let i=0;i<=8;i++){
          const angle=(Math.PI/2)*(i/8);
          points.push(new T.Vector2(radius*Math.sin(angle),-cylinderLength/2-radius*Math.cos(angle)));
        }
        points.push(new T.Vector2(radius,cylinderLength/2));
        for(let i=1;i<=8;i++){
          const angle=Math.PI/2+(Math.PI/2)*(i/8);
          points.push(new T.Vector2(radius*Math.sin(angle),cylinderLength/2-radius*Math.cos(angle)));
        }
        return new T.LatheGeometry(points,24);
      }
      default: return null;
    }
  }

  function disposeMesh(mesh) {
    if (!mesh) return;
    if (mesh.parent) mesh.parent.remove(mesh);
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) mesh.material.dispose();
  }

  function disposeModelAsset(asset) {
    if(!asset?.scene)return;
    const geometries=new Set(),materials=new Set(),textures=new Set();
    asset.scene.traverse(object=>{
      if(!object.isMesh)return;
      if(object.geometry)geometries.add(object.geometry);
      for(const material of (Array.isArray(object.material)?object.material:[object.material]))if(material)materials.add(material);
    });
    materials.forEach(material=>{
      for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
    });
    geometries.forEach(geometry=>geometry.dispose());
    textures.forEach(texture=>texture.dispose());
    materials.forEach(material=>material.dispose());
  }

  function requestModelAsset(name) {
    if (modelCache.has(name)) return Promise.resolve(modelCache.get(name));
    if (modelPromises.has(name)) return modelPromises.get(name);
    const revision=modelRevisions.get(name)||0;
    const promise=(async()=>{
      if (!window.PStudioGLTFLoader) throw new Error('GLTFLoader is unavailable. Check the Three.js module connection.');
      if (!window.PStudioAssetStore) throw new Error('3D asset storage is unavailable.');
      const blob=await window.PStudioAssetStore.get(name);
      if (!blob) throw new Error('Model asset not found: '+name+' (import a .glb or .gltf file first)');
      const loader=new window.PStudioGLTFLoader();
      const source=name.toLowerCase().endsWith('.gltf') ? await blob.text() : await blob.arrayBuffer();
      const gltf=await new Promise((resolve,reject)=>loader.parse(source,'',resolve,reject));
      if (!gltf || !gltf.scene) throw new Error('The model file contains no scene: '+name);
      if((modelRevisions.get(name)||0)!==revision){disposeModelAsset({scene:gltf.scene});return null;}
      const asset={scene:gltf.scene,animations:gltf.animations||[]};
      modelCache.set(name,asset);
      return asset;
    })().catch(error=>{
      const message=String(error?.message||error);
      if((modelRevisions.get(name)||0)===revision){
        modelLoadErrors.set(name,message);
        console.error('[PStudio] Model load failed:',name,error);
        window.dispatchEvent(new CustomEvent('pstudio-model-error',{detail:{name,error:message}}));
      }
      return null;
    }).then(asset=>{
      if(asset)modelLoadErrors.delete(name);
      if(asset && renderer && lastCommands) {
        try { render(lastCommands); } catch(error) { console.error('[PStudio] Model render failed:',error); }
      }
      return asset;
    }).finally(()=>{
      if(modelPromises.get(name)===promise&&modelCache.has(name))modelPromises.delete(name);
    });
    modelPromises.set(name,promise);
    return promise;
  }

  function createModelInstance(key, ownerId, name, asset) {
    const T=window.THREE;
    const clone=window.PStudioSkeletonUtils?.clone
      ? window.PStudioSkeletonUtils.clone(asset.scene)
      : asset.scene.clone(true);
    clone.userData.ownerId=ownerId;
    clone.traverse(object=>{
      object.userData.ownerId=ownerId;
      object.userData.modelRoot=clone;
      if(object.isMesh && object.material){
        object.castShadow=true;
        object.receiveShadow=true;
      }
    });
    const mixer=asset.animations.length ? new T.AnimationMixer(clone) : null;
    const instance={key,ownerId,name,root:clone,mixer,animations:asset.animations,activeClip:null,activeLoop:true,speed:1};
    modelInstances.set(key,instance);
    modelGroup.add(clone);
    return instance;
  }

  function updateModelAnimation(instance, state, dt) {
    if(!instance.mixer) return;
    if(state.speed !== undefined) instance.speed=state.speed;
    if(state.stop){
      instance.mixer.stopAllAction();
      instance.activeClip=null;
    }
    if(state.clipName){
      const requested=state.clipName.toLowerCase();
      const clip=instance.animations.find(item=>item.name.toLowerCase()===requested)
        || instance.animations.find(item=>item.name.toLowerCase().includes(requested));
      const existingAction=clip ? instance.mixer.existingAction(clip) : null;
      const completedOneShot=!!(clip && state.loop===false && existingAction && !existingAction.isRunning());
      if(clip && (instance.activeClip!==clip.name || instance.activeLoop!==state.loop || completedOneShot)){
        instance.mixer.stopAllAction();
        const action=instance.mixer.clipAction(clip);
        action.reset();
        action.setLoop(state.loop===false ? window.THREE.LoopOnce : window.THREE.LoopRepeat, state.loop===false ? 1 : Infinity);
        action.clampWhenFinished=state.loop===false;
        action.play();
        instance.activeClip=clip.name;
        instance.activeLoop=state.loop!==false;
      } else if(!clip) {
        const warningKey=instance.name+':'+state.clipName;
        if(!modelLoadErrors.has(warningKey)){
          modelLoadErrors.set(warningKey,'animation clip not found');
          console.warn('[PStudio] Animation clip not found:',state.clipName,'in',instance.name);
        }
      }
    }
    instance.mixer.timeScale=instance.speed;
    instance.mixer.update(Math.max(0,Math.min(0.1,Number(dt)||0)));
  }

  function removeModelInstance(key) {
    const instance=modelInstances.get(key);
    if(!instance) return;
    if(instance.mixer) instance.mixer.stopAllAction();
    if(instance.root.parent) instance.root.parent.remove(instance.root);
    modelInstances.delete(key);
  }

  function render(commandsByObject) {
    if (!ensureRenderer()) throw new Error('Three.js could not be loaded. The 3D view needs an internet connection.');
    const T = window.THREE;
    lastCommands=commandsByObject;
    const usedMeshes=new Set(),usedGrids=new Set(),usedModels=new Set();
    let cameraCommand=null,environment=null;
    let defaultBackground=0x171d26;
    if(scene.background) scene.background.set(defaultBackground);
    scene.fog=null;
    if(hemisphereLight) hemisphereLight.intensity=2.0;
    if(keyLight){keyLight.position.set(5,8,6);keyLight.intensity=2.2;}
    for (const [ownerId,list] of commandsByObject.entries()) {
      for (let commandIndex=0;commandIndex<list.length;commandIndex++) {
        const d=list[commandIndex];
        const key=String(ownerId)+':'+commandIndex;
        if (d.type==='camera') { cameraCommand=d; continue; }
        if (d.type==='environment') { environment=Object.assign(environment||{},d); continue; }
        if (d.type==='animation') continue;
        if (d.type==='model') {
          let instance=modelInstances.get(key);
          let asset=modelCache.get(d.name);
          if(!asset) { requestModelAsset(d.name); continue; }
          if(!instance || instance.name!==d.name) {
            if(instance)removeModelInstance(key);
            instance=createModelInstance(key,ownerId,d.name,asset);
          }
          instance.ownerId=ownerId;
          instance.root.position.set(Number(d.x)||0,Number(d.y)||0,Number(d.z)||0);
          instance.root.rotation.set(Number(d.rotationX)||0,Number(d.rotationY)||0,Number(d.rotationZ)||0);
          instance.root.scale.setScalar(Math.max(0.001,Number(d.scale)||1));
          const animState={loop:true};
          for(const item of list){
            if(item.type!=='animation')continue;
            if(item.stop)animState.stop=true;
            if(item.clipName!==undefined){animState.clipName=item.clipName;animState.loop=item.loop!==false;}
            if(item.speed!==undefined)animState.speed=Number(item.speed);
          }
          updateModelAnimation(instance,animState,d.dt);
          usedModels.add(key);
          continue;
        }
        if (d.type==='grid') {
          let grid=gridCache.get(key);
          const signature=String(d.size)+':'+String(d.divisions);
          if(!grid||grid.userData.signature!==signature){
            if(grid){gridGroup.remove(grid);grid.geometry.dispose();grid.material.dispose();}
            grid=new T.GridHelper(d.size,d.divisions,0x7b8797,0x394352);
            grid.userData.signature=signature;
            gridCache.set(key,grid);
            gridGroup.add(grid);
          }
          grid.position.set(Number(d.x)||0,Number(d.y)||0,Number(d.z)||0);
          usedGrids.add(key);
          continue;
        }
        const signature=geometrySignature(d);
        if(!signature) continue;
        let mesh=meshCache.get(key);
        if(!mesh||mesh.userData.signature!==signature){
          if(mesh)disposeMesh(mesh);
          const geometry=createGeometry(d);
          if(!geometry)continue;
          const material=new T.MeshStandardMaterial({color:d.color||'#d1d5db',roughness:0.72,metalness:0.04});
          mesh=new T.Mesh(geometry,material);
          mesh.userData.signature=signature;
          meshCache.set(key,mesh);
          primitiveGroup.add(mesh);
        }
        if(d.color&&mesh.material.color.getStyle()!==new T.Color(d.color).getStyle())mesh.material.color.set(d.color);
        mesh.userData.ownerId=ownerId;
        mesh.position.set(Number(d.x)||0,Number(d.y)||0,Number(d.z)||0);
        const baseRotationX=d.type==='plane'?-Math.PI/2:0;
        mesh.rotation.set(baseRotationX+(Number(d.rotationX)||0),Number(d.rotationY)||0,Number(d.rotationZ)||0);
        usedMeshes.add(key);
      }
    }
    for(const [key,mesh] of meshCache){if(!usedMeshes.has(key)){disposeMesh(mesh);meshCache.delete(key);}}
    for(const [key,grid] of gridCache){if(!usedGrids.has(key)){gridGroup.remove(grid);grid.geometry.dispose();grid.material.dispose();gridCache.delete(key);}}
    for(const key of modelInstances.keys()){if(!usedModels.has(key))removeModelInstance(key);}
    if(environment){
      if(environment.background&&scene.background)scene.background.set(environment.background);
      if(environment.fogColor){
        const near=Math.max(0,Number(environment.fogNear)||0);
        const far=Math.max(near+0.01,Number(environment.fogFar)||100);
        scene.fog=new T.Fog(environment.fogColor,near,far);
      }
      if(keyLight){
        if(Number.isFinite(environment.lightX))keyLight.position.x=environment.lightX;
        if(Number.isFinite(environment.lightY))keyLight.position.y=environment.lightY;
        if(Number.isFinite(environment.lightZ))keyLight.position.z=environment.lightZ;
        if(Number.isFinite(environment.lightIntensity))keyLight.intensity=environment.lightIntensity;
      }
    }
    cameraTarget = cameraCommand
      ? [cameraCommand.targetX, cameraCommand.targetY, cameraCommand.targetZ]
      : [0, 0, 0];
    cameraBase = cameraCommand
      ? [cameraCommand.x, cameraCommand.y, cameraCommand.z]
      : [6, 5, 8];
    refreshSelectionOutline();
    updateCamera();
  }
  function clear() {
    if (!renderer) return;
    for(const key of [...modelInstances.keys()])removeModelInstance(key);
    for(const mesh of meshCache.values())disposeMesh(mesh);
    meshCache.clear();
    for(const grid of gridCache.values()){gridGroup.remove(grid);grid.geometry.dispose();grid.material.dispose();}
    gridCache.clear();
    disposeGroup(selectionGroup);
    selectionSignature='';
    if(renderer)renderer.render(scene,camera);
  }

  function invalidateAsset(name) {
    const key=String(name);
    modelRevisions.set(key,(modelRevisions.get(key)||0)+1);
    const cachedAsset=modelCache.get(key);
    modelCache.delete(key);
    modelPromises.delete(key);
    modelLoadErrors.delete(key);
    for(const [instanceKey,instance] of modelInstances){
      if(instance.name===key)removeModelInstance(instanceKey);
    }
    if(cachedAsset)disposeModelAsset(cachedAsset);
    if(renderer&&lastCommands){
      try{render(lastCommands);}catch(error){console.error('[PStudio] Asset refresh failed:',error);}
    }
  }
  window.PStudio3D = { render, clear, setSelected: id => { selectedOwnerId = id || null; refreshSelectionOutline(); if (renderer && scene && camera) renderer.render(scene, camera); }, isAvailable: () => !!window.THREE, getModelError: name => modelLoadErrors.get(name) || null, invalidateAsset };
  window.addEventListener('resize', resize);
})();
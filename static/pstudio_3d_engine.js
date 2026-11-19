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
  const dynamicLights = new Map();
  const particleBursts = new Map();
  let environmentTexture = null;
  let environmentSignature = '';
  const meshCache = new Map();
  const gridCache = new Map();
  let lastSize = { width: 0, height: 0 };
  let orbitYaw = 0, orbitPitch = 0, zoom = 1, pointerMode = null, pointerStart = null, dragInfo = null;
  let raycaster = null, cameraCollisionRaycaster = null, pointerNdc = null, controlsReady = false;
  const activePointers = new Map();
  let pinchDistance = 0;
  let pinchGestureStart = null;
  let pinchGestureMode = null;
  let cameraTarget = [0, 0, 0];
  let cameraBase = [6, 5, 8];
  let activeCameraOwnerId = null;
  let cameraPan = null;
  let cameraSmoothing = 0;
  let smoothedTarget = null;
  let smoothedPosition = null;
  let pinchMidpoint = null;
  let lastObjectTap = null;
  const DOUBLE_TAP_MS = 500;
  const DOUBLE_TAP_DISTANCE = 40;

  function setupControls() {
    if (controlsReady) return;
    controlsReady = true;
    raycaster = new window.THREE.Raycaster();
    cameraCollisionRaycaster = new window.THREE.Raycaster();
    pointerNdc = new window.THREE.Vector2();
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', e => {
      if (!renderer || !camera) return;
      activePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(activePointers.size===2){const pts=[...activePointers.values()];pinchDistance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);pinchMidpoint={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};pinchGestureStart={distance:pinchDistance,midpoint:{...pinchMidpoint}};pinchGestureMode=null;pointerMode='pinch';dragInfo=null;lastObjectTap=null;try{canvas.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault();return;}
      if(e.button===1 || e.button===2 || (e.button===0 && e.shiftKey)){pointerMode='pan';pointerStart={x:e.clientX,y:e.clientY};lastObjectTap=null;try{canvas.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault();return;}
      // During Play, pointer drags control the third-person camera rather than editing scene objects.
      if(window.PStudioEngine?.isRunning?.()){
        pointerMode='orbit';
        pointerStart={x:e.clientX,y:e.clientY};
        lastObjectTap=null;
        try{canvas.setPointerCapture(e.pointerId)}catch(_){}
        e.preventDefault();
        return;
      }
      const rect=canvas.getBoundingClientRect();
      pointerNdc.set(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
      raycaster.setFromCamera(pointerNdc,camera);
      const hit=raycaster.intersectObjects([primitiveGroup,modelGroup].filter(Boolean),true).find(h=>h.object.userData.ownerId);
      pointerStart={x:e.clientX,y:e.clientY};
      if(hit){
        const mesh=hit.object.userData.modelRoot || hit.object,ownerId=mesh.userData.ownerId;
        window.PStudioSceneInteraction?.select?.(ownerId);
        const now=Date.now(),tap=lastObjectTap;
        const isDoubleTap=!!(tap&&tap.ownerId===ownerId&&now-tap.time<=DOUBLE_TAP_MS&&Math.hypot(e.clientX-tap.x,e.clientY-tap.y)<=DOUBLE_TAP_DISTANCE);
        if(isDoubleTap){
          lastObjectTap=null;
          window.PStudioSceneInteraction?.toggleManipulation?.(ownerId);
          refreshSelectionOutline();
          if(renderer&&scene&&camera)renderer.render(scene,camera);
          pointerMode='double-tap';dragInfo=null;
        }else{
          const enabled=window.PStudioSceneInteraction?.isManipulationEnabled?.(ownerId)!==false;
          if(!enabled){pointerMode='locked-object';dragInfo={ownerId};}
          else{
            const normal=new window.THREE.Vector3();
            camera.getWorldDirection(normal);
            const plane=new window.THREE.Plane().setFromNormalAndCoplanarPoint(normal,mesh.position);
            const point=new window.THREE.Vector3();
            if(raycaster.ray.intersectPlane(plane,point)){pointerMode='object-pending';dragInfo={mesh,ownerId,plane,startPoint:point,startPosition:mesh.position.clone()};}
            else {pointerMode='orbit';dragInfo=null;}
          }
        }
      }else{pointerMode='orbit';dragInfo=null;lastObjectTap=null;}
      try{canvas.setPointerCapture(e.pointerId)}catch(_){} e.preventDefault();
    });
    canvas.addEventListener('pointermove',e=>{
      if(!pointerMode||!renderer)return;
      if(lastObjectTap&&Math.hypot(e.clientX-lastObjectTap.x,e.clientY-lastObjectTap.y)>DOUBLE_TAP_DISTANCE)lastObjectTap=null;
      if(activePointers.has(e.pointerId))activePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointerMode==='pinch'&&activePointers.size>=2){const pts=[...activePointers.values()];const distance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);const midpoint={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};if(!pinchGestureMode&&pinchGestureStart){const zoomDelta=Math.abs(distance-pinchGestureStart.distance);const panDelta=Math.hypot(midpoint.x-pinchGestureStart.midpoint.x,midpoint.y-pinchGestureStart.midpoint.y);if(Math.max(zoomDelta,panDelta)>5)pinchGestureMode=zoomDelta>panDelta*1.15?'zoom':'pan';}if(pinchGestureMode==='zoom'&&pinchDistance>0)zoom=Math.max(0.25,Math.min(4,zoom*(distance/Math.max(1,pinchDistance))));else if(pinchGestureMode==='pan'&&pinchMidpoint)panCamera(midpoint.x-pinchMidpoint.x,midpoint.y-pinchMidpoint.y);pinchDistance=distance;pinchMidpoint=midpoint;}
      else if(pointerMode==='orbit'){
        const dx=e.clientX-pointerStart.x,dy=e.clientY-pointerStart.y;
        orbitYaw+=dx*0.006;orbitPitch=Math.max(-1.35,Math.min(1.35,orbitPitch+dy*0.006));pointerStart={x:e.clientX,y:e.clientY};
      }else if(pointerMode==='pan'){panCamera(e.clientX-pointerStart.x,e.clientY-pointerStart.y);pointerStart={x:e.clientX,y:e.clientY};}else if(pointerMode==='object-pending'&&dragInfo&&Math.hypot(e.clientX-pointerStart.x,e.clientY-pointerStart.y)>6){pointerMode='object';}else if(pointerMode==='object'&&dragInfo){
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
    const end=e=>{if(activePointers.has(e.pointerId)){if(pointerMode==='object-pending'||pointerMode==='locked-object'){lastObjectTap={ownerId:dragInfo?.ownerId||selectedOwnerId,time:Date.now(),x:e.clientX,y:e.clientY};}else if(pointerMode!=='double-tap')lastObjectTap=null;}activePointers.delete(e.pointerId);if(activePointers.size===1){const remaining=[...activePointers.values()][0];pointerMode='orbit';pointerStart={x:remaining.x,y:remaining.y};}else if(activePointers.size===0){pointerMode=null;dragInfo=null;pointerStart=null;pinchDistance=0;pinchMidpoint=null;pinchGestureStart=null;pinchGestureMode=null;}};
    canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
    canvas.addEventListener('wheel',e=>{zoom=Math.max(0.25,Math.min(4,zoom*Math.exp(e.deltaY*0.00075)));updateCamera();e.preventDefault();},{passive:false});
    canvas.addEventListener('contextmenu',e=>e.preventDefault());
  }
  function ensureRenderer() {
    if (renderer) return true;
    if (!window.THREE || !window.THREE.WebGLRenderer) return false;
    const T = window.THREE;
    renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
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
    hemisphereLight = new T.HemisphereLight(0xeaf2ff, 0x394150, 1.15);
    scene.add(hemisphereLight);
    keyLight = new T.DirectionalLight(0xfff1dc, 2.4);
    keyLight.position.set(5, 9, 6);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -24;
    keyLight.shadow.camera.right = 24;
    keyLight.shadow.camera.top = 24;
    keyLight.shadow.camera.bottom = -24;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 70;
    keyLight.shadow.camera.updateProjectionMatrix();
    keyLight.shadow.bias = -0.00015;
    keyLight.shadow.normalBias = 0.025;
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

  const CAMERA_CLEARANCE = 0.28;
  const CAMERA_MIN_DISTANCE = 0.42;

  function resolveCameraCollision(target, desiredPosition, excludedOwnerId) {
    if(!cameraCollisionRaycaster||!primitiveGroup||!modelGroup)return desiredPosition;
    const offset=desiredPosition.clone().sub(target);
    const distance=offset.length();
    if(distance<=CAMERA_MIN_DISTANCE)return desiredPosition;
    const direction=offset.multiplyScalar(1/distance);
    const worldUp=new window.THREE.Vector3(0,1,0);
    let right=new window.THREE.Vector3().crossVectors(direction,worldUp);
    if(right.lengthSq()<1e-8)right.set(1,0,0);
    else right.normalize();
    const up=new window.THREE.Vector3().crossVectors(right,direction).normalize();
    const side=0.22,vertical=0.16;
    const origins=[
      target.clone(),
      target.clone().addScaledVector(right,side),
      target.clone().addScaledVector(right,-side),
      target.clone().addScaledVector(up,vertical),
      target.clone().addScaledVector(up,-vertical)
    ];
    // Raycaster reads matrixWorld; refresh it after the runtime moved this frame's objects.
    primitiveGroup.updateMatrixWorld(true);
    modelGroup.updateMatrixWorld(true);
    let safeDistance=distance;
    const roots=[primitiveGroup,modelGroup];
    for(const origin of origins){
      cameraCollisionRaycaster.set(origin,direction);
      cameraCollisionRaycaster.near=0.04;
      cameraCollisionRaycaster.far=safeDistance;
      const hits=cameraCollisionRaycaster.intersectObjects(roots,true);
      const hit=hits.find(item=>{
        const ownerId=item.object?.userData?.ownerId;
        return ownerId===undefined||ownerId===null||ownerId!==excludedOwnerId;
      });
      if(hit){
        safeDistance=Math.min(safeDistance,Math.max(CAMERA_MIN_DISTANCE,hit.distance-CAMERA_CLEARANCE));
      }
    }
    return target.clone().addScaledVector(direction,safeDistance);
  }

  function getCameraBasis() {
    let direction;
    if(camera&&window.THREE){
      direction=new window.THREE.Vector3();
      camera.getWorldDirection(direction);
    }else{
      const offset=new window.THREE.Vector3(
        cameraBase[0]-cameraTarget[0],
        cameraBase[1]-cameraTarget[1],
        cameraBase[2]-cameraTarget[2]
      );
      offset.applyAxisAngle(new window.THREE.Vector3(0,1,0),orbitYaw);
      direction=offset.negate();
    }
    direction.y=0;
    if(direction.lengthSq()<1e-8)direction.set(0,0,-1);
    direction.normalize();
    return {
      forwardX:direction.x,
      forwardZ:direction.z,
      rightX:-direction.z,
      rightZ:direction.x
    };
  }

  function updateCamera(deltaTime = 1 / 60, excludedOwnerId = activeCameraOwnerId) {
    if (!renderer || !camera || !window.THREE) return;
    const T = window.THREE;
    const target = new T.Vector3(cameraTarget[0], cameraTarget[1], cameraTarget[2]).add(cameraPan || new T.Vector3());
    const offset = new T.Vector3(cameraBase[0], cameraBase[1], cameraBase[2]).sub(target).multiplyScalar(zoom);
    offset.applyAxisAngle(new T.Vector3(0, 1, 0), orbitYaw);
    const right = new T.Vector3(1, 0, 0).applyAxisAngle(new T.Vector3(0, 1, 0), orbitYaw);
    offset.applyAxisAngle(right, orbitPitch);
    const desiredPosition = target.clone().add(offset);
    if (!smoothedTarget || !smoothedPosition) {
      smoothedTarget = target.clone();
      smoothedPosition = desiredPosition.clone();
    }
    if (cameraSmoothing > 0) {
      const dt = Math.max(0, Math.min(0.1, Number(deltaTime) || 0));
      const alpha = 1 - Math.exp(-cameraSmoothing * dt);
      smoothedTarget.lerp(target, alpha);
      smoothedPosition.lerp(desiredPosition, alpha);
    } else {
      smoothedTarget.copy(target);
      smoothedPosition.copy(desiredPosition);
    }
    const collisionSafePosition=resolveCameraCollision(target,smoothedPosition,excludedOwnerId);
    camera.position.copy(collisionSafePosition);
    camera.lookAt(smoothedTarget);
    for(const instance of modelInstances.values()){
      if(!instance.lodLevels||instance.lodLevels.length<2)continue;
      const distance=camera.position.distanceTo(instance.root.position);
      const targetIndex=distance<25?0:distance<70?1:distance<150?2:3;
      const selected=instance.lodLevels[Math.min(targetIndex,instance.lodLevels.length-1)];
      if(instance.activeLOD===selected.level)continue;
      for(const level of instance.lodLevels){
        const visible=level.level===selected.level;
        for(const entry of level.entries)entry.object.visible=visible&&entry.visible;
      }
      instance.activeLOD=selected.level;
    }
    resize();
    renderer.render(scene, camera);
  }

  function refreshSelectionOutline() {
    if (!selectionGroup || !window.THREE) return;
    const canManipulate = selectedOwnerId
      && window.PStudioSceneInteraction?.isManipulationEnabled?.(selectedOwnerId) !== false;
    if (!selectedOwnerId || !primitiveGroup || !canManipulate) {
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
      case 'terrain': return ['terrain',n(d.width),n(d.depth),Math.max(2,Number(d.segments)||2),n(d.height)].join(':');
      case 'water': return ['water',n(d.width),n(d.depth)].join(':');
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
      case 'water': {const g=new T.PlaneGeometry(d.width,d.depth,32,32);g.rotateX(-Math.PI/2);return g;}
      case 'terrain': {
        const g=new T.BufferGeometry(),vertices=[],indices=[],segments=Math.max(2,Math.min(96,Math.floor(d.segments)||2));
        for(let iz=0;iz<=segments;iz++)for(let ix=0;ix<=segments;ix++){const x=(ix/segments-.5)*d.width,z=(iz/segments-.5)*d.depth;const y=d.height*(Math.sin(x*.18)*Math.cos(z*.16)*.5+Math.sin((x+z)*.07)*.15);vertices.push(x,y,z);}
        for(let iz=0;iz<segments;iz++)for(let ix=0;ix<segments;ix++){const a=iz*(segments+1)+ix,b=a+1,c=a+segments+1,e=c+1;indices.push(a,c,b,b,c,e);}
        g.setAttribute('position',new T.Float32BufferAttribute(vertices,3));g.setIndex(indices);g.computeVertexNormals();return g;
      }
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
    const materialDefaults=new Map();
    clone.userData.ownerId=ownerId;
    clone.traverse(object=>{
      object.userData.ownerId=ownerId;
      object.userData.modelRoot=clone;
      if(object.isMesh && object.material){
        object.castShadow=true;
        object.receiveShadow=true;
        const cloneMaterial=material=>{
          const copy=material.clone();
          materialDefaults.set(copy,{
            roughness:Number.isFinite(material.roughness)?material.roughness:0.72,
            metalness:Number.isFinite(material.metalness)?material.metalness:0.04
          });
          return copy;
        };
        object.material=Array.isArray(object.material)
          ? object.material.map(cloneMaterial)
          : cloneMaterial(object.material);
      }
    });
    const lodMap=new Map();
    clone.traverse(object=>{
      const match=String(object.name||'').match(/(?:^|[ _-])LOD([0-9]+)(?:$|[ _-])/i);
      if(!match)return;
      const level=Number(match[1]);
      if(!lodMap.has(level))lodMap.set(level,[]);
      lodMap.get(level).push({object,visible:object.visible});
    });
    const lodLevels=[...lodMap.entries()]
      .sort((a,b)=>a[0]-b[0])
      .map(([level,entries])=>({level,entries}));
    const mixer=asset.animations.length ? new T.AnimationMixer(clone) : null;
    const instance={key,ownerId,name,root:clone,mixer,animations:asset.animations,materialDefaults,lodLevels,activeLOD:null,activeClip:null,activeLoop:true,speed:1};
    modelInstances.set(key,instance);
    modelGroup.add(clone);
    return instance;
  }

  function applyModelMaterial(instance, state) {
    if(!instance?.materialDefaults)return;
    instance.root.traverse(object=>{
      if(!object.isMesh||!object.material)return;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials){
        const defaults=instance.materialDefaults.get(material);
        if(!defaults)continue;
        material.roughness=state?state.roughness:defaults.roughness;
        material.metalness=state?state.metalness:defaults.metalness;
      }
    });
  }

  function updateModelAnimation(instance, state, dt) {
    if(!instance.mixer) return;
    if(state.speed !== undefined) instance.speed=state.speed;
    if(state.blend){
      const findClip=name=>instance.animations.find(item=>item.name.toLowerCase()===String(name).toLowerCase())||instance.animations.find(item=>item.name.toLowerCase().includes(String(name).toLowerCase()));
      const clipA=findClip(state.blend.first),clipB=findClip(state.blend.second);
      if(clipA&&clipB){
        const signature=clipA.name+'|'+clipB.name;
        if(instance.activeBlend!==signature){for(const action of instance.blendActions||[])action.fadeOut(0.12);const actionA=instance.mixer.clipAction(clipA),actionB=instance.mixer.clipAction(clipB);actionA.reset().setLoop(window.THREE.LoopRepeat,Infinity).setEffectiveWeight(1-state.blend.weight).fadeIn(0.12).play();actionB.reset().setLoop(window.THREE.LoopRepeat,Infinity).setEffectiveWeight(state.blend.weight).fadeIn(0.12).play();instance.blendActions=[actionA,actionB];instance.activeBlend=signature;instance.activeClip=null;}
        instance.blendActions[0].setEffectiveWeight(1-state.blend.weight);instance.blendActions[1].setEffectiveWeight(state.blend.weight);
      }
    }else if(instance.activeBlend){for(const action of instance.blendActions||[])action.fadeOut(0.12);instance.activeBlend=null;instance.blendActions=[];}
    if(state.stop){
      instance.mixer.stopAllAction();
      instance.activeClip=null;instance.activeBlend=null;instance.blendActions=[];
    }
    if(state.blend){
      instance.mixer.timeScale=instance.speed;
      instance.mixer.update(Math.max(0,Math.min(0.1,Number(dt)||0)));
      return;
    }
    if(state.clipName){
      const requested=state.clipName.toLowerCase();
      const clip=instance.animations.find(item=>item.name.toLowerCase()===requested)
        || instance.animations.find(item=>item.name.toLowerCase().includes(requested));
      const existingAction=clip ? instance.mixer.existingAction(clip) : null;
      const completedOneShot=!!(clip && state.loop===false && existingAction && !existingAction.isRunning());
      if(clip && (instance.activeClip!==clip.name || instance.activeLoop!==state.loop || completedOneShot)){
        const previousClip=instance.animations.find(item=>item.name===instance.activeClip);
        const previousAction=previousClip ? instance.mixer.existingAction(previousClip) : null;
        const action=instance.mixer.clipAction(clip);
        action.reset();
        action.enabled=true;
        action.setEffectiveWeight(1);
        action.setLoop(state.loop===false ? window.THREE.LoopOnce : window.THREE.LoopRepeat, state.loop===false ? 1 : Infinity);
        action.clampWhenFinished=state.loop===false;
        if(previousAction && previousAction!==action){
          if(previousAction.isRunning()){
            previousAction.crossFadeTo(action,0.18,false);
          }else{
            previousAction.stopFading();
            previousAction.fadeOut(0.12);
            action.fadeIn(0.12);
          }
        }else{
          action.fadeIn(0.12);
        }
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
    instance.root.traverse(object=>{
      if(!object.isMesh||!object.material)return;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      materials.forEach(material=>material.dispose());
    });
    modelInstances.delete(key);
  }

  function render(commandsByObject) {
    if (!ensureRenderer()) throw new Error('Three.js could not be loaded. The 3D view needs an internet connection.');
    const T = window.THREE;
    lastCommands=commandsByObject;
    const usedMeshes=new Set(),usedGrids=new Set(),usedModels=new Set(),usedLights=new Set();
    let cameraCommand=null,environment=null,cameraOwnerId=null;
    let defaultBackground=0x171d26;
    if(scene.background) scene.background.set(defaultBackground);
    scene.fog=null;
    if(hemisphereLight) hemisphereLight.intensity=1.15;
    if(keyLight){keyLight.position.set(5,9,6);keyLight.intensity=2.4;}
    for (const [ownerId,list] of commandsByObject.entries()) {
      let ownerMaterial=null;
      for (let commandIndex=0;commandIndex<list.length;commandIndex++) {
        const d=list[commandIndex];
        const key=String(ownerId)+':'+commandIndex;
        if (d.type==='camera') { cameraCommand=d; cameraOwnerId=d.cameraOwnerId??ownerId; continue; }
        if (d.type==='environment') { environment=Object.assign(environment||{},d); continue; }
        if(d.type==='particles'){
          const burstKey=String(d.burstId);if(!particleBursts.has(burstKey)){
            const count=Math.max(1,Math.min(400,Number(d.count)||1)),positions=new Float32Array(count*3),velocities=[];
            for(let i=0;i<count;i++){const theta=Math.random()*Math.PI*2,u=Math.random()*2-1,speed=(0.25+Math.random()*0.75)*(Number(d.speed)||1);positions[i*3]=Number(d.x)||0;positions[i*3+1]=Number(d.y)||0;positions[i*3+2]=Number(d.z)||0;velocities.push([Math.cos(theta)*Math.sqrt(1-u*u)*speed,(u*0.8+0.35)*speed,Math.sin(theta)*Math.sqrt(1-u*u)*speed]);}
            const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.BufferAttribute(positions,3));const material=new T.PointsMaterial({color:d.color||'#ffffff',size:0.09,transparent:true,opacity:1,depthWrite:false});const points=new T.Points(geometry,material);primitiveGroup.add(points);particleBursts.set(burstKey,{points,velocities,age:0,lifetime:Number(d.lifetime)||1});
          }continue;
        }
        if(d.type==='light'){
          let light=dynamicLights.get(key);
          if(!light||light.userData.kind!==d.kind){if(light){scene.remove(light);if(light.target)scene.remove(light.target);}light=d.kind==='spot'?new T.SpotLight(d.color||0xffffff,Number(d.intensity)||0,Number(d.distance)||0,Number(d.angle)||Math.PI/5,0.35,1):new T.PointLight(d.color||0xffffff,Number(d.intensity)||0,Number(d.distance)||0,2);light.userData.kind=d.kind;light.castShadow=false;dynamicLights.set(key,light);scene.add(light);if(light.target)scene.add(light.target);}
          light.position.set(Number(d.x)||0,Number(d.y)||0,Number(d.z)||0);light.color.set(d.color||0xffffff);light.intensity=Math.max(0,Number(d.intensity)||0);if(d.distance!==undefined)light.distance=Math.max(0,Number(d.distance)||0);if(d.angle!==undefined&&light.angle!==undefined)light.angle=Number(d.angle);
          if(light.target){light.target.position.set(Number(d.targetX)||0,Number(d.targetY)||0,Number(d.targetZ)||0);light.target.updateMatrixWorld();}
          usedLights.add(key);continue;
        }
        if (d.type==='material') { ownerMaterial={roughness:Math.max(0,Math.min(1,Number(d.roughness)||0)),metalness:Math.max(0,Math.min(1,Number(d.metalness)||0))}; continue; }
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
          applyModelMaterial(instance,ownerMaterial);
          const animState={loop:true};
          for(const item of list){
            if(item.type==='animation'){
              if(item.stop)animState.stop=true;
              if(item.clipName!==undefined){animState.clipName=item.clipName;animState.loop=item.loop!==false;}
              if(item.speed!==undefined)animState.speed=Number(item.speed);
            }else if(item.type==='animation_blend'){
              animState.blend={first:item.first,second:item.second,weight:Math.max(0,Math.min(1,Number(item.weight)||0))};
            }else if(item.type==='locomotion'){
              animState.locomotion=item;
            }
          }
          if(animState.locomotion&&!animState.clipName){
            const locomotion=animState.locomotion;
            const previousClip=instance.animations.find(item=>item.name===instance.activeClip);
            const previousAction=previousClip?instance.mixer?.existingAction(previousClip):null;
            const oneShotPlaying=instance.activeLoop===false&&previousAction?.isRunning();
            if(oneShotPlaying){
              animState.clipName=instance.activeClip;
              animState.loop=false;
            }else{
              const landSequence=Number(locomotion.landSequence)||0;
              if(locomotion.land&&landSequence>0&&landSequence!==instance.lastLandSequence){
                animState.clipName=locomotion.land;
                animState.loop=false;
                instance.lastLandSequence=landSequence;
              }else{
                const speed=Math.max(0,Number(locomotion.speed)||0);
                const firstAvailable=(...names)=>names.find(name=>typeof name==='string'&&name.trim().length>0)||'';
                if(!locomotion.grounded){
                  animState.clipName=(Number(locomotion.velocityY)||0)>0.12
                    ?firstAvailable(locomotion.jump,locomotion.fall,locomotion.idle)
                    :firstAvailable(locomotion.fall,locomotion.jump,locomotion.idle);
                }else if(speed>3.8){
                  animState.clipName=firstAvailable(locomotion.run,locomotion.walk,locomotion.idle);
                }else if(speed>0.18){
                  animState.clipName=firstAvailable(locomotion.walk,locomotion.run,locomotion.idle);
                }else{
                  animState.clipName=firstAvailable(locomotion.idle,locomotion.walk,locomotion.run);
                }
                animState.loop=true;
              }
            }
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
          const material=d.type==='water'?new T.MeshPhysicalMaterial({color:d.color||'#3b82f6',roughness:0.12,metalness:0.25,transparent:true,opacity:Number(d.opacity)||0.65,clearcoat:1,clearcoatRoughness:0.08,side:T.DoubleSide}):new T.MeshStandardMaterial({color:d.color||'#d1d5db',roughness:d.type==='terrain'?0.92:0.72,metalness:0.04,side:d.type==='terrain'?T.DoubleSide:T.FrontSide});
          mesh=new T.Mesh(geometry,material);
          mesh.castShadow = d.type !== 'plane';
          mesh.receiveShadow = true;
          mesh.userData.signature=signature;
          meshCache.set(key,mesh);
          primitiveGroup.add(mesh);
        }
        if(d.color&&mesh.material.color.getStyle()!==new T.Color(d.color).getStyle())mesh.material.color.set(d.color);
        if(d.type!=='water'){mesh.material.roughness=ownerMaterial?ownerMaterial.roughness:(d.type==='terrain'?0.92:0.72);mesh.material.metalness=ownerMaterial?ownerMaterial.metalness:0.04;}else{mesh.material.opacity=Number(d.opacity)||0.65;}
        mesh.userData.ownerId=ownerId;
        mesh.position.set(Number(d.x)||0,(Number(d.y)||0)+(d.type==='water'?Math.sin((performance.now?.()||0)*0.0015)*0.025:0),Number(d.z)||0);
        const baseRotationX=d.type==='plane'?-Math.PI/2:0;
        mesh.rotation.set(baseRotationX+(Number(d.rotationX)||0),Number(d.rotationY)||0,Number(d.rotationZ)||0);
        usedMeshes.add(key);
      }
    }
    for(const [key,mesh] of meshCache){if(!usedMeshes.has(key)){disposeMesh(mesh);meshCache.delete(key);}}
    for(const [key,effect] of particleBursts){effect.age+=Math.max(0,Math.min(0.1,Number([...commandsByObject.values()].flat().find(d=>d.type==='particles')?.dt)||1/60));const positions=effect.points.geometry.attributes.position;for(let i=0;i<effect.velocities.length;i++){const ageStep=Math.max(0,Math.min(0.1,Number([...commandsByObject.values()].flat().find(d=>d.type==='particles')?.dt)||1/60));effect.velocities[i][1]-=2.2*ageStep;positions.array[i*3]+=effect.velocities[i][0]*ageStep;positions.array[i*3+1]+=effect.velocities[i][1]*ageStep;positions.array[i*3+2]+=effect.velocities[i][2]*ageStep;}positions.needsUpdate=true;effect.points.material.opacity=Math.max(0,1-effect.age/effect.lifetime);if(effect.age>=effect.lifetime){primitiveGroup.remove(effect.points);effect.points.geometry.dispose();effect.points.material.dispose();particleBursts.delete(key);}}
    for(const [key,light] of dynamicLights){if(!usedLights.has(key)){scene.remove(light);if(light.target)scene.remove(light.target);dynamicLights.delete(key);}}
    for(const [key,grid] of gridCache){if(!usedGrids.has(key)){gridGroup.remove(grid);grid.geometry.dispose();grid.material.dispose();gridCache.delete(key);}}
    for(const key of modelInstances.keys()){if(!usedModels.has(key))removeModelInstance(key);}
    if(environment){
      if(environment.background&&scene.background)scene.background.set(environment.background);
      if(environment.environmentSky&&environment.environmentGround){
        const signature=environment.environmentSky+'|'+environment.environmentGround;
        if(signature!==environmentSignature){const c=document.createElement('canvas');c.width=512;c.height=256;const cx=c.getContext('2d'),g=cx.createLinearGradient(0,0,0,256);g.addColorStop(0,environment.environmentSky);g.addColorStop(1,environment.environmentGround);cx.fillStyle=g;cx.fillRect(0,0,512,256);environmentTexture?.dispose?.();environmentTexture=new T.CanvasTexture(c);environmentTexture.mapping=T.EquirectangularReflectionMapping;environmentTexture.colorSpace=T.SRGBColorSpace;environmentTexture.needsUpdate=true;scene.environment=environmentTexture;environmentSignature=signature;}
        if('environmentIntensity' in scene)scene.environmentIntensity=Number(environment.environmentIntensity)||1;
      }
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
    cameraSmoothing = cameraCommand ? Math.max(0, Math.min(30, Number(cameraCommand.smoothing) || 0)) : 0;
    activeCameraOwnerId=cameraOwnerId;
    if(!cameraSmoothing){smoothedTarget=null;smoothedPosition=null;}
    refreshSelectionOutline();
    updateCamera(cameraCommand?.dt ?? 1 / 60,cameraOwnerId);
  }
  function clear() {
    if (!renderer) return;
    activeCameraOwnerId=null;
    for(const key of [...modelInstances.keys()])removeModelInstance(key);
    for(const mesh of meshCache.values())disposeMesh(mesh);
    meshCache.clear();
    for(const grid of gridCache.values()){gridGroup.remove(grid);grid.geometry.dispose();grid.material.dispose();}
    gridCache.clear();
    disposeGroup(selectionGroup);
    for(const effect of particleBursts.values()){primitiveGroup?.remove(effect.points);effect.points.geometry.dispose();effect.points.material.dispose();}particleBursts.clear();
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
  window.PStudio3D = {
    render,
    clear,
    setSelected: id => { selectedOwnerId = id || null; refreshSelectionOutline(); if (renderer && scene && camera) renderer.render(scene, camera); },
    getCameraBasis,
    isAvailable: () => !!window.THREE,
    getModelError: name => modelLoadErrors.get(name) || null,
    invalidateAsset
  };
  window.addEventListener('resize', resize);
})();
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
  let gridGroup = null;
  let lastSize = { width: 0, height: 0 };
  let orbitYaw = 0, orbitPitch = 0, zoom = 1, pointerMode = null, pointerStart = null, dragInfo = null;
  let raycaster = null, pointerNdc = null, controlsReady = false;
  const activePointers = new Map();
  let pinchDistance = 0;
  let cameraTarget = [0, 0, 0];
  let cameraBase = [6, 5, 8];

  function setupControls() {
    if (controlsReady) return;
    controlsReady = true;
    raycaster = new window.THREE.Raycaster(); pointerNdc = new window.THREE.Vector2();
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', e => {
      if (!renderer || !camera) return;
      activePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(activePointers.size===2){const pts=[...activePointers.values()];pinchDistance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);pointerMode='pinch';dragInfo=null;try{canvas.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault();return;}
      const rect=canvas.getBoundingClientRect();
      pointerNdc.set(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
      raycaster.setFromCamera(pointerNdc,camera);
      const hit=raycaster.intersectObjects(primitiveGroup.children,false).find(h=>h.object.userData.ownerId);
      pointerStart={x:e.clientX,y:e.clientY};
      if(hit){
        const mesh=hit.object,ownerId=mesh.userData.ownerId;
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
      if(pointerMode==='pinch'&&activePointers.size>=2){const pts=[...activePointers.values()];const distance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);if(pinchDistance>0)zoom=Math.max(0.25,Math.min(4,zoom*(pinchDistance/Math.max(1,distance))));pinchDistance=distance;}
      else if(pointerMode==='orbit'){
        const dx=e.clientX-pointerStart.x,dy=e.clientY-pointerStart.y;
        orbitYaw+=dx*0.008;orbitPitch=Math.max(-1.35,Math.min(1.35,orbitPitch+dy*0.008));pointerStart={x:e.clientX,y:e.clientY};
      }else if(pointerMode==='object'&&dragInfo){
        const rect=canvas.getBoundingClientRect();pointerNdc.set(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);raycaster.setFromCamera(pointerNdc,camera);
        const point=new window.THREE.Vector3();
        if(raycaster.ray.intersectPlane(dragInfo.plane,point)){
          const pos=dragInfo.startPosition.clone().add(point.sub(dragInfo.startPoint));
          dragInfo.mesh.position.copy(pos);
          window.PStudioSceneInteraction?.moveWorld?.(dragInfo.ownerId,pos.x,pos.y,pos.z);
          renderer.render(scene,camera);
        }
      }
      if(pointerMode==='orbit' || pointerMode==='pinch') updateCamera();
      e.preventDefault();
    });
    const end=e=>{activePointers.delete(e.pointerId);if(activePointers.size===1){const remaining=[...activePointers.values()][0];pointerMode='orbit';pointerStart={x:remaining.x,y:remaining.y};}else if(activePointers.size===0){pointerMode=null;dragInfo=null;pointerStart=null;pinchDistance=0;}};
    canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
    canvas.addEventListener('wheel',e=>{zoom=Math.max(0.25,Math.min(4,zoom*Math.exp(e.deltaY*0.001)));updateCamera();e.preventDefault();},{passive:false});
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
    gridGroup = new T.Group();
    scene.add(primitiveGroup, gridGroup);
    scene.add(new T.HemisphereLight(0xffffff, 0x394150, 2.0));
    const key = new T.DirectionalLight(0xffffff, 2.2);
    key.position.set(5, 8, 6);
    scene.add(key);
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

  function updateCamera() {
    if (!renderer || !camera || !window.THREE) return;
    const T = window.THREE;
    const target = new T.Vector3(cameraTarget[0], cameraTarget[1], cameraTarget[2]);
    const offset = new T.Vector3(cameraBase[0], cameraBase[1], cameraBase[2]).sub(target).multiplyScalar(zoom);
    offset.applyAxisAngle(new T.Vector3(0, 1, 0), orbitYaw);
    const right = new T.Vector3(1, 0, 0).applyAxisAngle(new T.Vector3(0, 1, 0), orbitYaw);
    offset.applyAxisAngle(right, orbitPitch);
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
    resize();
    renderer.render(scene, camera);
  }

  function render(commandsByObject) {
    if (!ensureRenderer()) throw new Error('Three.js could not be loaded. The 3D view needs an internet connection.');
    const T = window.THREE;
    disposeGroup(primitiveGroup);
    disposeGroup(gridGroup);
    let cameraCommand = null;
    for (const [ownerId,list] of commandsByObject.entries()) {
      for (const d of list) {
        if (d.type === 'camera') { cameraCommand = d; continue; }
        if (d.type === 'grid') {
          const grid = new T.GridHelper(d.size, d.divisions, 0x7b8797, 0x394352);
          grid.position.y = 0;
          gridGroup.add(grid);
          continue;
        }
        let geometry;
        if (d.type === 'cube') geometry = new T.BoxGeometry(d.size, d.size, d.size);
        else if (d.type === 'box') geometry = new T.BoxGeometry(d.width, d.height, d.depth);
        else if (d.type === 'sphere') geometry = new T.SphereGeometry(d.radius, 24, 16);
        else continue;
        const material = new T.MeshStandardMaterial({ color: d.color || '#d1d5db', roughness: 0.72, metalness: 0.04 });
        const mesh = new T.Mesh(geometry, material);
        mesh.userData.ownerId = ownerId;
        mesh.position.set(d.x, d.y, d.z);
        if (d.type === 'cube' || d.type === 'box') mesh.rotation.set(d.rotationX || 0, d.rotationY || 0, d.rotationZ || 0);
        primitiveGroup.add(mesh);
      }
    }
    cameraTarget = cameraCommand
      ? [cameraCommand.targetX, cameraCommand.targetY, cameraCommand.targetZ]
      : [0, 0, 0];
    cameraBase = cameraCommand
      ? [cameraCommand.x, cameraCommand.y, cameraCommand.z]
      : [6, 5, 8];
    updateCamera();
  }

  function clear() {
    if (!renderer) return;
    disposeGroup(primitiveGroup);
    disposeGroup(gridGroup);
    renderer.render(scene, camera);
  }

  window.PStudio3D = { render, clear, isAvailable: () => !!window.THREE };
  window.addEventListener('resize', resize);
})();
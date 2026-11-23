/* PStudio Atmosphere: analytic Rayleigh/Mie sky model and lightweight PMREM source. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.PStudioAtmosphere=api;
})(typeof window!=='undefined'?window:(typeof globalThis!=='undefined'?globalThis:null),function(){
  'use strict';
  const RAD=Math.PI/180;
  const PRESET_DEFAULTS=Object.freeze({
    day:Object.freeze({elevation:55,azimuth:57,turbidity:2.4,cloudDensity:0.28}),
    dusk:Object.freeze({elevation:7,azimuth:265,turbidity:4.5,cloudDensity:0.2}),
    night:Object.freeze({elevation:-7,azimuth:57,turbidity:3,cloudDensity:0.025}),
    studio:Object.freeze({elevation:45,azimuth:45,turbidity:2,cloudDensity:0})
  });
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const finite=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;
  const wrapDegrees=value=>((value%360)+360)%360;
  function normalize(value={},presetName='day'){
    const source=value&&typeof value==='object'?value:{};
    const preset=String(source.preset||presetName||'day').trim().toLowerCase();
    const defaults=PRESET_DEFAULTS[preset]||PRESET_DEFAULTS.day;
    return Object.freeze({
      elevation:clamp(finite(source.elevation,defaults.elevation),-10,90),
      azimuth:wrapDegrees(finite(source.azimuth,defaults.azimuth)),
      turbidity:clamp(finite(source.turbidity,defaults.turbidity),1,10),
      cloudDensity:clamp(finite(source.cloudDensity,defaults.cloudDensity),0,1)
    });
  }
  function sunDirection(value){
    const settings=normalize(value);
    const elevation=settings.elevation*RAD,azimuth=settings.azimuth*RAD,ring=Math.cos(elevation);
    return [Math.sin(azimuth)*ring,Math.sin(elevation),Math.cos(azimuth)*ring];
  }
  function airMass(heightCosine){
    const zenith=Math.acos(clamp(heightCosine,-0.999,1));
    const degrees=zenith/RAD;
    const denominator=Math.cos(zenith)+0.15*Math.pow(Math.max(0.1,93.885-degrees),-1.253);
    return 1/Math.max(0.035,denominator);
  }
  function computeSkyColor(direction,value){
    const settings=normalize(value),dir=direction||[0,1,0],sun=sunDirection(settings);
    const x=finite(dir[0],0),y=finite(dir[1],1),z=finite(dir[2],0);
    const length=Math.max(1e-6,Math.hypot(x,y,z)),dx=x/length,dy=y/length,dz=z/length;
    const mu=clamp(dx*sun[0]+dy*sun[1]+dz*sun[2],-1,1);
    const mass=airMass(dy),t=settings.turbidity;
    const betaR=[0.18,0.42,1.0],betaM=0.009*t;
    const phaseR=0.75*(1+mu*mu),g=0.76;
    const phaseM=(1-g*g)/Math.pow(Math.max(0.035,1+g*g-2*g*mu),1.5);
    const trans=betaR.map(beta=>Math.exp(-mass*(beta*0.38+betaM*0.12)));
    const color=[
      0.025+betaR[0]*(1-trans[0])*phaseR*1.6,
      0.07+betaR[1]*(1-trans[1])*phaseR*1.6,
      0.16+betaR[2]*(1-trans[2])*phaseR*1.6
    ];
    const mie=(1-Math.exp(-mass*betaM*0.11))*phaseM*0.028*t;
    color[0]+=mie;color[1]+=mie*0.78;color[2]+=mie*0.56;
    const horizon=Math.pow(1-clamp(dy,0,1),2);
    const warm=clamp((t-1)/9,0,1);
    color[0]+=horizon*(0.13+warm*0.2);
    color[1]+=horizon*(0.075+warm*0.075);
    color[2]+=horizon*(0.035+warm*0.02);
    const sunMass=airMass(Math.max(0.025,sun[1]));
    const sunTrans=Math.exp(-sunMass*(0.38*0.18+betaM*0.12));
    const disk=clamp((mu-Math.cos(0.00465))/0.000035,0,1);
    const halo=Math.pow(Math.max(mu,0),48)*0.34;
    const diskGain=disk*sunTrans*9+halo;
    color[0]+=diskGain;
    color[1]+=diskGain*(0.82-0.18*warm);
    color[2]+=diskGain*(0.62-0.36*warm);
    if(dy<0){
      const ground=clamp((-dy)*2.5,0,1);
      color[0]=color[0]*(1-ground)+0.045*ground;
      color[1]=color[1]*(1-ground)+0.052*ground;
      color[2]=color[2]*(1-ground)+0.065*ground;
    }
    return color.map(channel=>clamp(channel,0,16));
  }
  function sunlight(value){
    const settings=normalize(value),sun=sunDirection(settings),elevation=clamp((settings.elevation+8)/65,0,1);
    const warm=clamp((settings.turbidity-1)/9,0,1)*(1-elevation)*0.75;
    return {direction:sun,color:[1,1-warm*0.22,1-warm*0.48],intensity:0.15+1.9*elevation};
  }
  function updateSkyMaterial(material,value){
    if(!material?.uniforms)return false;
    const settings=normalize(value),light=sunlight(settings);
    const direction=material.uniforms.uSunDirection?.value;
    if(direction?.set)direction.set(...light.direction);
    if(material.uniforms.uTurbidity)material.uniforms.uTurbidity.value=settings.turbidity;
    if(material.uniforms.uSunIntensity)material.uniforms.uSunIntensity.value=light.intensity;
    return true;
  }
  function createSkyMesh(Three,value){
    if(!Three?.ShaderMaterial||!Three?.SphereGeometry||!Three?.Mesh)return null;
    const settings=normalize(value);
    const light=sunlight(settings);
    const material=new Three.ShaderMaterial({
      uniforms:{
        uSunDirection:{value:new Three.Vector3(...light.direction)},
        uTurbidity:{value:settings.turbidity},
        uSunIntensity:{value:light.intensity}
      },
      vertexShader:[
        'varying vec3 vPStudioSkyDirection;',
        'void main(){',
        'vec4 worldPosition=modelMatrix*vec4(position,1.0);',
        'vPStudioSkyDirection=normalize(worldPosition.xyz-cameraPosition);',
        'vec4 clip=projectionMatrix*viewMatrix*worldPosition;',
        'gl_Position=clip;gl_Position.z=gl_Position.w;',
        '}'
      ].join('\\n'),
      fragmentShader:[
        'uniform vec3 uSunDirection;uniform float uTurbidity;uniform float uSunIntensity;',
        'varying vec3 vPStudioSkyDirection;',
        'float pStudioAirMass(float cosineZenith){float zenith=acos(clamp(cosineZenith,-.999,1.0));float zenithDegrees=degrees(zenith);return 1.0/max(.035,cos(zenith)+.15*pow(max(.1,93.885-zenithDegrees),-1.253));}',
        'void main(){',
        'vec3 ray=normalize(vPStudioSkyDirection);vec3 sun=normalize(uSunDirection);',
        'float mu=clamp(dot(ray,sun),-1.0,1.0);float mass=pStudioAirMass(ray.y);',
        'vec3 betaR=vec3(.18,.42,1.0);float betaM=.009*uTurbidity;',
        'vec3 trans=exp(-mass*(betaR*.38+vec3(betaM*.12)));',
        'float phaseR=.75*(1.0+mu*mu);float g=.76;',
        'float phaseM=(1.0-g*g)/pow(max(.035,1.0+g*g-2.0*g*mu),1.5);',
        'vec3 sky=vec3(.025,.07,.16)+betaR*(1.0-trans)*phaseR*1.6;',
        'float mie=(1.0-exp(-mass*betaM*.11))*phaseM*.028*uTurbidity;',
        'sky+=vec3(mie,mie*.78,mie*.56);',
        'float horizon=pow(1.0-clamp(ray.y,0.0,1.0),2.0);',
        'float warm=clamp((uTurbidity-1.0)/9.0,0.0,1.0);',
        'sky+=horizon*vec3(.13+warm*.2,.075+warm*.075,.035+warm*.02);',
        'float sunMass=pStudioAirMass(max(.025,sun.y));',
        'float sunTrans=exp(-sunMass*(.38*.18+betaM*.12));',
        'float sunDisk=smoothstep(cos(.0049),cos(.0042),mu)*sunTrans*uSunIntensity*4.8;',
        'float sunHalo=pow(max(mu,0.0),48.0)*.34*uSunIntensity;',
        'sky+=vec3(sunDisk+sunHalo,(sunDisk+sunHalo)*(.82-.18*warm),(sunDisk+sunHalo)*(.62-.36*warm));',
        'if(ray.y<0.0){float ground=clamp(-ray.y*2.5,0.0,1.0);sky=mix(sky,vec3(.045,.052,.065),ground);}',
        'gl_FragColor=vec4(max(sky,vec3(0.0)),1.0);',
        '#include <tonemapping_fragment>',
        '#include <colorspace_fragment>',
        '}'
      ].join('\\n'),
      side:Three.BackSide,
      depthWrite:false,
      depthTest:false,
      toneMapped:true
    });
    const mesh=new Three.Mesh(new Three.SphereGeometry(1450,48,24),material);
    mesh.name='PStudioAtmosphereSky';
    mesh.frustumCulled=false;
    mesh.renderOrder=-1000;
    mesh.userData.pstudioAtmosphereSky=true;
    return mesh;
  }
  function linearToSrgb(value){
    const channel=clamp(value,0,1);
    return channel<=0.0031308?channel*12.92:1.055*Math.pow(channel,1/2.4)-0.055;
  }
  function createEnvironmentTexture(Three,value,width=512,height=256){
    if(!Three?.CanvasTexture||typeof document==='undefined')return null;
    const settings=normalize(value),canvas=document.createElement('canvas');
    canvas.width=Math.max(64,Math.floor(width));canvas.height=Math.max(32,Math.floor(height));
    const context=canvas.getContext('2d');
    if(!context)return null;
    const image=context.createImageData(canvas.width,canvas.height),pixels=image.data;
    for(let y=0;y<canvas.height;y++){
      const theta=(y+0.5)/canvas.height*Math.PI,sinTheta=Math.sin(theta),cosTheta=Math.cos(theta);
      for(let x=0;x<canvas.width;x++){
        const phi=(x+0.5)/canvas.width*Math.PI*2;
        const direction=[sinTheta*Math.sin(phi),cosTheta,sinTheta*Math.cos(phi)];
        const color=computeSkyColor(direction,settings),index=(y*canvas.width+x)*4;
        pixels[index]=Math.round(linearToSrgb(color[0])*255);
        pixels[index+1]=Math.round(linearToSrgb(color[1])*255);
        pixels[index+2]=Math.round(linearToSrgb(color[2])*255);
        pixels[index+3]=255;
      }
    }
    context.putImageData(image,0,0);
    const texture=new Three.CanvasTexture(canvas);
    texture.mapping=Three.EquirectangularReflectionMapping;
    texture.colorSpace=Three.SRGBColorSpace;
    texture.generateMipmaps=true;
    texture.minFilter=Three.LinearMipmapLinearFilter;
    texture.magFilter=Three.LinearFilter;
    texture.needsUpdate=true;
    return texture;
  }
  return Object.freeze({
    PRESET_DEFAULTS,normalize,sunDirection,computeSkyColor,sunlight,
    createSkyMesh,updateSkyMaterial,createEnvironmentTexture
  });
});

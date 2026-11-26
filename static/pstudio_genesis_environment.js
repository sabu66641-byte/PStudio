/* GENESIS shared environment state: deterministic time, weather, wind and sky radiance. */
(function(root,factory){
  'use strict';
  const api=factory(()=>root?.PStudioSceneEnvironment||null);
  if(root)root.PStudioGenesisEnvironment=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:(typeof globalThis!=='undefined'?globalThis:null),function(getPresetApi){
  'use strict';

  const clamp=(value,min,max,fallback=0)=>{
    const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;
  };
  const wrapHours=value=>((clamp(value,0,24,12)%24)+24)%24;
  const smoothstep=value=>{const t=clamp(value,0,1,0);return t*t*(3-2*t);};
  const normalize2=(x,z,fallback=[1,0])=>{
    let a=Number(x),b=Number(z);
    if(!Number.isFinite(a)||!Number.isFinite(b)){a=fallback[0];b=fallback[1];}
    const length=Math.hypot(a,b);
    return length>1e-6?[a/length,b/length]:fallback.slice();
  };
  const normalize3=(x,y,z,fallback=[0,1,0])=>{
    let a=Number(x),b=Number(y),c=Number(z);
    if(![a,b,c].every(Number.isFinite)){[a,b,c]=fallback;}
    const length=Math.hypot(a,b,c);
    return length>1e-6?[a/length,b/length,c/length]:fallback.slice();
  };
  const colorBytes=value=>{
    const text=String(value||'#ffffff').trim().replace(/^#/,'');
    if(/^[0-9a-f]{3}$/i.test(text))return text.split('').map(ch=>parseInt(ch+ch,16));
    if(/^[0-9a-f]{6}$/i.test(text))return [0,2,4].map(i=>parseInt(text.slice(i,i+2),16));
    return [255,255,255];
  };
  const linear=value=>{const c=value/255;return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4);};
  const srgb=value=>Math.round(255*(value<=0.0031308?value*12.92:1.055*Math.pow(Math.max(0,value),1/2.4)-0.055));
  const mixColor=(a,b,t)=>{
    const x=colorBytes(a),y=colorBytes(b);
    return '#'+x.map((v,i)=>srgb(linear(v)+(linear(y[i])-linear(v))*t).toString(16).padStart(2,'0')).join('');
  };
  const mix=(a,b,t)=>Number(a)+(Number(b)-Number(a))*t;
  const WEATHER=Object.freeze({
    clear:Object.freeze({cloudDensity:0,cloudCoverage:0,fogDensity:0,fogFar:1,sun:1,rain:0,wetness:0,wind:0}),
    cloudy:Object.freeze({cloudDensity:.18,cloudCoverage:.22,fogDensity:.00025,fogFar:.93,sun:.88,rain:0,wetness:.04,wind:.18}),
    overcast:Object.freeze({cloudDensity:.36,cloudCoverage:.39,fogDensity:.0005,fogFar:.82,sun:.64,rain:0,wetness:.08,wind:.38}),
    rain:Object.freeze({cloudDensity:.30,cloudCoverage:.40,fogDensity:.0010,fogFar:.70,sun:.48,rain:.92,wetness:.82,wind:.58}),
    storm:Object.freeze({cloudDensity:.48,cloudCoverage:.48,fogDensity:.0017,fogFar:.58,sun:.26,rain:1,wetness:1,wind:1.05})
  });
  const ANCHORS=Object.freeze([
    Object.freeze({hour:0,preset:'night'}),
    Object.freeze({hour:5.5,preset:'day'}),
    Object.freeze({hour:16.5,preset:'day'}),
    Object.freeze({hour:19,preset:'dusk'}),
    Object.freeze({hour:21,preset:'night'}),
    Object.freeze({hour:24,preset:'night'})
  ]);
  const COLOR_KEYS=new Set(['skyTop','skyMid','horizon','ground','fogColor','lightColor','hemisphereSky','hemisphereGround','sunColor','atmosphereSunColor','moonColor']);
  const EXCLUDED_KEYS=new Set(['name','label']);

  function profileForTime(hour){
    const presets=getPresetApi();
    const fallback=name=>presets?.getPreset?.(name)||({name});
    const time=wrapHours(hour);
    let left=ANCHORS[0],right=ANCHORS[ANCHORS.length-1];
    for(let i=0;i<ANCHORS.length-1;i++){
      if(time>=ANCHORS[i].hour&&time<=ANCHORS[i+1].hour){left=ANCHORS[i];right=ANCHORS[i+1];break;}
    }
    const span=Math.max(1e-6,right.hour-left.hour);
    const raw=clamp((time-left.hour)/span,0,1,0);
    const t=smoothstep(raw);
    const a=fallback(left.preset),b=fallback(right.preset),result={};
    for(const key of new Set([...Object.keys(a),...Object.keys(b)])){
      if(EXCLUDED_KEYS.has(key))continue;
      const av=a[key],bv=b[key];
      if(COLOR_KEYS.has(key)&&typeof av==='string'&&typeof bv==='string')result[key]=mixColor(av,bv,t);
      else if(Number.isFinite(Number(av))&&Number.isFinite(Number(bv)))result[key]=mix(av,bv,t);
      else result[key]=t<.5?av:bv;
    }
    result.name=t<.5?left.preset:right.preset;
    result.visualPreset=result.name;
    result.label=result.name==='dusk'?'夕方':result.name==='night'?'夜':'昼';
    const sun=normalize3(result.skySunX,result.skySunY,result.skySunZ,[.35,.89,.28]);
    const moon=normalize3(result.moonDirectionX,result.moonDirectionY,result.moonDirectionZ,[0,1,0]);
    const solarVisibility=smoothstep(clamp((sun[1]-.02)/.63,0,1,0));
    const nightWeight=smoothstep(clamp((.20-sun[1])/.46,0,1,0));
    result.sunIntensity=clamp(result.sunIntensity*(.72+.28*solarVisibility),0,8,0);
    // Stars are driven by solar altitude, not preset labels. This removes the
    // daytime star leakage and makes the dusk-to-night fade continuous.
    result.starBrightness=clamp(nightWeight*1.62,0,1.62,0);
    result.twilightStrength=clamp(Number(result.twilightStrength||0)+solarVisibility*(1-solarVisibility)*.22,0,1,0);
    result.skySunX=sun[0];result.skySunY=sun[1];result.skySunZ=sun[2];
    result.lightX=-sun[0];result.lightY=-sun[1];result.lightZ=-sun[2];
    result.moonDirectionX=moon[0];result.moonDirectionY=moon[1];result.moonDirectionZ=moon[2];
    return result;
  }

  function createGenesisEnvironmentController(options={}){
    const initialTime=wrapHours(options.timeOfDay??12);
    const initialWeather=Object.prototype.hasOwnProperty.call(WEATHER,String(options.weather))?String(options.weather):'clear';
    const direction=Array.isArray(options.windDirection)?normalize2(options.windDirection[0],options.windDirection[1]):normalize2(options.windDirectionX??1,options.windDirectionZ??0);
    const currentWeights={clear:0,cloudy:0,overcast:0,rain:0,storm:0};
    currentWeights[initialWeather]=1;
    const targetWeights={...currentWeights};
    let timeOfDay=initialTime,targetTimeOfDay=initialTime;
    let weatherIntensity=clamp(options.weatherIntensity,0,1,initialWeather==='clear'?0:1);
    let targetWeatherIntensity=weatherIntensity;
    let windDirection=direction.slice(),targetWindDirection=direction.slice();
    let windSpeed=clamp(options.windSpeed,0,8,.35),targetWindSpeed=windSpeed;
    let timeScale=clamp(options.timeScale,0,.5,0);
    let transitionSeconds=clamp(options.transitionSeconds,.05,60,.15);
    let windTransitionSeconds=clamp(options.windTransitionSeconds,.05,60,1.6);
    let revision=0,elapsedSeconds=0;
    let snapshot=null;

    const configure=(config={})=>{
      let changed=false;
      if(config.timeOfDay!==undefined){
        targetTimeOfDay=wrapHours(config.timeOfDay);changed=true;
      }else if(config.preset!==undefined){
        const named=String(config.preset).toLowerCase();
        if(named==='dusk')targetTimeOfDay=19;
        else if(named==='night')targetTimeOfDay=23;
        else if(named==='day')targetTimeOfDay=12;
        changed=true;
      }
      if(config.timeScale!==undefined){timeScale=clamp(config.timeScale,0,.5,0);changed=true;}
      if(config.weather!==undefined){
        const next=Object.prototype.hasOwnProperty.call(WEATHER,String(config.weather))?String(config.weather):'clear';
        for(const name of Object.keys(targetWeights))targetWeights[name]=name===next?1:0;
        if(config.weatherIntensity===undefined)targetWeatherIntensity=next==='clear'?0:1;
        changed=true;
      }
      if(config.weatherIntensity!==undefined){targetWeatherIntensity=clamp(config.weatherIntensity,0,1,1);changed=true;}
      if(Array.isArray(config.windDirection)){
        targetWindDirection=normalize2(config.windDirection[0],config.windDirection[1],targetWindDirection);changed=true;
      }else if(config.windDirection&&typeof config.windDirection==='object'){
        targetWindDirection=normalize2(config.windDirection.x,config.windDirection.z,targetWindDirection);changed=true;
      }else if(Number.isFinite(Number(config.windDirectionDegrees))){
        const angle=Number(config.windDirectionDegrees)*Math.PI/180;
        targetWindDirection=[Math.cos(angle),Math.sin(angle)];changed=true;
      }
      if(config.windSpeed!==undefined){targetWindSpeed=clamp(config.windSpeed,0,8,0);changed=true;}
      if(config.transitionSeconds!==undefined)transitionSeconds=clamp(config.transitionSeconds,.05,60,transitionSeconds);
      if(config.windTransitionSeconds!==undefined)windTransitionSeconds=clamp(config.windTransitionSeconds,.05,60,windTransitionSeconds);
      if(changed)revision++;
      return changed;
    };

    const update=deltaSeconds=>{
      const dt=clamp(deltaSeconds,0,.1,0);
      elapsedSeconds+=dt;
      if(timeScale>0)targetTimeOfDay=wrapHours(targetTimeOfDay+dt*timeScale);
      const timeAlpha=1-Math.exp(-dt/Math.max(.05,transitionSeconds));
      let delta=((targetTimeOfDay-timeOfDay+36)%24)-12;
      timeOfDay=wrapHours(timeOfDay+delta*timeAlpha);
      const windAlpha=1-Math.exp(-dt/Math.max(.05,windTransitionSeconds));
      weatherIntensity+= (targetWeatherIntensity-weatherIntensity)*timeAlpha;
      windSpeed+=(targetWindSpeed-windSpeed)*windAlpha;
      for(const name of Object.keys(currentWeights))currentWeights[name]+=(targetWeights[name]-currentWeights[name])*timeAlpha;
      const weightTotal=Object.values(currentWeights).reduce((sum,value)=>sum+value,0)||1;
      for(const name of Object.keys(currentWeights))currentWeights[name]/=weightTotal;
      // Interpolate the shortest angular path. Linear interpolation of
      // opposite unit vectors collapses toward zero and can flip direction.
      const currentWindAngle=Math.atan2(windDirection[1],windDirection[0]);
      const targetWindAngle=Math.atan2(targetWindDirection[1],targetWindDirection[0]);
      const windAngleDelta=Math.atan2(
        Math.sin(targetWindAngle-currentWindAngle),
        Math.cos(targetWindAngle-currentWindAngle)
      );
      const nextWindAngle=currentWindAngle+windAngleDelta*windAlpha;
      windDirection=[Math.cos(nextWindAngle),Math.sin(nextWindAngle)];
      const profile=profileForTime(timeOfDay);
      const weatherMix={cloudDensity:0,cloudCoverage:0,fogDensity:0,fogFar:0,sun:0,rain:0,wetness:0,wind:0};
      for(const [name,weight] of Object.entries(currentWeights)){
        const weather=WEATHER[name];
        for(const key of Object.keys(weatherMix))weatherMix[key]+=weather[key]*weight;
      }
      const strength=weatherIntensity;
      profile.cloudDensity=clamp(profile.cloudDensity+weatherMix.cloudDensity*strength,0,2,0);
      profile.cloudCoverage=clamp(profile.cloudCoverage+weatherMix.cloudCoverage*strength,0,1,0);
      profile.fogDensity=clamp(profile.fogDensity+weatherMix.fogDensity*strength,0,.08,0);
      profile.fogFar=Math.max(80,profile.fogFar*(1-(1-weatherMix.fogFar)*strength));
      profile.sunIntensity=clamp(profile.sunIntensity*(1-(1-weatherMix.sun)*strength),0,8,0);
      profile.rainIntensity=clamp(weatherMix.rain*strength,0,1,0);
      profile.precipitationRate=profile.rainIntensity*120;
      profile.wetness=clamp(weatherMix.wetness*strength,0,1,0);
      profile.windDirection=Object.freeze(windDirection.slice());
      profile.windSpeed=clamp(windSpeed+weatherMix.wind*strength*2.4,0,12,0);
      profile.windStrength=clamp(profile.windSpeed/5,0,2.5,0);
      profile.cloudWindX=windDirection[0]*profile.windSpeed;
      profile.cloudWindZ=windDirection[1]*profile.windSpeed;
      profile.animationTime=elapsedSeconds;
      profile.waterWaveAmplitude=clamp(.035+profile.windSpeed*.018+profile.rainIntensity*.035,.025,.34,.08);
      profile.waterWaveSpeed=clamp(.55+profile.windSpeed*.52,0.3,7,.8);
      profile.waterRippleStrength=clamp(profile.rainIntensity*.9,0,1,0);
      profile.waterReflectivity=clamp(.92+profile.wetness*.08,0,1,.92);
      profile.weather=Object.freeze({...Object.fromEntries(Object.entries(currentWeights).map(([key,value])=>[key,Number(value.toFixed(4))])),intensity:Number(strength.toFixed(4))});
      profile.timeOfDay=Number(timeOfDay.toFixed(3));
      profile.timeScale=timeScale;
      profile.revision=revision;
      profile.weatherName=Object.keys(currentWeights).reduce((best,name)=>currentWeights[name]>currentWeights[best]?name:best,'clear');
      profile.name=profile.visualPreset;
      snapshot=Object.freeze(profile);
      return snapshot;
    };

    configure(options);
    update(0);
    return Object.freeze({
      set:configure,
      update,
      getState:()=>snapshot,
      getConfig:()=>Object.freeze({timeOfDay,targetTimeOfDay,timeScale,weatherIntensity,targetWeatherIntensity,windDirection:Object.freeze(windDirection.slice()),windSpeed,targetWindSpeed,transitionSeconds,windTransitionSeconds})
    });
  }

  function hash2(x,y){
    const value=Math.sin(x*127.1+y*311.7+74.7)*43758.5453123;
    return value-Math.floor(value);
  }
  function mixNoise(a,b,t){return a+(b-a)*t;}
  function smooth(a,b,x){const t=clamp((x-a)/(b-a),0,1,0);return t*t*(3-2*t);}
  function normalizeColor(value){return colorBytes(value);}
  function directionToUv(direction){
    const d=normalize3(direction?.[0],direction?.[1],direction?.[2],[0,1,0]);
    return {u:(Math.atan2(d[2],d[0])/(Math.PI*2)+1.5)%1,v:Math.acos(clamp(d[1],-1,1,0))/Math.PI};
  }
  function composeSkyPixels(state,width=512,height=256){
    const w=Math.max(64,Math.min(1024,Math.floor(Number(width)||512)));
    const h=Math.max(32,Math.min(512,Math.floor(Number(height)||256)));
    const data=new Uint8Array(w*h*4);
    const top=normalizeColor(state.skyTop||'#1c5a92');
    const mid=normalizeColor(state.skyMid||'#438fc3');
    const horizon=normalizeColor(state.horizon||state.fogColor||'#cde5ef');
    const ground=normalizeColor(state.ground||'#313b3d');
    const sunColor=normalizeColor(state.atmosphereSunColor||state.sunColor||'#fff7e5');
    const moonColor=normalizeColor(state.moonColor||'#c7dcff');
    const sunUv=directionToUv([state.skySunX,state.skySunY,state.skySunZ]);
    const moonUv=directionToUv([state.moonDirectionX,state.moonDirectionY,state.moonDirectionZ]);
    const sunRadius=Math.max(.002,clamp(state.sunAngularRadius,.01,5,.28)*Math.PI/180);
    const sunPower=clamp(state.sunIntensity,0,8,0);
    const moonPower=clamp(state.moonIntensity,0,4,0);
    const stars=clamp(state.starBrightness,0,4,0);
    const cloudCoverage=clamp(state.cloudCoverage,0,1,0);
    const cloudDensity=clamp(state.cloudDensity,0,2,0);
    const exposure=Math.pow(2,clamp(state.skyExposure,.1,2,.56));
    const mixRgb=(a,b,t)=>a.map((value,i)=>value+(b[i]-value)*clamp(t,0,1,0));
    const cloudSeed=0x6d2b79f5;
    const cloudTime=clamp(state.animationTime,0,1e9,0);
    const cloudWindX=clamp(state.cloudWindX,-48,48,0);
    const cloudWindZ=clamp(state.cloudWindZ,-48,48,0);
    for(let y=0;y<h;y++){
      const v=y/(h-1);
      let base;
      if(v<.47)base=mixRgb(top,mid,smooth(0,.47,v));
      else if(v<.65)base=mixRgb(mid,horizon,smooth(.47,.65,v));
      else base=mixRgb(horizon,ground,smooth(.65,1,v));
      for(let x=0;x<w;x++){
        const u=x/w;
        const theta=(u-.5)*Math.PI*2,phi=v*Math.PI;
        const dx=Math.cos(theta)*Math.sin(phi),dy=Math.cos(phi),dz=Math.sin(theta)*Math.sin(phi);
        const dotSun=Math.max(-1,Math.min(1,dx*(state.skySunX||0)+dy*(state.skySunY||1)+dz*(state.skySunZ||0)));
        const dotMoon=Math.max(-1,Math.min(1,dx*(state.moonDirectionX||0)+dy*(state.moonDirectionY||1)+dz*(state.moonDirectionZ||0)));
        let r=base[0],g=base[1],b=base[2];
        const sunGlow=Math.pow(Math.max(0,dotSun),42)*sunPower*.24;
        const solarDisc=smooth(Math.cos(sunRadius*1.2),Math.cos(sunRadius*.82),dotSun)*sunPower;
        const twilight=Math.pow(Math.max(0,dotSun),13)*clamp(state.twilightStrength,0,1,0)*.24;
        r+=sunColor[0]*(sunGlow+solarDisc*.62+twilight*.18);
        g+=sunColor[1]*(sunGlow+solarDisc*.62+twilight*.12);
        b+=sunColor[2]*(sunGlow+solarDisc*.54+twilight*.06);
        const moonGlow=Math.pow(Math.max(0,dotMoon),62)*moonPower*.22;
        const moonDisc=smooth(Math.cos(.75*Math.PI/180),Math.cos(.42*Math.PI/180),dotMoon)*moonPower;
        r+=moonColor[0]*(moonGlow+moonDisc*.52);
        g+=moonColor[1]*(moonGlow+moonDisc*.58);
        b+=moonColor[2]*(moonGlow+moonDisc*.68);
        if(cloudDensity>.025&&cloudCoverage>.04&&v>.16&&v<.61){
          const cloudU=(u+cloudWindX*cloudTime*.00008)%1;
          const cloudV=v+cloudWindZ*cloudTime*.000025;
          const n=.5+.22*Math.sin(cloudU*23+cloudV*9)+.15*Math.sin(cloudU*57-cloudV*21)+.08*Math.sin(cloudU*111+cloudV*63+cloudSeed*.00001);
          const cover=smooth(.88-cloudCoverage*.55,.99-cloudCoverage*.28,n)*clamp(cloudDensity,0,1.2,0);
          const cloud=cover*(.27+Math.max(0,dotSun)*.18);
          r=mix(r,Math.min(255,206+sunColor[0]*.18),cloud);
          g=mix(g,Math.min(255,216+sunColor[1]*.13),cloud);
          b=mix(b,Math.min(255,229+sunColor[2]*.08),cloud);
        }
        if(stars>.03&&v>.18&&v<.87){
          const cellX=Math.floor(u*w*.72),cellY=Math.floor(v*h*.72);
          const star=hash2(cellX,cellY);
          const milkyBand=Math.exp(-Math.pow((v-(.49+.14*Math.sin(theta*1.7)))/.105,2));
          const brightness=(star>.996?Math.pow((star-.996)/.004,1.7):0)*stars*.72+milkyBand*stars*(.025+.045*hash2(cellY,cellX+91));
          r+=brightness*168;g+=brightness*190;b+=brightness*255;
        }
        const offset=(y*w+x)*4;
        data[offset]=Math.round(clamp(r*exposure,0,255,0));
        data[offset+1]=Math.round(clamp(g*exposure,0,255,0));
        data[offset+2]=Math.round(clamp(b*exposure,0,255,0));
        data[offset+3]=255;
      }
    }
    return Object.freeze({width:w,height:h,data});
  }

  return Object.freeze({
    createGenesisEnvironmentController,
    composeSkyPixels,
    profileForTime,
    weatherModes:Object.freeze(Object.keys(WEATHER))
  });
});

import {useEffect,useState} from 'react';
import type {ModelRouteHealth} from './types';

/** Local display expiry only; no capability refresh or provider probe. */
export function useModelHealthClock(models:ReadonlyArray<{health?:ModelRouteHealth}>){
 const [now,setNow]=useState(()=>Date.now());
 const signature=JSON.stringify(models.map(item=>item.health??null));
 useEffect(()=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const update=()=>{
   clearTimeout(timer);const instant=Date.now();setNow(instant);
   const boundaries=models.flatMap(item=>item.health&&['healthy','unhealthy'].includes(item.health.status)?[item.health.observed_at,item.health.expires_at]:[])
    .filter((value):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>instant);
   if(boundaries.length)timer=setTimeout(update,Math.min(60000,Math.max(1,Math.min(...boundaries)-instant+1)));
  };
  update();window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);
  return()=>{clearTimeout(timer);window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);};
 },[signature]);
 return now;
}

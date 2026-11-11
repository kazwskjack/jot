const HEALTH={healthy:'健康',unhealthy:'当前不可用',stale:'健康检查已过期',unknown:'健康状态未知'};
const HEALTH_EN={healthy:'Healthy',unhealthy:'Currently unavailable',stale:'Health check expired',unknown:'Health unknown'};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Match the original Host receipt freshness rules without issuing a provider call. */
export function modelHealthAt(health,now=Date.now()){
 const unknown={status:'unknown',observed_at:null,expires_at:null};
 if(!plain(health)||Object.keys(health).sort().join(',')!=='expires_at,observed_at,status'
  ||!['healthy','unhealthy','stale','unknown'].includes(health.status))return unknown;
 if(health.status==='unknown')return unknown;
 const {observed_at,expires_at}=health;
 if(!Number.isSafeInteger(observed_at)||observed_at<0||!Number.isSafeInteger(expires_at)||expires_at<observed_at)return unknown;
 const stale=health.status==='stale'||!Number.isSafeInteger(now)||now<observed_at||now>=expires_at;
 return {status:stale?'stale':health.status,observed_at,expires_at};
}
export function modelHealthLabel(health,language='zh-CN'){
 const labels=language==='en'?HEALTH_EN:HEALTH;return plain(health)&&Object.hasOwn(labels,health.status)?labels[health.status]:labels.unknown;
}
function catalogRoute(route,catalog){
 if(!plain(route)||typeof route.provider!=='string'||typeof route.model!=='string'||!Array.isArray(catalog))return;
 return catalog.find(item=>item?.provider===route.provider&&item?.model===route.model);
}
function routeStatus(route,catalog,index,language){
 const item=catalogRoute(route,catalog),en=language==='en';
 if(!item)return index===0?(en?'Primary model (health unknown)':'主模型（健康状态未知）'):(en?`Fallback route ${index} (health unknown)`:`备用路线 ${index}（健康状态未知）`);
 const name=`${item.provider}/${item.model}`,health=modelHealthLabel(item.health,language);
 return index===0?(en?`Primary model ${name}: ${health}`:`主模型 ${name}：${health}`):(en?`${name} (${health})`:`${name}（${health}）`);
}
export function modelRoutingStatus(selection,catalog,language='zh-CN'){
 const primary=routeStatus(selection,catalog,0,language),fallbacks=selection?.fallbacks,en=language==='en';
 if(fallbacks===undefined||fallbacks===null||Array.isArray(fallbacks)&&fallbacks.length===0)return{primary,fallbacks:en?'Fallback order: not configured':'备用顺序：未配置'};
 if(!Array.isArray(fallbacks)||fallbacks.length>3)return{primary,fallbacks:en?'Fallback order: invalid configuration; refresh to confirm':'备用顺序：配置无效，请刷新确认'};
 return{primary,fallbacks:`${en?'Fallback order: ':'备用顺序：'}${fallbacks.map((route,index)=>routeStatus(route,catalog,index+1,language)).join(' → ')}`};
}

function checkedFallbacks(fallbacks){
 if(!Array.isArray(fallbacks)||fallbacks.length>3||fallbacks.some(route=>!plain(route)||Object.keys(route).sort().join(',')!=='model,provider'||typeof route.provider!=='string'||typeof route.model!=='string'))throw new Error('备用模型配置未确认，请刷新对话后再更改模型');
 return fallbacks.map(({provider,model})=>({provider,model}));
}

/** Preserve server fallbacks on primary changes while accepting explicit fallback edits. */
export function modelSelectionPreservingFallbacks(selection,current){
 const requested=Object.hasOwn(selection,'fallbacks'),fallbacks=requested?(selection.fallbacks===undefined?[]:checkedFallbacks(selection.fallbacks)):current?.fallbacks===undefined?undefined:checkedFallbacks(current.fallbacks);
 if(fallbacks===undefined)return selection;
 const remaining=fallbacks.filter(route=>route.provider!==selection.provider||route.model!==selection.model);
 return {...selection,fallbacks:remaining};
}

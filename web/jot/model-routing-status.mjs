const HEALTH={healthy:'健康',unhealthy:'当前不可用',stale:'健康检查已过期',unknown:'健康状态未知'};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

export function modelHealthLabel(health){return plain(health)?HEALTH[health.status]??'健康状态未知':'健康状态未知';}

function catalogRoute(route,catalog){
 if(!plain(route)||typeof route.provider!=='string'||typeof route.model!=='string'||!Array.isArray(catalog))return;
 return catalog.find(item=>item?.provider===route.provider&&item?.model===route.model);
}

function routeStatus(route,catalog,index){
 const item=catalogRoute(route,catalog);
 if(!item)return index===0?'主模型（健康状态未知）':`备用路线 ${index}（健康状态未知）`;
 const name=`${item.provider}/${item.model}`,health=modelHealthLabel(item.health);
 return index===0?`主模型 ${name}：${health}`:`${name}（${health}）`;
}

export function modelRoutingStatus(selection,catalog){
 const primary=routeStatus(selection,catalog,0),fallbacks=selection?.fallbacks;
 if(fallbacks===undefined||fallbacks===null||Array.isArray(fallbacks)&&fallbacks.length===0)return{primary,fallbacks:'备用顺序：未配置'};
 if(!Array.isArray(fallbacks)||fallbacks.length>3)return{primary,fallbacks:'备用顺序：配置无效，请刷新确认'};
 return{primary,fallbacks:`备用顺序：${fallbacks.map((route,index)=>routeStatus(route,catalog,index+1)).join(' → ')}`};
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

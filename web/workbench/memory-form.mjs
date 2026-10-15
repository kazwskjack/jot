export function blankMemoryForm(){return {content:'',verified:false,provenance:[],source_revision:'',expires_at:'',supersedes:''};}
export function memoryMatchesSelection(memory,selection){
 return memory.scope===selection.scope&&(selection.scope!=='private'||memory.agent_id===selection.agent_id)
  &&(!selection.lifecycle||memory.project_id===selection.project_id);
}
export function memoryFormFromMemory(memory){
 return {...blankMemoryForm(),content:memory.content,verified:!!memory.verified,provenance:(memory.provenance??[]).map(item=>({...item})),source_revision:memory.source_revision??'',expires_at:memory.expires_at??'',supersedes:memory.supersedes??''};
}
export function normalizeMemoryExpiry(input){
 const value=input.trim();if(!value)return null;
 const invalid=()=>{throw new Error('有效期须为真实日期，且包含 Z 或时区偏移');};
 const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 if(!parts)return invalid();
 const year=Number(parts[1]),month=Number(parts[2]),day=Number(parts[3]),zone=parts[7];
 const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(month<1||month>12||day<1||day>(days[month-1]??0)||Number(parts[4])>23||Number(parts[5])>59||Number(parts[6])>59||(zone!=='Z'&&(Number(zone.slice(1,3))>23||Number(zone.slice(4))>59)))return invalid();
 const milliseconds=Date.parse(value);if(!Number.isFinite(milliseconds))return invalid();
 return new Date(milliseconds).toISOString();
}
export function memoryInput(form,{scope,agent_id,project_id,lifecycle=false,editing=null}){
 const content=form.content.trim();if(!content||content.length>20000)throw new Error('请填写记忆内容（最多 20000 字）');
 const input={scope,...(scope==='private'?{agent_id}:{project_id}),content,verified:!!form.verified,...(editing?{expected_version:editing.version}:{})};
 if(!lifecycle)return input;
 if(!Array.isArray(form.provenance)||form.provenance.length>20)throw new Error('来源最多 20 条');
 const provenance=form.provenance.filter(item=>item.kind.trim()||item.reference.trim()).map(item=>({kind:item.kind.trim(),reference:item.reference.trim()}));
 if(provenance.some(item=>!item.kind||item.kind.length>60||!item.reference||item.reference.length>2048))throw new Error('请填写来源类型和引用（类型最多 60 字，引用最多 2048 字）');
 const source_revision=form.source_revision.trim()||null,supersedes=form.supersedes.trim()||null;
 if((source_revision?.length??0)>128||(supersedes?.length??0)>128)throw new Error('来源版本和替代记忆 ID 最多 128 字');
 const expires_at=normalizeMemoryExpiry(form.expires_at);
 return {...input,provenance,source_revision,expires_at,supersedes};
}
export function memoryQuery({scope,agent_id,project_id,lifecycle=false,include_expired=false}){
 const params=new URLSearchParams();if(lifecycle)params.set('scope',scope);
 params.set(scope==='private'?'agent_id':'project_id',scope==='private'?agent_id:project_id);
 if(lifecycle)params.set('include_expired',String(include_expired));
 return '?'+params.toString();
}
export function memoryExpired(memory,now=Date.now()){
 return memory.expired===true||!!(memory.expires_at&&Number.isFinite(Date.parse(memory.expires_at))&&Date.parse(memory.expires_at)<=now);
}
export function downloadMemoryExport(value,selection,env=globalThis){
 if(value.schema_version!==1||!Array.isArray(value.items)||value.items.some(item=>item.scope!==selection.scope||(item.workspace_id&&item.workspace_id!==value.workspace_id)||(selection.scope==='private'?item.agent_id!==selection.agent_id:item.project_id!==selection.project_id)))throw new Error('导出范围与当前选择不一致，请重新读取');
 const blob=new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'}),url=env.URL.createObjectURL(blob),anchor=env.document.createElement('a');
 const safe=value=>String(value??'').replace(/[^A-Za-z0-9_-]/g,'_');
 try{anchor.href=url;anchor.download=`memory-${safe(value.workspace_id)}-${selection.scope}-${safe(selection.scope==='private'?selection.agent_id:selection.project_id)}.json`;env.document.body.appendChild(anchor);anchor.click();}finally{anchor.remove();env.URL.revokeObjectURL(url);}
}

const SAFE_NAMESPACE=/^[a-z][a-z0-9._-]{0,127}$/;
const SAFE_WORKSPACE_ID=/^[a-z][a-z0-9_-]{0,63}$/;
const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function readinessNamespace(value){
  if(!Array.isArray(value)||value.length!==1)return null;
  const [namespace]=value;
  return typeof namespace==='string'&&SAFE_NAMESPACE.test(namespace)&&namespace!=='jot-host-policy'?namespace:null;
}

export function readinessRequestIsCurrent(request,current){
  return isRecord(request)&&isRecord(current)&&request.enabled===true&&current.enabled===true
    &&typeof request.namespace==='string'&&request.namespace===current.namespace&&request.client!==null&&request.client!==undefined
    &&request.client===current.client&&request.scopeKey===current.scopeKey;
}

export async function connectHostReadiness({client,namespace,signal,onReadiness}={}){
  if(typeof namespace!=='string'||!SAFE_NAMESPACE.test(namespace)||namespace==='jot-host-policy')throw new Error('HOST_READINESS_NAMESPACE_INVALID');
  try{
    const approval=await client.approveSettingsRead(signal);
    if(!isRecord(approval)||approval.approved!==true||!Array.isArray(approval.namespaces)
      ||approval.namespaces.length!==1||approval.namespaces[0]!==namespace){
      throw new Error('HOST_READINESS_APPROVAL_SCOPE_MISMATCH');
    }
    const result=await client.readiness(namespace,signal);
    if(isRecord(result)&&result.ok===false)throw new Error('HOST_READINESS_SCOPE_DENIED');
    const readiness=isRecord(result)&&result.ok===true&&isRecord(result.readiness)?result.readiness:result;
    if(!isRecord(readiness)||readiness.protocol!==1||!isRecord(readiness.scope)||readiness.scope.namespace!==namespace){
      throw new Error('HOST_READINESS_SCOPE_MISMATCH');
    }
    onReadiness?.(readiness);
    return readiness;
  }catch(error){
    onReadiness?.(null);
    throw error;
  }
}

export function workspacePermissionLabel(value){
  return value===true?'可读':value===false?'不可读':'未知';
}

export function workspaceWritePermissionLabel(value){
  return value===true?'可写':value===false?'只读':'未知';
}

const safeBoolean=value=>typeof value==='boolean'?value:null;
const safeEnum=(value,allowed)=>typeof value==='string'&&allowed.includes(value)?value:'unknown';
const safeWorkspaceTitle=(value,id)=>{
  if(typeof value==='string'&&value.length>0&&value.length<=64&&/^[\p{L}\p{N} _-]+$/u.test(value))return value;
  return id.replace(/[-_]+/g,' ');
};

export function jotCapabilityFacts(value){
  const caps=isRecord(value)?value:{};
  const modes=isRecord(caps.conversation_modes)?caps.conversation_modes:{};
  const chat=isRecord(modes.chat)?modes.chat:{};
  const work=isRecord(modes.work)?modes.work:{};
  const workbench=isRecord(caps.workbench)?caps.workbench:{};
  const voice=isRecord(caps.voice)?caps.voice:{};
  /** @type {{workspace_id:string;title:string;gateway_can_read:boolean|null;gateway_can_write:boolean|null;os_read:string;os_write:string}[]} */
  const workspaces=Array.isArray(caps.workspaces)?caps.workspaces.flatMap(item=>{
    if(!isRecord(item)||typeof item.workspace_id!=='string'||!SAFE_WORKSPACE_ID.test(item.workspace_id))return [];
    return [{
      workspace_id:item.workspace_id,
      title:safeWorkspaceTitle(item.title,item.workspace_id),
      gateway_can_read:safeBoolean(item.can_read),
      gateway_can_write:safeBoolean(item.can_write),
      os_read:'unknown',
      os_write:'unknown'
    }];
  }):[];
  return {
    conversation_mode_default:safeEnum(modes.default,['chat','work']),
    work_mode_supported:safeBoolean(work.supported),
    chat_policy:chat.ready===true?'available':chat.ready===false?'unavailable':'unknown',
    workbench_api_enabled:safeBoolean(workbench.enabled),
    execution_gate_enabled:safeBoolean(workbench.execution_ready),
    file_read_capability:safeBoolean(caps.file_read),
    file_edit_capability:safeBoolean(caps.file_edit),
    adapter_lifecycle:'unknown',
    workspaces,
    voice:{enabled:safeBoolean(voice.enabled),status:safeEnum(voice.status,['ready','standby','preparing','unavailable'])}
  };
}

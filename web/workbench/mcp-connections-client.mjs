const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const ERROR_CODE=/^[a-z][a-z0-9_]{0,63}$/;
const STATES=['configured','disabled','disconnected','connecting','ready','reloading','removing','removed','error'];
const CONNECTION_KEYS=['connection_id','server_name','transport','version','enabled','state','active_generation','pending_generation','credentials_configured','last_error_code','tools'];
function fail(code){throw new Error(code);}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function exact(value,keys){if(!object(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail('MCP_RESPONSE_UNKNOWN');}
function integer(value,min){return Number.isSafeInteger(value)&&value>=min;}
function validateConnection(value){
 exact(value,CONNECTION_KEYS);
 if(typeof value.connection_id!=='string'||!ID.test(value.connection_id)||typeof value.server_name!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value.server_name)
  ||!['stdio','streamable-http'].includes(value.transport)||!integer(value.version,1)||typeof value.enabled!=='boolean'
  ||!STATES.includes(value.state)||!integer(value.active_generation,0)
  ||!(value.pending_generation===null||integer(value.pending_generation,1))||typeof value.credentials_configured!=='boolean'
  ||!(value.last_error_code===null||typeof value.last_error_code==='string'&&ERROR_CODE.test(value.last_error_code))
  ||!Array.isArray(value.tools)||value.tools.length>100)fail('MCP_RESPONSE_UNKNOWN');
 if(value.state==='ready'&&(!value.enabled||value.active_generation<1||value.pending_generation!==null))fail('MCP_RESPONSE_UNKNOWN');
 if(value.pending_generation!==null&&value.pending_generation<=value.active_generation)fail('MCP_RESPONSE_UNKNOWN');
 if(value.active_generation===0&&value.tools.length)fail('MCP_RESPONSE_UNKNOWN');
 const seen=new Set();
 for(const tool of value.tools){
  exact(tool,['tool_id','public_name','raw_name','description','source','source_untrusted','input_schema','approved']);
  if(typeof tool.tool_id!=='string'||!/^mcp_[a-f0-9]{32}$/.test(tool.tool_id)||seen.has(tool.tool_id)
   ||typeof tool.public_name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(tool.public_name)
   ||typeof tool.raw_name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(tool.raw_name)
   ||tool.source!=='mcp_server'||tool.source_untrusted!==true||typeof tool.description!=='string'||tool.description.length>2048||typeof tool.approved!=='boolean'
   ||!object(tool.input_schema)||tool.input_schema.type!=='object')fail('MCP_RESPONSE_UNKNOWN');
  const schema=JSON.stringify(tool.input_schema);
  if(new TextEncoder().encode(schema).length>16384||schema.includes('"$ref"'))fail('MCP_RESPONSE_UNKNOWN');
  seen.add(tool.tool_id);
 }
 return value;
}

/** Local display fence only. Capability authority remains in Gateway/Host. */
export class McpPanelContext{
 constructor(){this.current=null;this.epoch=0;}
 select(ownerScope,agentId,capabilityEpoch){
  const key=JSON.stringify([ownerScope,agentId,capabilityEpoch]);
  if(this.current?.key!==key){
   const active=typeof ownerScope==='string'&&/^[a-f0-9]{64}$/.test(ownerScope)&&typeof agentId==='string'&&ID.test(agentId)&&integer(capabilityEpoch,0);
   this.current=Object.freeze({key,identity:JSON.stringify([key,++this.epoch]),owner_scope:ownerScope,agent_id:agentId,capability_epoch:capabilityEpoch,epoch:this.epoch,active});
  }
  return this.current;
 }
 isCurrent(captured,ownerScope){return captured===this.current&&captured.active&&captured.owner_scope===ownerScope;}
}

/** The panel's actual request caller. Uses the existing receipt and client;
 * no polling, automatic mutation replay, SDK installation or new keys. */
export function createMcpConnectionsClient({request,receipt,context,isCurrent}){
 if(typeof request!=='function'||typeof isCurrent!=='function'||!context)fail('MCP_CLIENT_INVALID');
 const current=signal=>{if(signal?.aborted||!context.active||!isCurrent())fail('MCP_CONTEXT_CHANGED');};
 return Object.freeze({
  async read(signal){
   current(signal);
   const page=await request(`/agents/${encodeURIComponent(context.agent_id)}/mcp`,'GET',undefined,undefined,signal);
   current(signal);exact(page,['items']);if(!Array.isArray(page.items))fail('MCP_RESPONSE_UNKNOWN');
   const ids=new Set();for(const row of page.items){validateConnection(row);if(ids.has(row.connection_id))fail('MCP_RESPONSE_UNKNOWN');ids.add(row.connection_id);}
   return structuredClone(page);
  },
  async submit(path,method,body){
   current();if(!receipt||typeof receipt.submit!=='function')fail('MCP_RECEIPT_UNAVAILABLE');
   return receipt.submit(async(originalPath,originalMethod,originalBody,originalKey)=>{
    current();
    const base=`/agents/${encodeURIComponent(context.agent_id)}/mcp/connections`;
    if(originalPath!==base&&!originalPath.startsWith(base+'/'))fail('MCP_CONTEXT_CHANGED');
    let result;
    try{result=await request(originalPath,originalMethod,originalBody,originalKey);}
    catch(error){current();throw error;}
    current();validateConnection(result);
    const rawId=originalPath.split('/')[5],expectedId=rawId?decodeURIComponent(rawId):undefined;
    if(expectedId&&result.connection_id!==expectedId)fail('MCP_RESPONSE_UNKNOWN');
    if(originalPath===base&&(result.server_name!==originalBody.server_name||result.transport!==originalBody.transport))fail('MCP_RESPONSE_UNKNOWN');
    if(originalBody?.expected_version!==undefined&&result.version<originalBody.expected_version)fail('MCP_RESPONSE_UNKNOWN');
    return structuredClone(result);
   },path,method,body);
  },
 });
}

/** Read-only interpretation of the existing Gateway projection. */
export function projectMcpConnectionState(connection){
 validateConnection(connection);
 const activeGeneration=connection.active_generation;
 const canApproveTools=connection.enabled&&connection.state==='ready'&&connection.pending_generation===null;
 let kind=connection.state,message={configured:'连接配置已保存，尚未加载工具目录。',disabled:'连接已停用。',disconnected:'连接已断开，需要显式重载。',connecting:'正在连接并读取工具目录。',ready:'活动工具目录已就绪；工具仍需逐项批准。',reloading:'正在重载工具目录，尚未发布新代次。',removing:'工具授权已撤销，等待 Host 清理。',removed:'连接已移除。',error:'连接未就绪，尚无可用的新目录。'}[connection.state];
 if(connection.state==='ready'&&connection.last_error_code){kind='reload-failed-retained';message=`上次重载失败；活动目录代次 ${activeGeneration} 仍保留。`;}
 return Object.freeze({kind,message,activeGeneration,canApproveTools,rollbackProven:false});
}

const definitions=Object.freeze({permission:'@deepseek-ai/dsh-permission-presets',goal:'@deepseek-ai/dsh-command-goal'});
export function isNativeCommandQuery(value){return !!value&&typeof value.name==='string'&&Object.hasOwn(definitions,value.name)&&definitions[value.name]===value.definition_id;}
export function validateNativeCommandQuery(value){
 if(!value||typeof value!=='object'||Array.isArray(value)
  ||Object.keys(value).sort().join(',')!=='definition_id,expected_catalog_sha256,name,request_id'
  ||typeof value.request_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.request_id)
  ||!isNativeCommandQuery(value)||!/^[a-f0-9]{64}$/.test(value.expected_catalog_sha256??''))throw Error('native_command_query_invalid');
 return {request_id:value.request_id,name:value.name,definition_id:value.definition_id,expected_catalog_sha256:value.expected_catalog_sha256};
}
export function validateNativeCommandQueryResult(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='commandId,result'
  ||typeof value.commandId!=='string'||value.commandId.length>192||!/^cmd-[A-Za-z0-9._:-]+$/.test(value.commandId)
  ||!value.result||typeof value.result!=='object'||Array.isArray(value.result)
  ||Object.keys(value.result).some(key=>!['kind','text','sourceEventSeq'].includes(key))
  ||!['success','error'].includes(value.result.kind)||value.result.kind==='error'&&typeof value.result.text!=='string'
  ||value.result.text!==undefined&&(typeof value.result.text!=='string'||new TextEncoder().encode(value.result.text).byteLength>1024*1024)
  ||value.result.sourceEventSeq!==undefined&&(value.result.kind!=='success'||!Number.isSafeInteger(value.result.sourceEventSeq)||value.result.sourceEventSeq<0))throw Error('native_command_query_result_invalid');
 return JSON.parse(JSON.stringify(value));
}

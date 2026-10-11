import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
export function freezeTaskSource(db:DatabaseSync,owner:string,agent:{workspace_id:string;project_id?:string|null},input:unknown){
 if(input===undefined)return undefined;
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('invalid_task_source');
 const value=input as Record<string,unknown>;
 if(Object.keys(value).sort().join(',')!=='conversation_id,message_id'||typeof value.conversation_id!=='string'||typeof value.message_id!=='string'||!value.conversation_id||!value.message_id||value.conversation_id.length>200||value.message_id.length>200)throw new Error('invalid_task_source');
 const row=db.prepare(`SELECT m.content_json,m.status,c.workspace_id,c.project_id FROM ga_messages m JOIN ga_conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.conversation_id=? AND c.owner_id=?`).get(value.message_id,value.conversation_id,owner) as {content_json:string;status:string;workspace_id:string;project_id:string|null}|undefined;
 if(!row||row.status!=='complete'||row.workspace_id!==agent.workspace_id||(row.project_id??null)!==(agent.project_id??null))throw new Error('invalid_task_source');
 return {conversation_id:value.conversation_id,message_id:value.message_id,content_sha256:createHash('sha256').update(row.content_json).digest('hex')};
}

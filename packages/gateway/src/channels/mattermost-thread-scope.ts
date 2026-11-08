import type {DatabaseSync} from 'node:sqlite';
import type {MattermostOwnerAccount} from './mattermost-owner-proof.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function mattermostTextIdentity(principal:string,thread:string){
 let p:unknown,t:unknown;try{p=JSON.parse(principal);t=JSON.parse(thread);}catch{throw Error('channel_authority_binding_invalid');}
 if(!Array.isArray(p)||p.length!==3||typeof p[0]!=='string'||typeof p[1]!=='string'||!ID.test(p[1])||typeof p[2]!=='string'||!ID.test(p[2])||p[1]===p[2]||JSON.stringify(p)!==principal
  ||!Array.isArray(t)||t.length!==2||typeof t[0]!=='string'||!ID.test(t[0])||typeof t[1]!=='string'||t[1]!==''&&!ID.test(t[1])||JSON.stringify(t)!==thread)throw Error('channel_authority_binding_invalid');
 return {instance:p[0] as string,botUserId:p[1] as string,userId:p[2] as string,channelId:t[0] as string,rootId:t[1] as string};
}
export function requireMattermostConfiguredAccount(account:MattermostOwnerAccount|undefined,principal:string,thread:string){
 const identity=mattermostTextIdentity(principal,thread);
 if(!account||identity.instance!==account.instance||identity.botUserId!==account.botUserId)throw Error('channel_authority_binding_invalid');
 return identity;
}
export function requireMattermostBindingThread(db:DatabaseSync,binding:{channel_binding_id:string;owner_id:string;principal:string;version:number},thread:string){
 if(!db.isTransaction)throw Error('channel_authority_transaction_required');
 const identity=mattermostTextIdentity(binding.principal,thread),scopeThread=JSON.stringify([identity.channelId,'']);
 const row=db.prepare(`SELECT 1 FROM ga_mattermost_binding_scopes s JOIN ga_mattermost_owner_proofs p
  ON p.channel_binding_id=s.channel_binding_id AND p.owner_id=s.owner_id AND p.instance=s.instance AND p.bot_user_id=s.bot_user_id
  AND p.principal=s.principal AND p.provider_thread_id=s.provider_thread_id
  WHERE s.channel_binding_id=? AND s.owner_id=? AND s.instance=? AND s.bot_user_id=? AND s.principal=? AND s.provider_thread_id=? AND p.binding_version=?`)
  .get(binding.channel_binding_id,binding.owner_id,identity.instance,identity.botUserId,binding.principal,scopeThread,binding.version);
 if(!row)throw Error('channel_authority_binding_invalid');
 return identity;
}

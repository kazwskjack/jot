import type {DatabaseSync} from 'node:sqlite';
import {mattermostTextIdentity} from './mattermost-thread-scope.ts';
import type {MattermostOwnerAccount} from './mattermost-owner-proof.ts';
type Kind='proof'|'text'|'attachment';
export function mattermostTableExists(db:DatabaseSync,table:string){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);}
export function mattermostStageSources(db:DatabaseSync,account:MattermostOwnerAccount,postId:string){
 if(!db.isTransaction)throw Error('channel_authority_transaction_required');
 if(!db.prepare('PRAGMA table_info(ga_uploads)').all().some(row=>row.name==='channel_source_json'))return [];
 const sources:Record<string,any>[]=[];
 for(const row of db.prepare('SELECT channel_source_json FROM ga_uploads WHERE channel_source_json IS NOT NULL').all()){
  const source=JSON.parse(String(row.channel_source_json));if(source?.event?.channel!=='mattermost'||source.event.message_id!==postId)continue;
  const identity=mattermostTextIdentity(source.event.principal,source.event.thread_id);if(identity.instance===account.instance&&identity.botUserId===account.botUserId)sources.push(source);
 }
 return sources;
}
/** Additional conflict fence only; observation presence never proves acceptance. */
export function requireMattermostSourceKind(db:DatabaseSync,account:MattermostOwnerAccount,postId:string,expected:Kind){
 if(!db.isTransaction)throw Error('channel_authority_transaction_required');
 const tables:Record<Kind,string[]>={proof:['ga_mattermost_ingress_observations','ga_mattermost_owner_proofs'],text:['ga_mattermost_text_observations'],attachment:['ga_mattermost_attachment_observations']};
 for(const kind of Object.keys(tables) as Kind[])if(kind!==expected)for(const table of tables[kind]){
  if(mattermostTableExists(db,table)&&db.prepare(`SELECT 1 FROM ${table} WHERE instance=? AND bot_user_id=? AND post_id=?`).get(account.instance,account.botUserId,postId))throw Error('mattermost_event_source_conflict');
 }
 for(const row of db.prepare("SELECT * FROM ga_channel_message_events WHERE channel='mattermost' AND provider_message_id=?").all(postId)){
  const identity=mattermostTextIdentity(String(row.principal),String(row.provider_thread_id));if(identity.instance!==account.instance||identity.botUserId!==account.botUserId)continue;
  if((row.content_protocol===2?'attachment':'text')!==expected)throw Error('mattermost_event_source_conflict');
 }
 if(expected!=='attachment'&&mattermostStageSources(db,account,postId).length)throw Error('mattermost_event_source_conflict');
}

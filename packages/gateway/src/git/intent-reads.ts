import type {DatabaseSync} from 'node:sqlite';
type Row={intent_id:string;owner_id:string;project_id:string;action:'stage'|'unstage'|'commit'|'discard'|'delete-untracked';selection_json:string;review_sha256:string;created_at:string};
type Event={version:number;state:'prepared'|'approved'|'cancelled';created_at:string};
/** Original immutable review projection, shared with journal-only reads. */
export function gitMutationIntentView(row:Row,event:Event){const selection=JSON.parse(row.selection_json) as {paths:string[];message?:string;snapshot_id:string};return{intent_id:row.intent_id,project_id:row.project_id,action:row.action,paths:selection.paths,...(selection.message===undefined?{}:{message:selection.message}),snapshot_id:selection.snapshot_id,review_sha256:row.review_sha256,version:event.version,state:event.state,created_at:row.created_at,updated_at:event.created_at,execution_authorized:false as const};}
export function readGitMutationIntent(db:DatabaseSync,owner:string,project:string,id:string){
 if(!db.prepare('SELECT 1 FROM ga_projects WHERE id=? AND owner_id=?').get(project,owner))throw Error('project_not_found');
 return readRecordedGitMutationIntent(db,owner,project,id);
}
/** Internal immutable facts only. Current-owner API/effect guards are separate;
 * this neither grants an old owner access nor adopts its work for a new owner. */
export function readRecordedGitMutationIntent(db:DatabaseSync,owner:string,project:string,id:string){
 const row=db.prepare('SELECT * FROM wb_git_mutation_intents WHERE intent_id=? AND owner_id=? AND project_id=?').get(id,owner,project) as Row|undefined;if(!row)throw Error('git_intent_not_found');
 const event=db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? ORDER BY version DESC LIMIT 1').get(id) as Event|undefined;if(!event)throw Error('git_intent_unavailable');return gitMutationIntentView(row,event);
}

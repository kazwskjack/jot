const SESSION_DRAFT_STORAGE_SLOT='jot.workbench.file-draft.v2';
const SESSION_DRAFT_INDEX_STORAGE_SLOT='jot.workbench.file-draft-index.v3';
const SESSION_DRAFT_ENTRY_STORAGE_SLOT='jot.workbench.file-draft-entry.v3';
const MAX_FILE_BYTES=1_048_576;
const textEncoder=new TextEncoder();
const OWNER_SCOPE_PATTERN=/^[a-f0-9]{64}$/;
function legacySessionDraftKey(ownerScope){return typeof ownerScope==='string'&&OWNER_SCOPE_PATTERN.test(ownerScope)?`${SESSION_DRAFT_STORAGE_SLOT}.${ownerScope}`:null;}
function sessionDraftIndexKey(ownerScope){return typeof ownerScope==='string'&&OWNER_SCOPE_PATTERN.test(ownerScope)?`${SESSION_DRAFT_INDEX_STORAGE_SLOT}.${ownerScope}`:null;}
function draftIdentity(value){
 if(!value||typeof value.workspace_id!=='string'||!value.workspace_id||value.workspace_id.length>128
  ||typeof value.project_id!=='string'||!value.project_id||value.project_id.length>128)throw new Error('workspace_file_draft_invalid');
 return {workspace_id:value.workspace_id,project_id:value.project_id,path:validateWorkspaceFilePath(value.path)};
}
function draftIdentityKey(ownerScope,value){return JSON.stringify([ownerScope,value.workspace_id,value.project_id,value.path]);}
function draftEntryKey(draft){
 const identity=JSON.stringify([draft.workspace_id,draft.project_id,draft.path]);
 const encoded=Array.from(identity,character=>character.codePointAt(0).toString(16)).join('_');
 return `${SESSION_DRAFT_ENTRY_STORAGE_SLOT}.${draft.owner_scope}.${encoded}`;
}
function readDraftIndex(storage,ownerScope,strict=false){
 const key=sessionDraftIndexKey(ownerScope);if(!key||!storage||typeof storage.getItem!=='function')return {items:[],raw:null,ok:false};
 let raw;try{raw=storage.getItem(key);}catch{if(strict)throw new Error('workspace_file_draft_storage_unavailable');return {items:[],raw:null,ok:false};}
 if(raw===null||raw===undefined)return {items:[],raw:null,ok:true};
 try{
  const value=JSON.parse(raw);if(value?.schema_version!==1||value.owner_scope!==ownerScope||!Array.isArray(value.items))throw new Error('invalid_index');
  const unique=new Map();for(const item of value.items){const identity=draftIdentity(item);unique.set(draftIdentityKey(ownerScope,identity),identity);}
  return {items:[...unique.values()],raw,ok:true};
 }catch{if(strict)throw new Error('workspace_file_draft_index_invalid');return {items:[],raw,ok:false};}
}
function readDraftEntry(storage,ownerScope,identity){
 try{
  const raw=storage.getItem(draftEntryKey({owner_scope:ownerScope,...identity}));if(!raw)return null;
  const value=JSON.parse(raw);if(value?.schema_version!==3||value.owner_scope!==ownerScope)return null;
  const draft=createFileDraft(value);return draftIdentityKey(ownerScope,draftIdentity(draft))===draftIdentityKey(ownerScope,identity)?draft:null;
 }catch{return null;}
}
function readLegacyDraft(storage,ownerScope){
 const key=legacySessionDraftKey(ownerScope);if(!key||!storage||typeof storage.getItem!=='function')return null;
 try{const raw=storage.getItem(key);if(!raw)return null;const value=JSON.parse(raw);if(value?.schema_version!==3||value.owner_scope!==ownerScope)return null;return createFileDraft(value);}catch{return null;}
}
function draftStorageKeys(storage,ownerScope){
 const prefix=`${SESSION_DRAFT_ENTRY_STORAGE_SLOT}.${ownerScope}.`;if(typeof storage?.key!=='function')return [];
 let length;try{length=Number(storage.length);}catch{return [];}
 if(!Number.isSafeInteger(length)||length<0)return [];
 const keys=[];for(let index=0;index<length;index++){try{const key=storage.key(index);if(typeof key==='string'&&key.startsWith(prefix))keys.push(key);}catch{break;}}
 return keys;
}

export function validateWorkspaceFilePath(value){
 if(typeof value!=='string'||!value||value.length>400||value.startsWith('/')||/^[A-Za-z]:/.test(value)||/[\\:\x00-\x1f]/.test(value))throw new Error('workspace_path_unsafe');
 const parts=value.split('/');
 if(parts.some(part=>!part||part==='.'||part==='..'||part.startsWith('.')||/[. ]$|[<>"|?*]/.test(part)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))throw new Error('workspace_path_unsafe');
 return value;
}

export function createFileDraft(value){
 if(!value||typeof value!=='object'||typeof value.owner_scope!=='string'||!OWNER_SCOPE_PATTERN.test(value.owner_scope)
  ||typeof value.workspace_id!=='string'||!value.workspace_id||value.workspace_id.length>128
  ||typeof value.project_id!=='string'||!value.project_id||value.project_id.length>128)throw new Error('workspace_file_draft_invalid');
 const path=validateWorkspaceFilePath(value.path),version=value.base_version,sha=value.base_sha256??null,content=value.content,baseContent=value.base_content??content;
 if(!Number.isSafeInteger(version)||version<0||typeof content!=='string'||textEncoder.encode(content).byteLength>MAX_FILE_BYTES
  ||typeof baseContent!=='string'||textEncoder.encode(baseContent).byteLength>MAX_FILE_BYTES
  ||(version===0?sha!==null:typeof sha!=='string'||! /^[a-f0-9]{64}$/.test(sha)))throw new Error('workspace_file_draft_invalid');
 return {schema_version:3,owner_scope:value.owner_scope,workspace_id:value.workspace_id,project_id:value.project_id,path,base_version:version,base_sha256:sha,base_content:baseContent,content};
}

function writeIndexedDraft(storage,draft){
 const indexKey=sessionDraftIndexKey(draft.owner_scope),entryKey=draftEntryKey(draft);
 if(!indexKey||!storage||typeof storage.getItem!=='function'||typeof storage.setItem!=='function'||typeof storage.removeItem!=='function')throw new Error('workspace_file_draft_storage_unavailable');
 const index=readDraftIndex(storage,draft.owner_scope,true),identity=draftIdentity(draft),identityKey=draftIdentityKey(draft.owner_scope,identity),isIndexed=index.items.some(item=>draftIdentityKey(draft.owner_scope,item)===identityKey);
 let previous;try{previous=storage.getItem(entryKey);}catch{throw new Error('workspace_file_draft_storage_unavailable');}
 let entryWritten=false;
 try{
  storage.setItem(entryKey,JSON.stringify(draft));entryWritten=true;
  if(!isIndexed)storage.setItem(indexKey,JSON.stringify({schema_version:1,owner_scope:draft.owner_scope,items:[...index.items,identity]}));
 }catch(error){
  if(entryWritten){try{if(previous===null||previous===undefined)storage.removeItem(entryKey);else storage.setItem(entryKey,previous);}catch{}}
  throw error;
 }
 return draft;
}

function draftPathCollision(existing){const error=new Error('workspace_file_draft_path_collision');error.candidate=existing;return error;}

export function writeSessionDraft(storage,value,{allowReplaceExisting=false}={}){
 if(!storage||typeof storage.setItem!=='function')throw new Error('workspace_file_draft_storage_unavailable');
 const draft=createFileDraft(value),existing=readSessionDraft(storage,{owner_scope:draft.owner_scope,workspace_id:draft.workspace_id,project_id:draft.project_id,path:draft.path});
 if(existing&&JSON.stringify(existing)!==JSON.stringify(draft)&&!allowReplaceExisting)throw draftPathCollision(existing);
 return writeIndexedDraft(storage,draft);
}

export function moveSessionDraft(storage,source,value){
 const draft=createFileDraft(value),previous=source?createFileDraft(source):null;
 if(previous&&draftIdentityKey(previous.owner_scope,draftIdentity(previous))===draftIdentityKey(draft.owner_scope,draftIdentity(draft)))return writeSessionDraft(storage,draft,{allowReplaceExisting:true});
 const existing=readSessionDraft(storage,{owner_scope:draft.owner_scope,workspace_id:draft.workspace_id,project_id:draft.project_id,path:draft.path});
 if(existing)throw draftPathCollision(existing);
 if(previous){
  const current=readSessionDraft(storage,{owner_scope:previous.owner_scope,workspace_id:previous.workspace_id,project_id:previous.project_id,path:previous.path});
  if(current&&JSON.stringify(current)!==JSON.stringify(previous))throw new Error('workspace_file_draft_source_changed');
 }
 const saved=writeSessionDraft(storage,draft);
 if(previous){const current=readSessionDraft(storage,{owner_scope:previous.owner_scope,workspace_id:previous.workspace_id,project_id:previous.project_id,path:previous.path});if(current&&!removeStoredSessionDraft(storage,current))throw new Error('workspace_file_draft_source_remove_failed');}
 return saved;
}

export function readStoredSessionDrafts(storage,ownerScope){
 if(!sessionDraftIndexKey(ownerScope)||!storage||typeof storage.getItem!=='function')return [];
 const drafts=new Map(),add=draft=>drafts.set(draftIdentityKey(ownerScope,draftIdentity(draft)),draft);
 const index=readDraftIndex(storage,ownerScope,false);
 for(const identity of index.items){const draft=readDraftEntry(storage,ownerScope,identity);if(draft)add(draft);}
 for(const key of draftStorageKeys(storage,ownerScope)){try{const raw=storage.getItem(key);if(!raw)continue;const value=JSON.parse(raw);if(value?.schema_version!==3||value.owner_scope!==ownerScope)continue;add(createFileDraft(value));}catch{}}
 const legacy=readLegacyDraft(storage,ownerScope),legacyKey=legacySessionDraftKey(ownerScope);
 if(legacy){
  const identity=draftIdentityKey(ownerScope,draftIdentity(legacy));
  if(!drafts.has(identity)){try{writeIndexedDraft(storage,legacy);try{storage.removeItem(legacyKey);}catch{}}catch{}add(legacy);}
  else{try{storage.removeItem(legacyKey);}catch{}}
 }
 return [...drafts.values()];
}

export function readStoredSessionDraft(storage,ownerScope){return readStoredSessionDrafts(storage,ownerScope)[0]??null;}

export function readSessionDrafts(storage,scope){
 if(!scope||typeof scope.workspace_id!=='string'||typeof scope.project_id!=='string'||!sessionDraftIndexKey(scope.owner_scope))return [];
 return readStoredSessionDrafts(storage,scope.owner_scope).filter(draft=>draft.workspace_id===scope.workspace_id&&draft.project_id===scope.project_id);
}

export function readSessionDraft(storage,scope){
 const drafts=readSessionDrafts(storage,scope);return typeof scope?.path==='string'?drafts.find(draft=>draft.path===scope.path)??null:drafts[0]??null;
}

export function removeStoredSessionDraft(storage,expected){
 if(!storage||typeof storage.getItem!=='function'||typeof storage.removeItem!=='function')return false;
 let normalized;try{normalized=createFileDraft(expected);}catch{return false;}
 const entryKey=draftEntryKey(normalized),legacyKey=legacySessionDraftKey(normalized.owner_scope);
 const draft=readDraftEntry(storage,normalized.owner_scope,draftIdentity(normalized));
 if(draft){if(JSON.stringify(draft)!==JSON.stringify(normalized))return false;try{storage.removeItem(entryKey);}catch{return false;}}
 else{const legacy=readLegacyDraft(storage,normalized.owner_scope);if(!legacy||JSON.stringify(legacy)!==JSON.stringify(normalized))return false;try{storage.removeItem(legacyKey);}catch{return false;}}
 const indexKey=sessionDraftIndexKey(normalized.owner_scope),index=readDraftIndex(storage,normalized.owner_scope,false),removedIdentity=draftIdentityKey(normalized.owner_scope,draftIdentity(normalized));
 if(index.ok&&index.raw!==null){const items=index.items.filter(item=>draftIdentityKey(normalized.owner_scope,item)!==removedIdentity);try{if(items.length)storage.setItem(indexKey,JSON.stringify({schema_version:1,owner_scope:normalized.owner_scope,items}));else storage.removeItem(indexKey);}catch{}}
 return true;
}

export function removeSessionDraft(storage,scope){
 if(!scope||typeof scope.path!=='string')return false;
 const draft=readSessionDraft(storage,scope);return draft?removeStoredSessionDraft(storage,draft):false;
}

export function fileEditorMatchesScope(state,scope){return Boolean(state&&scope&&state.owner_scope===scope.owner_scope&&state.workspace_id===scope.workspace_id&&state.project_id===scope.project_id);}
export function fileDraftMatchesOwner(draft,ownerScope){return Boolean(draft&&typeof ownerScope==='string'&&draft.owner_scope===ownerScope);}

export function reconcileFileDraft(draft,current){
 if(!draft||!current)return 'missing';
 if(draft.workspace_id!==current.workspace_id||draft.project_id!==current.project_id||draft.path!==current.path)return 'different-file';
 return draft.base_version===current.version&&draft.base_sha256===(current.sha256??null)?'same-base':'remote-changed';
}

export function createFileEditorState(value){
 const version=value?.version??0,sha=value?.sha256??null,content=value?.content??'';
 const draft=createFileDraft({owner_scope:value?.owner_scope,workspace_id:value?.workspace_id,project_id:value?.project_id,path:value?.path,base_version:version,base_sha256:sha,content});
 const {content:baseContent,...source}=draft;
 return {...source,base_path:source.path,base_content:baseContent,draft_content:baseContent,reviewing:false,apply_confirmed:false,conflict:null};
}

export function restoreFileDraft(candidate,latest){
 const draft=createFileDraft(candidate);
 if(draft.base_version>0&&!latest)throw new Error('workspace_file_restore_source_required');
 let state=createFileEditorState({owner_scope:draft.owner_scope,workspace_id:draft.workspace_id,project_id:draft.project_id,path:draft.path,version:draft.base_version,sha256:draft.base_sha256,content:draft.base_version===0?'':draft.base_content});
 state=editFileDraft(state,draft.content);
 if(latest&&(draft.base_version!==latest.version||draft.base_sha256!==latest.sha256))state=markFileConflict(state,latest);
 return state;
}

export function editorViewAvailable(state,restoreCandidates){return Boolean(state||(Array.isArray(restoreCandidates)?restoreCandidates.length:restoreCandidates));}

export function unrestoredSessionDraftForEditor(editor,candidates,pathCollision){
 if(!editor||editor.draft_restored||pathCollision||editor.draft_storage_path===editor.path||!Array.isArray(candidates))return null;
 return candidates.find(candidate=>candidate.owner_scope===editor.owner_scope&&candidate.workspace_id===editor.workspace_id&&candidate.project_id===editor.project_id&&candidate.path===editor.path)??null;
}
export function hasFileChanges(state){return !!state&&(state.base_version===0||state.path!==state.base_path||state.draft_content!==state.base_content);}

export function editFileDraft(state,content){
 if(!state||typeof content!=='string'||textEncoder.encode(content).byteLength>MAX_FILE_BYTES)throw new Error('workspace_file_draft_invalid');
 return {...state,draft_content:content,reviewing:false,apply_confirmed:false};
}

export function requestFileApply(state){
 if(!state)throw new Error('workspace_file_editor_invalid');
 return {...state,reviewing:hasFileChanges(state),apply_confirmed:false};
}

export function confirmFileApply(state){
 if(!state?.reviewing||!hasFileChanges(state))throw new Error('file_apply_review_required');
 return {...state,apply_confirmed:true};
}

export function fileApplyPayload(state){
 if(!state?.apply_confirmed||!hasFileChanges(state))throw new Error('explicit_apply_required');
 validateWorkspaceFilePath(state.path);
 if(textEncoder.encode(state.draft_content).byteLength>MAX_FILE_BYTES)throw new Error('workspace_file_content_too_large');
 return {project_id:state.project_id,path:state.path,content:state.draft_content,expected_version:state.base_version};
}

function conflictLatest(state,latest){
 if(!state||!latest||!Number.isSafeInteger(latest.version)||latest.version<1||typeof latest.sha256!=='string'||! /^[a-f0-9]{64}$/.test(latest.sha256)||typeof latest.content!=='string')throw new Error('workspace_file_conflict_invalid');
 return {workspace_id:state.workspace_id,project_id:state.project_id,path:state.path,version:latest.version,sha256:latest.sha256,content:latest.content,...(latest.updated_at?{updated_at:latest.updated_at}:{})};
}

export function markFileConflict(state,latest){
 const remote=conflictLatest(state,latest);
 return {...state,reviewing:false,apply_confirmed:false,conflict:{latest:remote,base:state.base_content,local:state.draft_content,remote:remote.content}};
}

export function rebaseFileDraft(state){
 if(!state?.conflict?.latest)throw new Error('workspace_file_conflict_missing');
 const latest=state.conflict.latest;
 return {...state,base_version:latest.version,base_sha256:latest.sha256,base_content:latest.content,reviewing:false,apply_confirmed:false,conflict:null};
}

export function reloadLatestFile(state){
 const next=rebaseFileDraft(state);
 return {...next,draft_content:next.base_content};
}

export async function verifyWorkspaceFileContent(request,response){
 if(!request||typeof request.workspace_id!=='string'||!request.workspace_id||typeof request.project_id!=='string'||!request.project_id
  ||!response||typeof response!=='object')throw new Error('workspace_file_source_mismatch');
 const path=validateWorkspaceFilePath(request.path);
 if(response.path!==path||!Number.isSafeInteger(response.version)||response.version<1||!Number.isSafeInteger(response.size)||response.size<0||response.size>MAX_FILE_BYTES
  ||typeof response.sha256!=='string'||! /^[a-f0-9]{64}$/.test(response.sha256)||typeof response.content!=='string'
  ||(request.version!==undefined&&response.version!==request.version)||(request.sha256!==undefined&&response.sha256!==request.sha256))throw new Error('workspace_file_source_mismatch');
 const bytes=textEncoder.encode(response.content);
 if(bytes.byteLength!==response.size||!globalThis.crypto?.subtle)throw new Error('workspace_file_source_mismatch');
 const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
 const actual=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
 if(actual!==response.sha256)throw new Error('workspace_file_source_mismatch');
 return {...response,workspace_id:request.workspace_id,project_id:request.project_id};
}

function boundedUtf8Text(value,maxBytes){
 let text='',bytes=0;
 for(const character of value){
  const size=textEncoder.encode(character).byteLength;
  if(bytes+size>maxBytes)break;
  text+=character;bytes+=size;
 }
 return {text,truncated:text.length<value.length};
}

export function workspaceFilePreview(path,content,{maxBytes=65536}={}){
 validateWorkspaceFilePath(path);
 if(typeof content!=='string'||!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new Error('workspace_file_preview_invalid');
 const extension=path.split('/').at(-1).split('.').at(-1).toLowerCase();
 if(['pdf','doc','docx','xls','xlsx','ppt','pptx'].includes(extension))return {kind:'unsupported',reason:'document-renderer-required'};
 const bounded=boundedUtf8Text(content,maxBytes);
 return {kind:'text',...bounded};
}

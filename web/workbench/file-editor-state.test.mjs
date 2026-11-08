import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fileDraftState from './file-editor-state.mjs';
import {createFileDraft,readSessionDraft,readStoredSessionDraft,writeSessionDraft,removeSessionDraft,removeStoredSessionDraft,fileEditorMatchesScope,fileDraftMatchesOwner,reconcileFileDraft,workspaceFilePreview,validateWorkspaceFilePath,createFileEditorState,editFileDraft,requestFileApply,confirmFileApply,fileApplyPayload,markFileConflict,rebaseFileDraft,reloadLatestFile,restoreFileDraft,verifyWorkspaceFileContent,editorViewAvailable} from './file-editor-state.mjs';

function storage(){
 const values=new Map();let writes=0,failAt=0;
 return {getItem:key=>values.get(key)??null,setItem(key,value){writes++;if(writes===failAt)throw new Error('QuotaExceededError');values.set(key,String(value));},removeItem:key=>values.delete(key),key:index=>[...values.keys()][index]??null,get length(){return values.size;},entries:()=>[...values.entries()],failNthWriteFromNow(offset){failAt=writes+offset;}};
}
const owner_scope='a'.repeat(64);
const base={owner_scope,workspace_id:'ws-one',project_id:'project-one',path:'src/main.ts',base_version:3,base_sha256:'b'.repeat(64),content:'const answer = 42;'};

test('editing file B keeps file A as a separate session draft that can be recovered after refresh',()=>{
 const store=storage(),draftA=createFileDraft({...base,path:'notes/draft-a.txt',base_content:'source A',content:'local A'}),draftB=createFileDraft({...base,path:'notes/draft-b.txt',base_content:'source B',content:'local B'});
 writeSessionDraft(store,draftA);writeSessionDraft(store,draftB);
 const recovered=fileDraftState.readStoredSessionDrafts?.(store,owner_scope)??[];
 assert.deepEqual(recovered.map(({path,content})=>({path,content})),[
  {path:'notes/draft-a.txt',content:'local A'},
  {path:'notes/draft-b.txt',content:'local B'},
 ]);
});

test('draft recovery index filters by workspace, project, and owner without overwriting other scopes',()=>{
 const store=storage(),otherOwner='c'.repeat(64),draftA=createFileDraft({...base,path:'notes/a.txt',content:'A'}),draftProject=createFileDraft({...base,project_id:'project-two',path:'notes/b.txt',content:'B'}),draftOwner=createFileDraft({...base,owner_scope:otherOwner,path:'notes/c.txt',content:'C'});
 writeSessionDraft(store,draftA);writeSessionDraft(store,draftProject);writeSessionDraft(store,draftOwner);
 const list=(owner_scope,project_id)=>fileDraftState.readSessionDrafts?.(store,{owner_scope,workspace_id:'ws-one',project_id})??[];
 assert.deepEqual(list(owner_scope,'project-one').map(draft=>draft.path),['notes/a.txt']);
 assert.deepEqual(list(owner_scope,'project-two').map(draft=>draft.path),['notes/b.txt']);
 assert.deepEqual(list(otherOwner,'project-one').map(draft=>draft.path),['notes/c.txt']);
});

test('discarding one file removes only that file draft and preserves siblings',()=>{
 const store=storage(),draftA=createFileDraft({...base,path:'notes/a.txt',content:'A'}),draftB=createFileDraft({...base,path:'notes/b.txt',content:'B'});
 writeSessionDraft(store,draftA);writeSessionDraft(store,draftB);
 assert.equal(removeStoredSessionDraft(store,draftA),true);
 assert.deepEqual((fileDraftState.readStoredSessionDrafts?.(store,owner_scope)??[]).map(draft=>draft.path),['notes/b.txt']);
 assert.equal(removeSessionDraft(store,{owner_scope,workspace_id:'ws-one',project_id:'project-one',path:'notes/b.txt'}),true);
 assert.deepEqual(fileDraftState.readStoredSessionDrafts?.(store,owner_scope)??[],[]);
});

test('legacy owner-scoped single draft migrates into the indexed per-file store',()=>{
 const store=storage(),legacy=createFileDraft({...base,path:'notes/legacy.txt',content:'legacy local'}),legacyKey=`jot.workbench.file-draft.v2.${owner_scope}`;
 store.setItem(legacyKey,JSON.stringify(legacy));
 const recovered=fileDraftState.readStoredSessionDrafts?.(store,owner_scope)??[];
 assert.deepEqual(recovered.map(({path,content})=>({path,content})),[{path:'notes/legacy.txt',content:'legacy local'}]);
 assert.equal(store.getItem(legacyKey),null);
});

test('quota failure while adding a second draft preserves the earlier draft and rolls back the new entry',()=>{
 const store=storage(),draftA=createFileDraft({...base,path:'notes/a.txt',content:'A'}),draftB=createFileDraft({...base,path:'notes/b.txt',content:'B'});
 writeSessionDraft(store,draftA);
 store.failNthWriteFromNow(2);
 assert.throws(()=>writeSessionDraft(store,draftB),/QuotaExceededError/);
 assert.deepEqual((fileDraftState.readStoredSessionDrafts?.(store,owner_scope)??[]).map(draft=>draft.path),['notes/a.txt']);
});

test('a version-zero draft cannot overwrite a different draft at its renamed target path',()=>{
 const store=storage(),draftA=createFileDraft({...base,path:'notes/new-a.txt',base_version:0,base_sha256:null,base_content:'',content:'local A'}),draftB=createFileDraft({...base,path:'notes/new-b.txt',base_version:0,base_sha256:null,base_content:'',content:'local B'});
 writeSessionDraft(store,draftA);writeSessionDraft(store,draftB);
 assert.throws(()=>writeSessionDraft(store,{...draftA,path:draftB.path}),/workspace_file_draft_path_collision/);
 assert.equal(readSessionDraft(store,{owner_scope,workspace_id:'ws-one',project_id:'project-one',path:draftA.path}).content,'local A');
 assert.equal(readSessionDraft(store,{owner_scope,workspace_id:'ws-one',project_id:'project-one',path:draftB.path}).content,'local B');
});

test('moving a version-zero draft to an unused path keeps only its new identity after success',()=>{
 const store=storage(),draftA=createFileDraft({...base,path:'notes/move-a.txt',base_version:0,base_sha256:null,base_content:'',content:'local A'}),target={...draftA,path:'notes/move-free.txt'};
 writeSessionDraft(store,draftA);
 const moved=fileDraftState.moveSessionDraft?.(store,draftA,target);
 assert.equal(moved?.path,target.path);
 assert.deepEqual((fileDraftState.readSessionDrafts?.(store,{owner_scope,workspace_id:'ws-one',project_id:'project-one'})??[]).map(draft=>draft.path),[target.path]);
 assert.equal(readSessionDraft(store,{owner_scope,workspace_id:'ws-one',project_id:'project-one',path:target.path}).content,'local A');
});

test('entry and index quota failures while moving preserve the original draft and leave no target entry',()=>{
 for(const failedWrite of [1,2]){
  const store=storage(),draftA=createFileDraft({...base,path:`notes/quota-${failedWrite}-a.txt`,base_version:0,base_sha256:null,base_content:'',content:'local A'}),target={...draftA,path:`notes/quota-${failedWrite}-free.txt`};
  writeSessionDraft(store,draftA);store.failNthWriteFromNow(failedWrite);
  assert.throws(()=>fileDraftState.moveSessionDraft?.(store,draftA,target),/QuotaExceededError/);
  assert.equal(readSessionDraft(store,{owner_scope,workspace_id:'ws-one',project_id:'project-one',path:draftA.path}).content,'local A');
  assert.equal(readSessionDraft(store,{owner_scope,workspace_id:'ws-one',project_id:'project-one',path:target.path}),null);
 }
});

test('the same target path remains independent across signed-in owners',()=>{
 const store=storage(),otherOwner='c'.repeat(64),draftA=createFileDraft({...base,path:'notes/shared-name.txt',base_version:0,base_sha256:null,base_content:'',content:'owner A'}),draftB=createFileDraft({...base,owner_scope:otherOwner,path:'notes/shared-name.txt',base_version:0,base_sha256:null,base_content:'',content:'owner B'});
 writeSessionDraft(store,draftB);
 assert.doesNotThrow(()=>writeSessionDraft(store,draftA));
 assert.equal(readSessionDraft(store,{owner_scope,workspace_id:'ws-one',project_id:'project-one',path:draftA.path}).content,'owner A');
 assert.equal(readSessionDraft(store,{owner_scope:otherOwner,workspace_id:'ws-one',project_id:'project-one',path:draftB.path}).content,'owner B');
});

test('workspace paths accept only relative project paths supported by the existing file contract',()=>{
 assert.equal(validateWorkspaceFilePath('src/main.ts'),'src/main.ts');
 for(const path of ['/tmp/file','C:/Users/'+'name/file','src/../secrets','src/.env','notes/trailing.','notes/bad?.txt','\\server\\share']){
  assert.throws(()=>validateWorkspaceFilePath(path),/workspace_path_unsafe/);
 }
});

test('session draft restores only in the same workspace and project scope',()=>{
 const store=storage(),draft=createFileDraft(base);
 writeSessionDraft(store,draft);
 assert.deepEqual(readSessionDraft(store,{owner_scope,workspace_id:'ws-one',project_id:'project-one'}),draft);
 assert.equal(readSessionDraft(store,{owner_scope,workspace_id:'ws-two',project_id:'project-one'}),null);
 assert.equal(readSessionDraft(store,{owner_scope,workspace_id:'ws-one',project_id:'project-two'}),null);
 assert.equal(readSessionDraft(store,{owner_scope:'b'.repeat(64),workspace_id:'ws-one',project_id:'project-one'}),null);
});

test('a draft from another selected scope remains detectable until restored or discarded',()=>{
 const store=storage(),draft=createFileDraft(base);writeSessionDraft(store,draft);
 assert.deepEqual(readStoredSessionDraft(store,owner_scope),draft);
 assert.equal(readSessionDraft(store,{owner_scope,workspace_id:'ws-two',project_id:'project-two'}),null);
 assert.equal(removeStoredSessionDraft(store,{...draft,path:'src/other.ts'}),false);
 assert.deepEqual(readStoredSessionDraft(store,owner_scope),draft);
 assert.equal(removeStoredSessionDraft(store,draft),true);
 assert.equal(readStoredSessionDraft(store,owner_scope),null);
});

test('file drafts are isolated by the signed-in owner scope',()=>{
 const store=storage(),draft=createFileDraft(base);writeSessionDraft(store,draft);
 assert.equal(fileDraftMatchesOwner(draft,owner_scope),true);
 assert.equal(fileDraftMatchesOwner(draft,'b'.repeat(64)),false);
 assert.equal(readStoredSessionDraft(store,'b'.repeat(64)),null);
 assert.equal(readSessionDraft(store,{owner_scope:'b'.repeat(64),workspace_id:'ws-one',project_id:'project-one'}),null);
 assert.equal(removeStoredSessionDraft(store,{...draft,owner_scope:'b'.repeat(64)}),false);
 assert.deepEqual(readStoredSessionDraft(store,owner_scope),draft);
});

test('discarding a same-scope draft removes only its path-scoped session entry',()=>{
 const store=storage(),draft=createFileDraft(base),scope={owner_scope,workspace_id:'ws-one',project_id:'project-one'};
 writeSessionDraft(store,draft);
 assert.equal(removeSessionDraft(store,{...scope,path:draft.path}),true);
 assert.equal(readStoredSessionDraft(store,owner_scope),null);
 assert.equal(removeSessionDraft(store,{...scope,path:draft.path,owner_scope:'b'.repeat(64)}),false);
});

test('session drafts retain the original base text needed for conflict comparison',()=>{
 const store=storage(),draft=createFileDraft({...base,base_content:'original text',content:'local text'});
 writeSessionDraft(store,draft);
 assert.equal(readSessionDraft(store,{owner_scope,workspace_id:'ws-one',project_id:'project-one'}).base_content,'original text');
 assert.equal(readSessionDraft(store,{owner_scope,workspace_id:'ws-one',project_id:'project-one'}).content,'local text');
});

test('the editor view stays mounted when a same-scope session draft awaits explicit restore',()=>{
 const store=storage();writeSessionDraft(store,{...base,base_content:'original text',content:'local text'});
 const draft=readSessionDraft(store,{owner_scope,workspace_id:'ws-one',project_id:'project-one'});
 assert.equal(editorViewAvailable(null,draft),true);
 assert.equal(editorViewAvailable(null,null),false);
 assert.equal(editorViewAvailable(createFileEditorState({...base,version:3,sha256:base.base_sha256}),null),true);
 assert.equal(editorViewAvailable(null,[]),false);
 assert.equal(editorViewAvailable(null,[draft]),true);
});

test('only an unowned session draft at the editor path blocks writing while a collision can be redirected',()=>{
 const candidate=createFileDraft({...base,path:'notes/draft-b.txt',content:'saved draft'}),editor=createFileEditorState({...base,path:candidate.path,version:0,sha256:null,content:''}),resolveCandidate=fileDraftState.unrestoredSessionDraftForEditor;
 assert.equal(resolveCandidate?.(editor,[candidate]),candidate,'a file opened before restoring its stored draft remains read-only');
 assert.equal(resolveCandidate?.({...editor,draft_storage_path:candidate.path},[candidate]),null,'the current editor can keep editing its own persisted draft');
 assert.equal(resolveCandidate?.({...editor,draft_storage_path:'notes/draft-a.txt'},[candidate],{target:candidate}),null,'a collision leaves the path field available so the source can be redirected');
});

test('an editor is persisted only in its original workspace and project scope',()=>{
 const state=createFileEditorState({...base,version:3,sha256:base.base_sha256});
 assert.equal(fileEditorMatchesScope(state,{owner_scope,workspace_id:'ws-one',project_id:'project-one'}),true);
 assert.equal(fileEditorMatchesScope(state,{owner_scope:'b'.repeat(64),workspace_id:'ws-one',project_id:'project-one'}),false);
 assert.equal(fileEditorMatchesScope(state,{owner_scope,workspace_id:'ws-two',project_id:'project-one'}),false);
 assert.equal(fileEditorMatchesScope(state,{owner_scope,workspace_id:'ws-one',project_id:'project-two'}),false);
});

test('draft reconciliation detects the same immutable source, changed version, changed digest, and missing source',()=>{
 const draft=createFileDraft(base),same={workspace_id:'ws-one',project_id:'project-one',path:'src/main.ts',version:3,sha256:'b'.repeat(64)};
 assert.equal(reconcileFileDraft(draft,same),'same-base');
 assert.equal(reconcileFileDraft(draft,{...same,version:4}),'remote-changed');
 assert.equal(reconcileFileDraft(draft,{...same,sha256:'c'.repeat(64)}),'remote-changed');
 assert.equal(reconcileFileDraft(draft,null),'missing');
 assert.equal(reconcileFileDraft(draft,{...same,path:'src/other.ts'}),'different-file');
});

test('HTML and SVG remain bounded plain-text previews while Office/PDF await a safe renderer',()=>{
 assert.deepEqual(workspaceFilePreview('docs/index.html','<script>alert(1)</script>',{maxBytes:8}),{kind:'text',text:'<script>',truncated:true});
 assert.deepEqual(workspaceFilePreview('assets/icon.svg','<svg/>',{maxBytes:64}),{kind:'text',text:'<svg/>',truncated:false});
 assert.deepEqual(workspaceFilePreview('docs/guide.pdf','%PDF-1.7',{maxBytes:64}),{kind:'unsupported',reason:'document-renderer-required'});
 assert.deepEqual(workspaceFilePreview('docs/guide.docx','binary',{maxBytes:64}),{kind:'unsupported',reason:'document-renderer-required'});
});

test('writing requires a reviewed draft and an explicit apply confirmation with the original version',()=>{
 let state=createFileEditorState({owner_scope,workspace_id:'ws-one',project_id:'project-one',path:'src/main.ts',version:3,sha256:'b'.repeat(64),content:'old'});
 state=editFileDraft(state,'new');
 assert.throws(()=>fileApplyPayload(state),/explicit_apply_required/);
 state=requestFileApply(state);
 assert.throws(()=>fileApplyPayload(state),/explicit_apply_required/);
 state=confirmFileApply(state);
 assert.deepEqual(fileApplyPayload(state),{project_id:'project-one',path:'src/main.ts',content:'new',expected_version:3});
 assert.throws(()=>fileApplyPayload({...state,path:'C:/private/.env'}),/workspace_path_unsafe/);
});

test('creating an empty file still passes review and explicit confirmation before expected-version zero',()=>{
 let state=createFileEditorState({owner_scope,workspace_id:'ws-one',project_id:'project-one',path:'untitled.txt',version:0,sha256:null,content:''});
 assert.throws(()=>fileApplyPayload(state),/explicit_apply_required/);
 state=requestFileApply(state);
 assert.equal(state.reviewing,true);
 state=confirmFileApply(state);
 assert.deepEqual(fileApplyPayload(state),{project_id:'project-one',path:'untitled.txt',content:'',expected_version:0});
});

test('a version-zero draft restores without a server file read and keeps expected-version zero',()=>{
 const candidate=createFileDraft({...base,path:'notes/new.txt',base_version:0,base_sha256:null,base_content:'',content:'local new file'});
 const state=restoreFileDraft(candidate,null);
 assert.equal(state.path,'notes/new.txt');assert.equal(state.base_version,0);assert.equal(state.draft_content,'local new file');
 assert.deepEqual(fileApplyPayload(confirmFileApply(requestFileApply(state))),{project_id:'project-one',path:'notes/new.txt',content:'local new file',expected_version:0});
 assert.throws(()=>restoreFileDraft({...candidate,base_version:3,base_sha256:'b'.repeat(64)},null),/workspace_file_restore_source_required/);
});

test('version conflict preserves local text and requires a fresh review after rebasing',()=>{
 let state=createFileEditorState({owner_scope,workspace_id:'ws-one',project_id:'project-one',path:'src/main.ts',version:3,sha256:'b'.repeat(64),content:'base'});
 state=editFileDraft(state,'local draft');
 state=markFileConflict(state,{version:4,sha256:'c'.repeat(64),content:'remote edit'});
 assert.equal(state.draft_content,'local draft');
 assert.equal(state.conflict.remote,'remote edit');
 state=rebaseFileDraft(state);
 assert.equal(state.base_version,4);
 assert.equal(state.base_content,'remote edit');
 assert.equal(state.draft_content,'local draft');
 assert.throws(()=>fileApplyPayload(state),/explicit_apply_required/);
 state=confirmFileApply(requestFileApply(state));
 assert.equal(fileApplyPayload(state).expected_version,4);
});

test('loading the latest version deliberately replaces a stale local draft',()=>{
 let state=createFileEditorState({owner_scope,workspace_id:'ws-one',project_id:'project-one',path:'src/main.ts',version:3,sha256:'b'.repeat(64),content:'base'});
 state=markFileConflict(editFileDraft(state,'local draft'),{version:4,sha256:'c'.repeat(64),content:'remote edit'});
 state=reloadLatestFile(state);
 assert.equal(state.base_version,4);
 assert.equal(state.draft_content,'remote edit');
 assert.equal(state.conflict,null);
 assert.throws(()=>fileApplyPayload(state),/explicit_apply_required/);
});

test('file content must match the requested relative path, version, size, digest and list snapshot',async()=>{
 const content='source-controlled text';
 const sha256=createHash('sha256').update(content,'utf8').digest('hex');
 const request={workspace_id:'ws-one',project_id:'project-one',path:'src/main.ts',version:3,sha256};
 const response={path:'src/main.ts',version:3,sha256,size:Buffer.byteLength(content),updated_at:'2026-10-21T01:00:00.000Z',content};
 assert.deepEqual(await verifyWorkspaceFileContent(request,response),{...response,workspace_id:'ws-one',project_id:'project-one'});
 await assert.rejects(verifyWorkspaceFileContent(request,{...response,path:'C:/host/source.ts'}),/workspace_file_source_mismatch/);
 await assert.rejects(verifyWorkspaceFileContent(request,{...response,version:4}),/workspace_file_source_mismatch/);
 await assert.rejects(verifyWorkspaceFileContent(request,{...response,sha256:'c'.repeat(64)}),/workspace_file_source_mismatch/);
 await assert.rejects(verifyWorkspaceFileContent(request,{...response,size:1}),/workspace_file_source_mismatch/);
 await assert.rejects(verifyWorkspaceFileContent(request,{...response,content:'tampered'}),/workspace_file_source_mismatch/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {createTools} from '../src/tools.mjs';
const browserFixtureRoot=join(process.cwd(),'.test-tmp','browser-action-fixture');

function fixture(){
 const store=new Store(':memory:');
 const run=store.accept(store.createConversation().id,'browser fixture','request-1').run;
 const state={url:'about:blank',text:'Welcome',controls:[],routeHandler:undefined};state.controls=[
  {tag:'BUTTON',role:'button',name:'Continue',type:'',disabled:false,visible:true},
  {tag:'INPUT',role:'textbox',name:'Search',type:'text',disabled:false,visible:true},
 ];
 let clicks=0,eventsAtClick=[];
 const page={
  url:()=>state.url,
  goto:async url=>{state.url=url;},
  title:async()=> 'Fixture',
  evaluate:async(_fn,ids)=>{
   if(Array.isArray(ids)){state.candidateIds=[...ids];return;}
   return {url:state.url,title:'Fixture',text:state.text,controls:structuredClone(state.controls)};
  },
  locator:selector=>{
   if(selector==='body')return{innerText:async()=>state.text};
   const id=/data-jot-candidate="([a-f0-9]+)"/.exec(selector)?.[1];
   const index=state.candidateIds?.indexOf(id)??-1;
   return{
    count:async()=>index>=0?(state.duplicateCandidate?2:1):0,
    isVisible:async()=>index>=0&&state.controls[index].visible,
    isEnabled:async()=>index>=0&&!state.controls[index].disabled,
    click:async()=>{eventsAtClick=store.events(run.conversation_id,0).filter(event=>event.type.startsWith('browser.operation.'));clicks++;state.text='Completed';if(state.failClick)throw Error('fixture_click_after_dispatch');},
    fill:async value=>{state.filled=value;},
    scrollIntoViewIfNeeded:async()=>{state.text='Scrolled';},
   };
  },
  screenshot:async()=>Buffer.from(''),
 };
 const browserFactory=async()=>({newContext:async()=>({route:async(_pattern,handler)=>{state.routeHandler=handler;},pages:()=>[page],newPage:async()=>page,close:async()=>{}}),close:async()=>{}});
 const tools=createTools({store,root:join(browserFixtureRoot,'files'),browserProfilesRoot:join(browserFixtureRoot,'profiles'),origins:new Set(['https://example.com']),browserEnabled:true,browserFactory});
 const approvals=[];
 const context=(callId)=>({run,callId,signal:new AbortController().signal,approve:async(description,operation)=>{approvals.push({description,operation});}});
 return {store,run,state,tools,approvals,context,clicks:()=>clicks,eventsAtClick:()=>eventsAtClick,close:async()=>{await tools.close();store.close();}};
}

test('browser read returns revision-bound control candidates',async t=>{
 const f=fixture();t.after(f.close);
 const definition=f.tools.definitions.find(item=>item.function.name==='browser_action').function.parameters;
 assert.equal(definition.additionalProperties,false);assert.equal(definition.properties.selector,undefined);
 assert.deepEqual(definition.properties.action.enum,['read','click','fill','scroll','screenshot']);
 const result=await f.tools.execute('browser_action',{url:'https://example.com/start',action:'read'},f.context('read-1'));
 assert.equal(result.url,'https://example.com/start');
 assert.match(result.page_revision,/^[a-f0-9]{64}$/);
 assert.equal(result.candidates.length,2);
 assert.ok(result.candidates.every(item=>/^[a-f0-9]{24}$/.test(item.candidate_id)));
 assert.deepEqual(result.candidates.map(item=>item.name),['Continue','Search']);
 assert.equal(result.untrusted,true);
});
test('browser operation public events redact page details while private custody retains replay data',async t=>{
 const f=fixture();t.after(f.close);
 const url='https://example.com/private/profile?token=private-url-marker#private-fragment';
 const pageMarker='private-page-content-marker';f.state.text=pageMarker;
 const result=await f.tools.execute('browser_action',{url,action:'read'},f.context('read-private-custody'));
 assert.equal(result.url,url);assert.match(result.text,new RegExp(pageMarker));
 const publicEvents=f.store.events(f.run.conversation_id,0).filter(event=>event.type.startsWith('browser.operation.'));
 assert.ok(publicEvents.some(event=>event.data.request_hash===result.browser_receipt.request_hash));
 assert.ok(publicEvents.some(event=>event.data.operation_id===result.browser_receipt.operation_id&&event.data.status==='succeeded'));
 assert.doesNotMatch(JSON.stringify(publicEvents),/private-url-marker|private-fragment|private-page-content-marker|\/private\/profile/);
 const persisted=f.store.db.prepare("SELECT data FROM events WHERE conversation_id=? AND type LIKE 'browser.operation.%'").all(f.run.conversation_id);
 assert.doesNotMatch(JSON.stringify(persisted),/private-url-marker|private-fragment|private-page-content-marker|\/private\/profile/);
 const custody=f.store.browserOperationEvents(f.run.conversation_id);
 assert.match(JSON.stringify(custody),/private-url-marker|private-fragment|private-page-content-marker|\/private\/profile/);
});
test('legacy browser operation rows stay redacted publicly and remain available to the internal replay reader',async t=>{
 const f=fixture();t.after(f.close);
 const data={kind:'browser_operation',operation_id:'legacy-operation',run_id:f.run.id,call_id:'legacy-call',request_hash:'a'.repeat(64),action:'read',
  url:'https://example.com/private/legacy?token=legacy-url-marker#legacy-fragment',status:'succeeded',
  browser_receipt:{kind:'browser_operation_receipt',operation_id:'legacy-operation',run_id:f.run.id,call_id:'legacy-call',request_hash:'a'.repeat(64),
   action:'read',url:'https://example.com/private/legacy?token=legacy-url-marker#legacy-fragment',status:'succeeded'},
  result:{url:'https://example.com/private/legacy?token=legacy-url-marker#legacy-fragment',text:'legacy-page-content-marker'}};
 f.store.db.prepare('INSERT INTO events(conversation_id,type,data) VALUES(?,?,?)').run(f.run.conversation_id,'browser.operation.succeeded',JSON.stringify(data));
 const publicRows=f.store.events(f.run.conversation_id,0).filter(event=>event.type==='browser.operation.succeeded');
 assert.equal(publicRows.length,1);
 assert.doesNotMatch(JSON.stringify(publicRows),/legacy-url-marker|legacy-fragment|legacy-page-content-marker|\/private\/legacy/);
 const internalRows=f.store.browserOperationEvents(f.run.conversation_id);
 assert.deepEqual(internalRows.at(-1).data,data);
});
test('browser operation event and private custody follow the surrounding SQLite transaction',()=>{
 const store=new Store(':memory:');
 try{
  const conversation=store.createConversation();
  store.db.exec('BEGIN IMMEDIATE');
  store.event(conversation.id,'browser.operation.accepted',{kind:'browser_operation',operation_id:'atomic-operation',run_id:'atomic-run',call_id:'atomic-call',
   request_hash:'b'.repeat(64),action:'read',url:'https://example.com/private/atomic?secret=atomic-marker',status:'accepted',
   browser_receipt:{kind:'browser_operation_receipt',operation_id:'atomic-operation',run_id:'atomic-run',call_id:'atomic-call',request_hash:'b'.repeat(64),action:'read',status:'accepted'}});
  assert.equal(store.events(conversation.id,0).filter(event=>event.type==='browser.operation.accepted').length,1);
  assert.equal(store.browserOperationEvents(conversation.id).length,1);
  store.db.exec('ROLLBACK');
  assert.equal(store.events(conversation.id,0).filter(event=>event.type==='browser.operation.accepted').length,0);
  assert.deepEqual(store.browserOperationEvents(conversation.id),[]);
 }finally{store.close();}
});
test('browser-operation projection leaves owner approval details in the snapshot and event stream',()=>{
 const store=new Store(':memory:');
 try{
  const conversation=store.createConversation(),run=store.accept(conversation.id,'approve browser fill','approval-receipt').run;
  store.state(run.id,'waiting_approval');
  const approval={run_id:run.id,approval_id:'approval-private-fill',description:'Browser fill https://example.com/private/profile?token=approval-url-marker · private-fill-marker',
   operation:{tool:'browser_action',operation_id:'approval-operation',call_id:'approval-call',request_hash:'c'.repeat(64),action:'fill',
    url:'https://example.com/private/profile?token=approval-url-marker',text:'private-fill-marker',target:{role:'textbox',name:'Private field'}}};
  store.event(conversation.id,'approval.request',approval);
  assert.deepEqual(store.snapshot(conversation.id).approval,approval);
  assert.deepEqual(store.events(conversation.id,0).find(event=>event.type==='approval.request').data,approval);
 }finally{store.close();}
});
test('browser profile is private, stable for its owner and restored after tool recreation',async t=>{
 const scratch=join(process.cwd(),'.test-tmp');await mkdir(scratch,{recursive:true});const root=await mkdtemp(join(scratch,'browser-profile-owner-'));
 const profiles=join(root,'private-browser-profiles'),profileStates=new Map(),launches=[];
 const factory=async({userDataDir})=>{
  launches.push(userDataDir);let state=profileStates.get(userDataDir);if(!state){state={url:'about:blank',launches:0,closes:0};profileStates.set(userDataDir,state);}state.launches++;
  const page={url:()=>state.url,goto:async url=>{state.url=url;},title:async()=> 'Owner Profile',evaluate:async(_fn,ids)=>Array.isArray(ids)?undefined:{url:state.url,title:'Owner Profile',text:'Owner profile fixture',controls:[]}};
  return {persistentContext:{route:async()=>{},pages:()=>[page],newPage:async()=>page,close:async()=>{state.closes++;}}};
 };
 const owners=[],make=(owner)=>{const store=new Store(join(root,'states',createHash('sha256').update(owner).digest('hex')+'.sqlite'));const conversation=store.createConversation('profile owner').id,run=store.accept(conversation,'open owner profile',randomUUID()).run;
  const tools=createTools({store,root:join(root,'files'),browserProfilesRoot:profiles,browserOwnerId:owner,origins:new Set(['https://example.com']),browserEnabled:true,browserFactory:factory});
  const value={store,conversation,run,tools,context:(activeRun,callId)=>({run:activeRun,callId,signal:new AbortController().signal,approve:async()=>{}}),close:async()=>{await tools.close();store.close();}};owners.push(value);return value;
 };
 const ownerA=make('private owner alpha');t.after(async()=>{for(const owner of owners)await owner.close();await rm(root,{recursive:true,force:true});});
 const first=await ownerA.tools.execute('browser_action',{url:'https://example.com/first',action:'read'},ownerA.context(ownerA.run,'profile-first'));
 assert.equal(first.url,'https://example.com/first');assert.equal(launches.length,1);
 const firstProfile=launches[0];assert.ok(firstProfile.startsWith(profiles));assert.doesNotMatch(firstProfile,/private owner alpha/);assert.match(firstProfile,/^[A-Za-z]:\\.*[a-f0-9]{64}$/);await stat(firstProfile);
 const secondConversation=ownerA.store.createConversation('same owner other conversation').id,secondRun=ownerA.store.accept(secondConversation,'reuse owner profile',randomUUID()).run;
 const second=await ownerA.tools.execute('browser_action',{url:'https://example.com/second',action:'read'},ownerA.context(secondRun,'profile-second'));
 assert.equal(second.url,'https://example.com/second');assert.equal(launches.length,1,'sessions for one owner share one persistent browser context');
 await ownerA.tools.close();
 const ownerARestored=make('private owner alpha');
 const restored=await ownerARestored.tools.execute('browser_action',{url:'https://example.com/restored',action:'read'},ownerARestored.context(ownerARestored.run,'profile-restored'));
 assert.equal(restored.url,'https://example.com/restored');assert.equal(launches[1],firstProfile,'a new tool instance reopens the original owner profile');assert.equal(profileStates.get(firstProfile).launches,2);
 const ownerB=make('private owner beta');
 const isolated=await ownerB.tools.execute('browser_action',{url:'https://example.com/isolated',action:'read'},ownerB.context(ownerB.run,'profile-other-owner'));
 assert.equal(isolated.url,'https://example.com/isolated');assert.notEqual(launches[2],firstProfile);assert.doesNotMatch(launches[2],/private owner beta/);
});
test('browser input rejects caller-injected owner and lease fields',async t=>{
 const f=fixture();t.after(f.close);
 await assert.rejects(()=>f.tools.execute('browser_action',{url:'https://example.com/start',action:'read',owner_id:'other-owner',execution_lease:'forged'},f.context('read-forged-context')),/invalid_browser_action/);
 assert.equal(f.state.routeHandler,undefined);
});
test('browser route guard falls through only for allowlisted HTTPS requests',async t=>{
 const f=fixture();t.after(f.close);
 await f.tools.execute('browser_action',{url:'https://example.com/start',action:'read'},f.context('read-route-guard'));
 let fallbacks=0,aborts=0;
 const route=url=>({request:()=>({url:()=>url}),fallback:async()=>{fallbacks++;},abort:async()=>{aborts++;}});
 await f.state.routeHandler(route('https://example.com/fixture'));
 await f.state.routeHandler(route('https://evil.example/fixture'));
 await f.state.routeHandler(route('http://example.com/insecure'));
 assert.equal(fallbacks,1);assert.equal(aborts,2);
});
test('browser factory failure can retry on the next read',async t=>{
 const store=new Store(':memory:'),run=store.accept(store.createConversation().id,'retry browser','retry-1').run;
 let launches=0,url='about:blank';
 const page={url:()=>url,goto:async value=>{url=value;},title:async()=> 'Fixture',evaluate:async(_fn,ids)=>Array.isArray(ids)?undefined:{url,title:'Fixture',text:'Fixture',controls:[]}};
 const browserFactory=async()=>{launches++;if(launches===1)throw Error('fixture_launch_failure');return{newContext:async()=>({route:async()=>{},pages:()=>[page],newPage:async()=>page,close:async()=>{}}),close:async()=>{}};};
 const tools=createTools({store,root:join(browserFixtureRoot,'files'),browserProfilesRoot:join(browserFixtureRoot,'profiles'),origins:new Set(['https://example.com']),browserEnabled:true,browserFactory});
 t.after(async()=>{await tools.close();store.close();});
 const context=callId=>({run,callId,signal:new AbortController().signal,approve:async()=>{}});
 const first=await tools.execute('browser_action',{url:'https://example.com/retry',action:'read'},context('retry-first'));
 assert.equal(first.error,'browser_action_failed');
 const second=await tools.execute('browser_action',{url:'https://example.com/retry',action:'read'},context('retry-second'));
 assert.equal(second.url,'https://example.com/retry',JSON.stringify({second,launches}));assert.equal(launches,2);
});
test('explicit tools close is terminal for that instance and does not relaunch Browser',async t=>{
 const store=new Store(':memory:'),run=store.accept(store.createConversation().id,'closed browser','close-1').run;
 let launches=0,browserCloses=0,url='about:blank';
 const page={url:()=>url,goto:async value=>{url=value;},title:async()=> 'Fixture',evaluate:async(_fn,ids)=>Array.isArray(ids)?undefined:{url,title:'Fixture',text:'Fixture',controls:[]}};
 const browserFactory=async()=>{launches++;return{newContext:async()=>({route:async()=>{},pages:()=>[page],newPage:async()=>page,close:async()=>{}}),close:async()=>{browserCloses++;}};};
 const tools=createTools({store,root:join(browserFixtureRoot,'files'),browserProfilesRoot:join(browserFixtureRoot,'profiles'),origins:new Set(['https://example.com']),browserEnabled:true,browserFactory});
 t.after(async()=>{await tools.close();store.close();});
 const context=callId=>({run,callId,signal:new AbortController().signal,approve:async()=>{}});
 const opened=await tools.execute('browser_action',{url:'https://example.com/close',action:'read'},context('close-before'));
 assert.equal(opened.url,'https://example.com/close');assert.equal(launches,1);
 await tools.close();await tools.close();
 const afterClose=await tools.execute('browser_action',{url:'https://example.com/close',action:'read'},context('close-after'));
 assert.equal(afterClose.error,'browser_driver_closed');
 assert.equal(launches,1);assert.equal(browserCloses,1);
});
test('unexpected browser context close evicts only that owner cache and allows recovery',async t=>{
 const root=await mkdtemp(join(browserFixtureRoot,'unexpected-context-close-'));
 const store=new Store(':memory:'),conversationA=store.createConversation('owner A'),conversationB=store.createConversation('owner B');
 const runA=store.accept(conversationA.id,'open A','unexpected-close-A').run,runB=store.accept(conversationB.id,'open B','unexpected-close-B').run;
 const contexts=[],browsers=[];let browserLaunches=0,browserCloses=0;
 const browserFactory=async()=>{
  browserLaunches++;let connected=true;const ownedContexts=[];
  const browser={newContext:async()=>{
   const id=contexts.length+1;let currentUrl='about:blank',closed=false,closeListener;
   const page={url:()=>{if(closed)throw Error('context_closed');return currentUrl;},goto:async value=>{if(closed)throw Error('context_closed');currentUrl=value;},
    evaluate:async(_fn,ids)=>{if(closed)throw Error('context_closed');return Array.isArray(ids)?undefined:{url:currentUrl,title:`Context ${id}`,text:`Context ${id}`,controls:[]};}};
   const signalClose=()=>{if(closed)return;closed=true;closeListener?.();};
   const context={route:async()=>{},pages:()=>[page],newPage:async()=>page,close:async()=>signalClose(),on:(name,listener)=>{if(name==='close')closeListener=listener;}};
   const record={context,signalClose};contexts.push(record);ownedContexts.push(record);return context;
  },close:async()=>{browserCloses++;connected=false;},isConnected:()=>connected,
   disconnect(){connected=false;for(const item of ownedContexts)item.signalClose();}};
  browsers.push(browser);return browser;
 };
 const tools=createTools({store,root:join(root,'files'),browserProfilesRoot:join(root,'profiles'),origins:new Set(['https://example.com']),browserEnabled:true,browserFactory});
 t.after(async()=>{await tools.close();store.close();await rm(root,{recursive:true,force:true});});
 const read=(run,conversationId,callId)=>tools.execute('browser_action',{url:'https://example.com/profile',action:'read'},
  {run,callId,signal:new AbortController().signal,approve:async()=>{},driverScope:{owner_id:conversationId,run_id:run.id,session_id:conversationId}});
 const openedA=await read(runA,conversationA.id,'unexpected-close-a-first'),openedB=await read(runB,conversationB.id,'unexpected-close-b-first');
 assert.equal(openedA.title,'Context 1');assert.equal(openedB.title,'Context 2');assert.equal(contexts.length,2);
 contexts[0].signalClose();
 const recoveredA=await read(runA,conversationA.id,'unexpected-close-a-retry');
 assert.equal(recoveredA.title,'Context 3');assert.equal(contexts.length,3);
 const retainedB=await read(runB,conversationB.id,'unexpected-close-b-retained');
 assert.equal(retainedB.title,'Context 2');assert.equal(contexts.length,3,'closing owner A must retain owner B cached context');
 assert.equal(browserLaunches,1,'a context-only close can reuse the still-connected shared browser');
 browsers[0].disconnect();
 const restartedA=await read(runA,conversationA.id,'unexpected-close-a-process-retry'),restartedB=await read(runB,conversationB.id,'unexpected-close-b-process-retry');
 assert.equal(restartedA.title,'Context 4');assert.equal(restartedB.title,'Context 5');assert.equal(contexts.length,5);
 assert.equal(browserLaunches,2,'a disconnected shared browser must be replaced before owner contexts can recover');
 await tools.close();assert.equal(browserCloses,1);
});
test('unexpected persistent context close relaunches the same owner profile',async t=>{
 const root=await mkdtemp(join(browserFixtureRoot,'unexpected-persistent-close-'));
 const store=new Store(':memory:'),conversation=store.createConversation('persistent owner'),run=store.accept(conversation.id,'open profile','persistent-close-1').run;
 const contexts=[],profiles=[];let launches=0;
 const browserFactory=async({userDataDir})=>{
  launches++;profiles.push(userDataDir);const id=launches;let currentUrl='about:blank',closed=false,closeListener;
  const page={url:()=>{if(closed)throw Error('context_closed');return currentUrl;},goto:async value=>{if(closed)throw Error('context_closed');currentUrl=value;},
   evaluate:async(_fn,ids)=>{if(closed)throw Error('context_closed');return Array.isArray(ids)?undefined:{url:currentUrl,title:`Persistent ${id}`,text:`Persistent ${id}`,controls:[]};}};
  const signalClose=()=>{if(closed)return;closed=true;closeListener?.();};
  const context={route:async()=>{},pages:()=>[page],newPage:async()=>page,close:async()=>signalClose(),on:(name,listener)=>{if(name==='close')closeListener=listener;}};
  contexts.push({context,signalClose});return{persistentContext:context};
 };
 const tools=createTools({store,root:join(root,'files'),browserProfilesRoot:join(root,'profiles'),browserOwnerId:'persistent owner',origins:new Set(['https://example.com']),browserEnabled:true,browserFactory});
 t.after(async()=>{await tools.close();store.close();await rm(root,{recursive:true,force:true});});
 const read=callId=>tools.execute('browser_action',{url:'https://example.com/profile',action:'read'},
  {run,callId,signal:new AbortController().signal,approve:async()=>{},driverScope:{owner_id:'persistent owner',run_id:run.id,session_id:conversation.id}});
 assert.equal((await read('persistent-close-first')).title,'Persistent 1');assert.equal(launches,1);
 contexts[0].signalClose();
 assert.equal((await read('persistent-close-retry')).title,'Persistent 2');assert.equal(launches,2);
 assert.equal(profiles[1],profiles[0],'recovery must reopen the same configured private profile');
 await tools.close();
});
test('close during asynchronous context creation waits, closes the context, and blocks the read',async t=>{
 const store=new Store(':memory:'),run=store.accept(store.createConversation().id,'close pending browser','close-pending-1').run;
 let enteredNewContext,releaseNewContext,launches=0,contextCloses=0,browserCloses=0,navigations=0;
 const entered=new Promise(resolve=>enteredNewContext=resolve),creatingContext=new Promise(resolve=>releaseNewContext=resolve),lifecycle=[];
 const page={url:()=> 'about:blank',goto:async()=>{navigations++;},title:async()=> 'Fixture',evaluate:async()=>({url:'about:blank',title:'Fixture',text:'Fixture',controls:[]})};
 const browserFactory=async()=>{launches++;return{newContext:async()=>{enteredNewContext();return creatingContext;},close:async()=>{browserCloses++;lifecycle.push('browser-close');}};};
 const tools=createTools({store,root:join(browserFixtureRoot,'files'),browserProfilesRoot:join(browserFixtureRoot,'profiles'),origins:new Set(['https://example.com']),browserEnabled:true,browserFactory});
 t.after(async()=>{await tools.close();store.close();});
 const context=callId=>({run,callId,signal:new AbortController().signal,approve:async()=>{}});
 const action=tools.execute('browser_action',{url:'https://example.com/pending-context',action:'read'},context('pending-context-read'));
 await entered;
 let closeSettled=false;const closing=tools.close().then(()=>{closeSettled=true;});
 await Promise.resolve();assert.equal(closeSettled,false);assert.equal(browserCloses,0);
 releaseNewContext({route:async()=>{},pages:()=>[page],newPage:async()=>page,close:async()=>{contextCloses++;lifecycle.push('context-close');}});
 const result=await action;await closing;
 assert.equal(result.error,'browser_driver_closed');
 assert.equal(launches,1);assert.equal(contextCloses,1);assert.equal(browserCloses,1);assert.equal(navigations,0);
 assert.deepEqual(lifecycle,['context-close','browser-close']);
 const afterClose=await tools.execute('browser_action',{url:'https://example.com/pending-context',action:'read'},context('pending-context-after-close'));
 assert.equal(afterClose.error,'browser_driver_closed');assert.equal(launches,1);
});
test('rejects a stale control candidate before approval or dispatch',async t=>{
 const f=fixture();t.after(f.close);
 const page=await f.tools.execute('browser_action',{url:'https://example.com/start',action:'read'},f.context('read-stale'));
 const candidate=page.candidates[0],approvals=f.approvals.length;
 f.state.text='The page changed after inspection';
 const result=await f.tools.execute('browser_action',{url:page.url,action:'click',candidate_id:candidate.candidate_id,page_revision:page.page_revision},f.context('click-stale'));
 assert.equal(result.error,'browser_page_revision_stale');assert.equal(result.browser_receipt.status,'failed');
 assert.equal(result.browser_receipt.error_code,'browser_page_revision_stale');
 const failedEvent=f.store.events(f.run.conversation_id,0).find(event=>event.type==='browser.operation.failed'&&event.data.call_id==='click-stale');
 assert.equal(failedEvent.data.error_code,'browser_page_revision_stale');
 assert.equal(failedEvent.data.browser_receipt.error_code,'browser_page_revision_stale');
 assert.equal(f.approvals.length,approvals);
 assert.equal(f.clicks(),0);
});
test('browser click records an approved revision-bound receipt and replays the same call once',async t=>{
 const f=fixture();t.after(f.close);
 const page=await f.tools.execute('browser_action',{url:'https://example.com/start',action:'read'},f.context('read-click'));
 const candidate=page.candidates[0],args={url:page.url,action:'click',candidate_id:candidate.candidate_id,page_revision:page.page_revision};
 const result=await f.tools.execute('browser_action',args,f.context('click-once'));
 assert.equal(result.browser_receipt.status,'succeeded');
 assert.equal(result.browser_receipt.call_id,'click-once');
 assert.equal(result.browser_receipt.page_revision,page.page_revision);
 assert.equal(f.approvals.at(-1).operation.candidate_id,candidate.candidate_id);
 assert.equal(f.approvals.at(-1).operation.call_id,result.browser_receipt.call_id);
 assert.equal(f.approvals.at(-1).operation.request_hash,result.browser_receipt.request_hash);
 assert.equal(f.approvals.at(-1).operation.operation_id,result.browser_receipt.operation_id);
 assert.equal(f.eventsAtClick().at(-1).type,'browser.operation.accepted');
 assert.equal(f.eventsAtClick().at(-1).data.action,'click');
 const receiptEvents=f.store.events(f.run.conversation_id,0).filter(event=>event.type.startsWith('browser.operation.')&&event.data.call_id==='click-once');
 assert.deepEqual(receiptEvents.map(event=>event.type),['browser.operation.accepted','browser.operation.succeeded']);
 const replay=await f.tools.execute('browser_action',args,f.context('click-once'));
 assert.deepEqual(replay,result);
 await assert.rejects(()=>f.tools.execute('browser_action',{url:page.url,action:'read'},f.context('click-once')),/invalid_tool_call_reused/);
 assert.equal(f.clicks(),1);
});
test('non-unique locator and revoked approval do not dispatch browser actions',async t=>{
 const f=fixture();t.after(f.close);
 const page=await f.tools.execute('browser_action',{url:'https://example.com/start',action:'read'},f.context('read-unique'));
 const candidate=page.candidates[0],args={url:page.url,action:'click',candidate_id:candidate.candidate_id,page_revision:page.page_revision};
 f.state.duplicateCandidate=true;
 const duplicate=await f.tools.execute('browser_action',args,f.context('click-duplicate'));
 assert.equal(duplicate.error,'browser_target_not_unique');assert.equal(f.clicks(),0);
 f.state.duplicateCandidate=false;
 const denied=await f.tools.execute('browser_action',args,{...f.context('click-denied'),approve:async()=>{throw Error('user_denied');}});
 assert.equal(denied.error,'user_denied');assert.equal(denied.browser_receipt.status,'failed');assert.equal(f.clicks(),0);
});
test('unknown click is inspect-only until a fresh read and new approval',async t=>{
 const f=fixture();t.after(f.close);
 const page=await f.tools.execute('browser_action',{url:'https://example.com/start',action:'read'},f.context('read-before-unknown'));
 const candidate=page.candidates[0],args={url:page.url,action:'click',candidate_id:candidate.candidate_id,page_revision:page.page_revision};
 f.state.failClick=true;
 const first=await f.tools.execute('browser_action',args,f.context('click-unknown'));
 assert.equal(first.error,'browser_action_outcome_unknown');assert.equal(first.browser_receipt.status,'unknown');
 const replay=await f.tools.execute('browser_action',args,f.context('click-unknown'));
 assert.deepEqual(replay,first);assert.equal(f.clicks(),1);
 const blocked=await f.tools.execute('browser_action',args,f.context('click-blind-retry'));
 assert.equal(blocked.error,'browser_inspect_required_after_unknown');assert.equal(f.clicks(),1);
 const inspected=await f.tools.execute('browser_action',{url:page.url,action:'read'},f.context('read-after-unknown'));
 f.state.failClick=false;
 const approved=await f.tools.execute('browser_action',{url:inspected.url,action:'click',candidate_id:inspected.candidates[0].candidate_id,page_revision:inspected.page_revision},f.context('click-after-inspect'));
 assert.equal(approved.browser_receipt.status,'succeeded');assert.equal(f.clicks(),2);
 assert.ok(f.approvals.at(-1).operation.page_revision===inspected.page_revision);
});

test('accepted operation without terminal receipt stays unknown after a process restart',async t=>{
 const temp=process.env.JOT_TEST_TMP??tmpdir();await mkdir(temp,{recursive:true});const root=await mkdtemp(join(temp,'browser-restart-receipt-')),database=join(root,'fixture.db');
 const store=new Store(database),conversation=store.createConversation(),run=store.accept(conversation.id,'recover browser operation','restart-1').run;
 const state={url:'about:blank',text:'Fixture',candidateIds:[]};
 const page={url:()=>state.url,goto:async value=>{state.url=value;},title:async()=> 'Fixture',evaluate:async(_fn,ids)=>{if(Array.isArray(ids)){state.candidateIds=ids;return;}return{url:state.url,title:'Fixture',text:state.text,controls:[{tag:'BUTTON',role:'button',name:'Continue',type:'',disabled:false,visible:true}]};},locator:()=>({count:async()=>1,isVisible:async()=>true,isEnabled:async()=>true,click:async()=>{}})};
 const browserFactory=async()=>({newContext:async()=>({route:async()=>{},pages:()=>[page],newPage:async()=>page,close:async()=>{}}),close:async()=>{}});
 const tools=createTools({store,root:join(root,'files'),origins:new Set(['https://example.com']),browserEnabled:true,browserFactory});
 let oldClosed=false;
 t.after(async()=>{if(!oldClosed){await tools.close();store.close();}await rm(root,{recursive:true,force:true});});
 const context=callId=>({run,callId,signal:new AbortController().signal,approve:async()=>{}});
 const inspected=await tools.execute('browser_action',{url:'https://example.com/restart',action:'read'},context('restart-read'));
 const candidate=inspected.candidates[0],args={url:inspected.url,action:'click',candidate_id:candidate.candidate_id,page_revision:inspected.page_revision},callId='restart-click';
 const request={url:args.url,action:args.action,candidate_id:args.candidate_id,page_revision:args.page_revision};
 const requestHash=createHash('sha256').update(JSON.stringify(request)).digest('hex');
 const base={kind:'browser_operation',operation_id:'accepted-before-crash',run_id:run.id,call_id:callId,request_hash:requestHash,action:args.action,url:args.url,candidate_id:args.candidate_id,page_revision:args.page_revision};
 store.event(conversation.id,'browser.operation.accepted',{...base,status:'accepted',browser_receipt:{kind:'browser_operation_receipt',...base,status:'accepted'}});
 const sideEffect=join(root,'side-effect-before-crash'),replayMarker=join(root,'unexpected-replay');await writeFile(sideEffect,'accepted click may already have reached the page');
 await tools.close();store.close();oldClosed=true;
 const script=[
  "import {writeFile} from 'node:fs/promises';",
  'const {Store}=await import(process.env.W05_STORE_MODULE);',
  'const {createTools}=await import(process.env.W05_TOOLS_MODULE);',
  'const store=new Store(process.env.W05_DATABASE),run=store.run(process.env.W05_RUN_ID);let launches=0;',
  'const tools=createTools({store,root:process.env.W05_ROOT,origins:new Set([\'https://example.com\']),browserEnabled:true,browserFactory:async()=>{launches++;await writeFile(process.env.W05_REPLAY_MARKER,\'unexpected replay\');throw Error(\'must_not_launch_for_unknown_operation\');}});',
  'const result=await tools.execute(\'browser_action\',JSON.parse(process.env.W05_ARGS),{run,callId:process.env.W05_CALL_ID,signal:new AbortController().signal,approve:async()=>{throw Error(\'must_not_request_approval\');}});',
  'await tools.close();store.close();process.stdout.write(JSON.stringify({result,launches}));',
 ].join('\n');
 const childEnv={PATH:process.env.PATH??'',TEMP:process.env.TEMP??temp,TMP:process.env.TMP??temp,W05_STORE_MODULE:new URL('../src/store.mjs',import.meta.url).href,
  W05_TOOLS_MODULE:new URL('../src/tools.mjs',import.meta.url).href,W05_DATABASE:database,W05_RUN_ID:run.id,W05_ROOT:join(root,'files'),W05_CALL_ID:callId,W05_ARGS:JSON.stringify(args),W05_REPLAY_MARKER:replayMarker};
 for(const key of ['SystemRoot','SYSTEMROOT','WINDIR'])if(process.env[key])childEnv[key]=process.env[key];
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),encoding:'utf8',env:childEnv,timeout:10000,windowsHide:true});
 assert.equal(child.status,0,child.stderr||child.error?.message);
 const recovered=JSON.parse(child.stdout);
 assert.equal(recovered.result.error,'browser_action_outcome_unknown');
 assert.equal(recovered.result.browser_receipt.status,'unknown');
 assert.equal(recovered.result.browser_receipt.recovery,'inspect_only');
 assert.equal(recovered.launches,0);
 assert.equal(await readFile(sideEffect,'utf8'),'accepted click may already have reached the page');
 await assert.rejects(()=>readFile(replayMarker),{code:'ENOENT'});
});

test('parent cancellation while approval is pending prevents browser dispatch',async t=>{
 const f=fixture();t.after(f.close);
 const page=await f.tools.execute('browser_action',{url:'https://example.com/start',action:'read'},f.context('read-abort'));
 let enteredApproval,releaseApproval;
 const entered=new Promise(resolve=>{enteredApproval=resolve;}),pending=new Promise(resolve=>{releaseApproval=resolve;}),controller=new AbortController();
 const action=f.tools.execute('browser_action',{url:page.url,action:'click',candidate_id:page.candidates[0].candidate_id,page_revision:page.page_revision},
  {...f.context('click-abort'),signal:controller.signal,approve:async()=>{enteredApproval();await pending;}});
 await entered;controller.abort();releaseApproval();
 const result=await action;
 assert.equal(result.error,'cancelled');assert.equal(result.browser_receipt.status,'failed');assert.equal(f.clicks(),0);
});

test('one browser conversation serializes overlapping operations while approval is pending',async t=>{
 const f=fixture();t.after(f.close);
 const page=await f.tools.execute('browser_action',{url:'https://example.com/start',action:'read'},f.context('read-serial'));
 let enteredApproval,releaseApproval;
 const entered=new Promise(resolve=>{enteredApproval=resolve;}),pending=new Promise(resolve=>{releaseApproval=resolve;});
 const action=f.tools.execute('browser_action',{url:page.url,action:'click',candidate_id:page.candidates[0].candidate_id,page_revision:page.page_revision},
  {...f.context('click-serial'),approve:async()=>{enteredApproval();await pending;}});
 await entered;
 const overlap=await f.tools.execute('browser_action',{url:page.url,action:'read'},f.context('read-overlap'));
 assert.equal(overlap.error,'browser_conversation_busy');
 releaseApproval();assert.equal((await action).browser_receipt.status,'succeeded');assert.equal(f.clicks(),1);
});

test('screenshot resolves the exact new artifact even when conversation listing order changes',async t=>{
 const temp=process.env.JOT_TEST_TMP??tmpdir();await mkdir(temp,{recursive:true});const root=await mkdtemp(join(temp,'browser-artifact-order-'));
 const store=new Store(':memory:'),conversation=store.createConversation(),run=store.accept(conversation.id,'capture','capture-1').run;
 const state={url:'about:blank',text:'Fixture',candidateIds:[]},png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 const page={url:()=>state.url,goto:async value=>{state.url=value;},title:async()=> 'Fixture',evaluate:async(_fn,ids)=>{if(Array.isArray(ids)){state.candidateIds=ids;return;}return{url:state.url,title:'Fixture',text:state.text,controls:[]};},screenshot:async()=>png};
 const browserFactory=async()=>({newContext:async()=>({route:async()=>{},pages:()=>[page],newPage:async()=>page,close:async()=>{}}),close:async()=>{}});
 const tools=createTools({store,root:join(root,'files'),origins:new Set(['https://example.com']),browserEnabled:true,browserFactory});
 t.after(async()=>{await tools.close();store.close();await rm(root,{recursive:true,force:true});});
 const ctx=callId=>({run,callId,signal:new AbortController().signal,approve:async()=>{}});
 await tools.execute('browser_action',{url:'https://example.com/capture',action:'read'},ctx('read-before-capture'));
 const folder=join(root,'files',conversation.id);await mkdir(folder,{recursive:true});const previousPath=join(folder,'previous');await writeFile(previousPath,png);
 store.artifact({id:'previous-artifact',conversation_id:conversation.id,run_id:run.id,name:'previous.png',path:previousPath,size:png.length});
 const listArtifacts=store.artifacts.bind(store);store.artifacts=id=>listArtifacts(id).reverse();
 const result=await tools.execute('browser_action',{url:'https://example.com/capture',action:'screenshot'},ctx('capture-current'));
 assert.equal(result.error,undefined);assert.notEqual(result.artifact_id,'previous-artifact');
 const artifact=store.getArtifact(result.artifact_id);
 assert.equal(artifact.name,'browser-screenshot.png');
 assert.deepEqual(await readFile(artifact.path),png);
});

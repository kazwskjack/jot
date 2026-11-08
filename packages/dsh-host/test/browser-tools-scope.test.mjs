import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBrowserToolsPlugin} from '../browser-tools.mjs';

const base=resolve(fileURLToPath(new URL('../.test-tmp/browser-tools-scope/',import.meta.url)));
mkdirSync(base,{recursive:true});
function runtime(root){
 const anchor=join(root,'runtime','package.json'),moduleRoot=join(root,'runtime','node_modules','@deepseek-ai','dsh-tools');
 mkdirSync(moduleRoot,{recursive:true});writeFileSync(anchor,JSON.stringify({type:'module'}));
 writeFileSync(join(moduleRoot,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-tools',type:'module',exports:'./index.mjs'}));
 writeFileSync(join(moduleRoot,'index.mjs'),'export function defineTool(value){return value;}\n');
 return anchor;
}
function context(anchor){
 const services=new Map([['profileContext',{installAnchor:anchor}]]),globalTools=new Map(),effects=[];
 return {services,globalTools,effects,provide(name,value){services.set(name,value);},get(name){return services.get(name);},
  tools:{register(tool){globalTools.set(tool.name,tool);return()=>globalTools.delete(tool.name);}},
  approval:{async request(value){return value.__outcome??'allowed-once';}},
  effect(callback){effects.push(callback());}};
}
function pageDriver(){
 let currentUrl='about:blank',navigations=0,factoryCalls=0,ownerKey;
 const page={url:()=>currentUrl,async goto(url){navigations++;currentUrl=url;},async evaluate(_fn,arg){if(arg!==undefined)return;return{url:currentUrl,title:'Fixture',text:'Fixture page',controls:[]};}};
 const persistentContext={async close(){},async route(){},pages:()=>[],async newPage(){return page;}};
 return {factory:async options=>{factoryCalls++;ownerKey=options.ownerKey;return{persistentContext};},get calls(){return{navigations,factoryCalls,ownerKey};}};
}
function trustedScope({owner_id='gateway-owner',run_id='gateway-run',session_ref='session-1',execution_lease={owner:'worker-1',generation:4},assertCurrent=async()=>true}={}){
 return Object.freeze({protocol:1,owner_id,run_id,session_ref,execution_lease:Object.freeze({...execution_lease}),assertCurrent});
}
async function closePlugin(ctx){for(const cleanup of ctx.effects.reverse())await cleanup?.();}

test('browser plugin publishes a deferred Agent registrar and never registers browser_action globally',async t=>{
 const root=mkdtempSync(join(base,'case-'));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
 const driver=pageDriver(),ctx=context(runtime(root)),plugin=createBrowserToolsPlugin({browserFactory:driver.factory});
 await plugin.apply(ctx,{dataRoot:join(root,'data'),profileRoot:join(root,'profiles'),ownerId:'profile-owner',origins:['https://fixture.example']});
 assert.equal(ctx.globalTools.has('browser_action'),false);
 const registrar=ctx.get('jotBrowserToolRegistrar');assert.equal(registrar?.protocol,1);assert.equal(typeof registrar?.mount,'function');
 const agentTools=new Map(),agent={id:'session-1',ctx:{tools:{register(tool){agentTools.set(tool.name,tool);return()=>agentTools.delete(tool.name);}}}};
 const scope=trustedScope();const dispose=registrar.mount({agent,scopeForAgent:candidate=>{assert.equal(candidate,agent);return scope;}});
 assert.equal(ctx.globalTools.has('browser_action'),false);assert.ok(agentTools.has('browser_action'));assert.equal(driver.calls.factoryCalls,0);
 dispose();assert.equal(agentTools.has('browser_action'),false);await closePlugin(ctx);
});

test('browser execution uses Gateway scope for approval, local run receipt and owner profile',async t=>{
 const root=mkdtempSync(join(base,'case-'));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
 const driver=pageDriver(),ctx=context(runtime(root)),plugin=createBrowserToolsPlugin({browserFactory:driver.factory}),approval=[];
 ctx.approval.request=async request=>{approval.push(request);return'allowed-once';};
 const dataRoot=join(root,'data'),profileRoot=join(root,'profiles');
 await plugin.apply(ctx,{dataRoot,profileRoot,ownerId:'unused-profile-owner',origins:['https://fixture.example']});
 const registrar=ctx.get('jotBrowserToolRegistrar'),agentTools=new Map(),agent={id:'session-1',ctx:{tools:{register(tool){agentTools.set(tool.name,tool);return()=>agentTools.delete(tool.name);}}}};
 let checks=0;const scope=trustedScope({assertCurrent:async()=>{checks++;return true;}});registrar.mount({agent,scopeForAgent:()=>scope});
 const tool=agentTools.get('browser_action'),result=await tool.execute({url:'https://fixture.example/',action:'read'},{agent,callId:'browser-call-1',rootCallId:'root-call-1',signal:new AbortController().signal});
 assert.equal(result.text,'Fixture page');assert.equal(checks,4);assert.equal(approval.length,1);
 assert.equal(approval[0].agent,agent);assert.equal(approval[0].toolName,'browser_action');assert.equal(approval[0].callId,'browser-call-1');
 assert.equal(approval[0].action_payload.tool,'browser_action');assert.equal(approval[0].action_payload.call_id,'browser-call-1');assert.equal(approval[0].action_payload.url,'https://fixture.example/');
 assert.equal(Object.hasOwn(approval[0],'run_id'),false);assert.equal(Object.hasOwn(approval[0],'owner_id'),false);
 assert.equal(driver.calls.ownerKey,createHash('sha256').update(scope.owner_id).digest('hex'));
 assert.ok(existsSync(join(profileRoot,driver.calls.ownerKey)));
 await closePlugin(ctx);
 const db=new DatabaseSync(join(dataRoot,'browser-operations.sqlite'));
 try{assert.equal(db.prepare('SELECT id,conversation_id FROM runs WHERE id=?').get(scope.run_id).conversation_id,scope.session_ref);
  const event=db.prepare("SELECT data FROM events WHERE type='browser.operation.succeeded'").get();assert.equal(JSON.parse(event.data).run_id,scope.run_id);
 }finally{db.close();}
});

test('missing scope and a lost post-approval guard stop before browser navigation',async t=>{
 const root=mkdtempSync(join(base,'case-'));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
 const driver=pageDriver(),ctx=context(runtime(root)),plugin=createBrowserToolsPlugin({browserFactory:driver.factory});
 ctx.approval.request=async()=> 'allowed-once';
 await plugin.apply(ctx,{dataRoot:join(root,'data'),profileRoot:join(root,'profiles'),ownerId:'unused-profile-owner',origins:['https://fixture.example']});
 const registrar=ctx.get('jotBrowserToolRegistrar'),agentTools=new Map(),agent={id:'session-1',ctx:{tools:{register(tool){agentTools.set(tool.name,tool);return()=>agentTools.delete(tool.name);}}}};
 let available=false,checks=0;registrar.mount({agent,scopeForAgent:()=>{if(!available)throw Error('workbench_browser_scope_forbidden');return trustedScope({assertCurrent:async()=>{if(++checks>=3)throw Error('workbench_execution_lease_revoked');return true;}});}});
 const tool=agentTools.get('browser_action'),exec={agent,callId:'browser-call-2',rootCallId:'root-call-2',signal:new AbortController().signal};
 await assert.rejects(tool.execute({url:'https://fixture.example/',action:'read'},exec),/workbench_browser_scope_forbidden/);assert.equal(driver.calls.factoryCalls,0);
 available=true;await assert.rejects(tool.execute({url:'https://fixture.example/',action:'read'},exec),/workbench_execution_lease_revoked/);
 assert.equal(driver.calls.navigations,0,'navigation must not proceed after the exact Gateway lease check fails');
 await closePlugin(ctx);
});

test('trusted Gateway scope can CAS revoke its owner profile and block replay without deleting profile data',async t=>{
 const root=mkdtempSync(join(base,'case-'));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
 const driver=pageDriver(),ctx=context(runtime(root)),plugin=createBrowserToolsPlugin({browserFactory:driver.factory}),dataRoot=join(root,'data'),profileRoot=join(root,'profiles');
 await plugin.apply(ctx,{dataRoot,profileRoot,ownerId:'unused-profile-owner',origins:['https://fixture.example']});
 const registrar=ctx.get('jotBrowserToolRegistrar'),agentTools=new Map(),agent={id:'session-1',ctx:{tools:{register(tool){agentTools.set(tool.name,tool);return()=>agentTools.delete(tool.name);}}}};
 let leaseCurrent=true,blockApproval=false,approvalEntered,releaseApproval;const entered=new Promise(resolve=>approvalEntered=resolve),held=new Promise(resolve=>releaseApproval=resolve);
 ctx.approval.request=async()=>{if(blockApproval){approvalEntered();await held;}return'allowed-once';};
 const scope=trustedScope({assertCurrent:async()=>{if(!leaseCurrent)throw Error('workbench_execution_lease_revoked');return true;}}),scopeForAgent=candidate=>{assert.equal(candidate,agent);return scope;};registrar.mount({agent,scopeForAgent});
 const tool=agentTools.get('browser_action'),args={url:'https://fixture.example/',action:'read'},exec={agent,callId:'profile-revoke-call',rootCallId:'profile-revoke-root',signal:new AbortController().signal};
 const first=await tool.execute(args,exec),profile=join(profileRoot,createHash('sha256').update(scope.owner_id).digest('hex')),profileBytes=join(profile,'synthetic-profile.bin');
 writeFileSync(profileBytes,'synthetic browser profile data');
 assert.equal(first.text,'Fixture page');assert.equal(driver.calls.factoryCalls,1);assert.ok(existsSync(profile));
 leaseCurrent=false;await assert.rejects(registrar.revokeProfile({agent,scopeForAgent,expectedGeneration:1,signal:exec.signal}),/workbench_execution_lease_revoked/);leaseCurrent=true;
 assert.deepEqual(await tool.execute(args,exec),first,'a stale Gateway lease cannot change generation state');
 blockApproval=true;const pending=tool.execute({url:'https://fixture.example/next',action:'read'}, {...exec,callId:'profile-revoke-pending',rootCallId:'profile-revoke-pending-root'});await entered;
 assert.deepEqual(await registrar.revokeProfile({agent,scopeForAgent,expectedGeneration:1,signal:exec.signal}),{generation:2,status:'revoked'});
 releaseApproval();const afterApproval=await pending;assert.equal(afterApproval.error,'browser_profile_revoked');assert.equal(driver.calls.navigations,1,'revocation during approval blocks the later navigation');
 await assert.rejects(registrar.revokeProfile({agent,scopeForAgent,expectedGeneration:1,signal:exec.signal}),/browser_profile_generation_conflict/);
 await assert.rejects(tool.execute(args,exec),/browser_profile_revoked/);
 assert.equal(driver.calls.factoryCalls,1,'revocation blocks replay before opening or reusing a browser context');assert.ok(existsSync(profile));assert.equal(readFileSync(profileBytes,'utf8'),'synthetic browser profile data','revocation preserves profile bytes');
 await closePlugin(ctx);
});

test('existing profile with unknown generation fails closed before browser launch',async t=>{
 const root=mkdtempSync(join(base,'case-'));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
 const driver=pageDriver(),ctx=context(runtime(root)),plugin=createBrowserToolsPlugin({browserFactory:driver.factory}),profileRoot=join(root,'profiles'),scope=trustedScope();
 mkdirSync(join(profileRoot,createHash('sha256').update(scope.owner_id).digest('hex')),{recursive:true});
 await plugin.apply(ctx,{dataRoot:join(root,'data'),profileRoot,ownerId:'unused-profile-owner',origins:['https://fixture.example']});
 const registrar=ctx.get('jotBrowserToolRegistrar'),agentTools=new Map(),agent={id:'session-1',ctx:{tools:{register(tool){agentTools.set(tool.name,tool);return()=>agentTools.delete(tool.name);}}}};
 registrar.mount({agent,scopeForAgent:()=>scope});
 await assert.rejects(agentTools.get('browser_action').execute({url:'https://fixture.example/',action:'read'},
  {agent,callId:'unknown-generation-call',rootCallId:'unknown-generation-root',signal:new AbortController().signal}),/browser_profile_generation_unknown/);
 assert.equal(driver.calls.factoryCalls,0);assert.equal(driver.calls.navigations,0);
 await closePlugin(ctx);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {PrdFlow,PrdCommandStore,installPrdLeaveGuard,prdMessage} from './task-prd.mjs';

const source={kind:'logical_file',path:'docs/prd.md',version:2,sha256:'a'.repeat(64),name:'prd.md',size:40};
const upload={kind:'upload',artifact_id:'original-upload',version:1,sha256:'b'.repeat(64),name:'brief.txt',size:20};
const sources=()=>({task_id:'task/1',task_version:7,readiness:{ready:true,reasons:[]},sources:[source,upload],truncated:false,binding:null});
const preview=()=>({task_id:'task/1',task_version:7,role:{agent_id:'role',version:3,capability_epoch:4},source,content:'# Goal\nExact source\n',objective:'Original goal\n\n# Goal\nExact source\n',preview_sha256:'c'.repeat(64),execution_authorized:false});
const receipt=()=>({binding_id:'bound',task_id:'task/1',task_version:8,revision:1,source,content_sha256:source.sha256,objective_sha256:'d'.repeat(64),created_at:'2026-10-17T00:00:00Z',execution_authorized:false});
function ready(){const flow=new PrdFlow({task_id:'task/1',version:7,status:'paused'},true,()=> 'fixed-key');flow.setSources(sources());flow.choose(0);return flow;}
const conflict=code=>Object.assign(new Error(code),{status:409});
test('server readiness codes explain the required action in Chinese',()=>{
 const cases=[
  ['PRD_TASK_MUST_BE_PAUSED',/暂停.*绑定/],
  ['PRD_ROLE_UNAVAILABLE',/角色.*不可用.*检查/],
  ['PRD_EXECUTION_UNRESOLVED',/执行.*未知.*核对/],
  ['PRD_BUDGET_UNRESOLVED',/额度预留.*消耗.*核对/],
  ['PRD_OBJECTIVE_CHANGED',/目标.*修改.*核对/],
  ['PRD_MANAGED_TASK_FORBIDDEN',/策略管理.*不能.*绑定/],
 ];for(const [code,meaning] of cases)assert.match(prdMessage(code),meaning);
 assert.match(prdMessage('PRD_SOURCE_CHANGED'),/来源.*变化/);assert.match(prdMessage('PRD_PREVIEW_CHANGED'),/预览.*失效/);
});

test('preview sends only exact selection and binding requires explicit confirmation',async()=>{
 const flow=ready(),calls=[];
 const request=async(...args)=>{calls.push(args);return preview();};
 await flow.loadPreview(request);
 assert.deepEqual(calls,[['/persistent-tasks/task%2F1/prd/preview','POST',{source:{kind:'logical_file',path:'docs/prd.md',version:2,sha256:'a'.repeat(64)}}]]);
 assert.equal(flow.preview.content,'# Goal\nExact source\n');assert.equal(flow.preview.objective,'Original goal\n\n# Goal\nExact source\n');
 await assert.rejects(()=>flow.bind(request,false),/确认/);assert.equal(calls.length,1);
});
test('unknown result locks selection and retains original body/key even if caller objects change',async()=>{
 const flow=ready();await flow.loadPreview(async()=>preview());const calls=[];
 const request=async(...args)=>{calls.push(structuredClone(args));if(calls.length===1)throw new TypeError('network lost');return receipt();};
 await assert.rejects(()=>flow.bind(request,true),/network/);assert.equal(flow.pending,true);
 assert.throws(()=>flow.choose(1),/回执/);assert.throws(()=>flow.setSources(sources()),/回执/);
 flow.preview.objective='tampered';await flow.bind(request,false);
 assert.deepEqual(calls[0],calls[1]);assert.equal(calls[1][3],'fixed-key');assert.deepEqual(calls[1][2],{source:{kind:'logical_file',path:'docs/prd.md',version:2,sha256:'a'.repeat(64)},preview_sha256:'c'.repeat(64)});
 assert.equal(flow.pending,false);assert.equal(flow.receipt.binding_id,'bound');
});
for(const code of ['VERSION_CONFLICT','PRD_SOURCE_CHANGED','ROLE_VERSION_CONFLICT'])test(`${code} clears stale preview and requires refreshed selection`,async()=>{
 const flow=ready();await flow.loadPreview(async()=>preview());await assert.rejects(()=>flow.bind(async()=>{throw conflict(code);},true));
 assert.equal(flow.preview,null);assert.equal(flow.selection,null);assert.equal(flow.sources,null);assert.equal(flow.pending,false);assert.equal(flow.refreshRequired,true);
 await assert.rejects(()=>flow.loadPreview(async()=>preview()),/来源/);
});
test('readiness, paused task, matching version and execution host all gate preview',async()=>{
 for(const change of [f=>f.setContext({task_id:'task/1',version:7,status:'active'},true),f=>f.setContext({task_id:'task/1',version:7,status:'paused'},false),f=>f.setSources({...sources(),task_version:8}),f=>f.setSources({...sources(),readiness:{ready:false,reasons:['LIVE_RUN']}})]){
  const flow=ready();change(flow);let calls=0;await assert.rejects(()=>flow.loadPreview(async()=>{calls++;return preview();}));assert.equal(calls,0);
 }
});
test('selecting upload strips metadata and stale asynchronous preview cannot be confirmed',async()=>{
 const flow=ready();flow.choose(1);let resolve;
 const work=flow.loadPreview(async(path,method,body)=>{assert.deepEqual(body,{source:{kind:'upload',artifact_id:'original-upload',version:1,sha256:'b'.repeat(64)}});return new Promise(r=>resolve=r);});
 assert.throws(()=>flow.choose(0),/正在/);flow.setContext({task_id:'task/1',version:8,status:'paused'},true);resolve({...preview(),source:upload});await work;assert.equal(flow.preview,null);
});
test('pending guard blocks outside click and Escape but permits retry and unload warns',()=>{
 const target=new EventTarget(),inside={},outside={};let pending=true;
 const remove=installPrdLeaveGuard(target,()=>pending,node=>node===inside);
 const emit=(type,fields)=>{const e=new Event(type,{cancelable:true});for(const [key,value] of Object.entries(fields))Object.defineProperty(e,key,{value});target.dispatchEvent(e);return e;};
 assert.equal(emit('click',{target:outside}).defaultPrevented,true);assert.equal(emit('click',{target:inside}).defaultPrevented,false);
 assert.equal(emit('keydown',{target:outside,key:'Tab'}).defaultPrevented,false,'keyboard focus must remain movable back to the original retry button');
 assert.equal(emit('keydown',{target:outside,key:'Enter'}).defaultPrevented,true);
 assert.equal(emit('keydown',{target:inside,key:'Escape'}).defaultPrevented,true);assert.equal(emit('beforeunload',{}).defaultPrevented,true);
 pending=false;assert.equal(emit('click',{target:outside}).defaultPrevented,false);remove();pending=true;assert.equal(emit('beforeunload',{}).defaultPrevented,false);
});
test('same-tab recovery preserves unknown original command under owner and task scope',async()=>{
 const rows=new Map(),storage={getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)};
 const store=new PrdCommandStore(storage,'d'.repeat(64),'task/1');
 const flow=new PrdFlow({task_id:'task/1',version:7,status:'paused'},true,()=> 'original-key',store);flow.setSources(sources());flow.choose(0);await flow.loadPreview(async()=>preview());
 let original;await assert.rejects(()=>flow.bind(async(...args)=>{original=args;throw Error('lost');},true));
 assert.equal(new PrdCommandStore(storage,'e'.repeat(64),'task/1').read(),null);assert.equal(new PrdCommandStore(storage,'d'.repeat(64),'other-task').read(),null);
 const reopened=new PrdFlow({task_id:'task/1',version:8,status:'paused'},false,()=> 'must-not-use',new PrdCommandStore(storage,'d'.repeat(64),'task/1'));
 assert.equal(reopened.pending,true);await reopened.bind(async(...args)=>{assert.deepEqual(args,original);return receipt();},false);assert.equal(store.read(),null);
});
test('double bind cannot dispatch another request while original receipt is in flight',async()=>{
 const flow=ready();await flow.loadPreview(async()=>preview());let resolve;const work=flow.bind(()=>new Promise(r=>resolve=r),true);
 await assert.rejects(()=>flow.bind(()=>{throw Error('second dispatch');},true),/正在/);resolve(receipt());await work;
});
test('malformed success response stays unknown until the original binding receipt is confirmed',async()=>{
 const flow=ready();await flow.loadPreview(async()=>preview());await assert.rejects(()=>flow.bind(async()=>({accepted:true}),true),/RECEIPT/);assert.equal(flow.pending,true);
 await flow.bind(async()=>receipt(),false);assert.equal(flow.pending,false);
});
for(const [status,code] of [[408,'TIMEOUT'],[409,'IDEMPOTENCY_IN_PROGRESS'],[503,'UNAVAILABLE']])test(`${status} ${code} retains original binding command`,async()=>{
 const flow=ready();await flow.loadPreview(async()=>preview());await assert.rejects(()=>flow.bind(async()=>{throw Object.assign(Error(code),{status});},true));assert.equal(flow.pending,true);assert.ok(flow.preview);
});

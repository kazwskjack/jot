import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// Native plan-mode compatibility. The retained MIT notice is in
// ../session-adapter/runtime-patches/DSH-MIT-LICENSE.txt.

export const name='jot-plan-mode-recovery';
export const inject=['planMode','sessionProjections','profileContext'];
const SOURCE_SHA256='39a825b066aefe948c3bd6bdb69f229d68436c8561a7058df2184abd6c5fd552';
const PROJECTION='jot-plan-mode-pending';
const RECORD='plugin:jot-plan-mode/pending';
const fail=()=>{throw Error('jot_plan_mode_recovery_unavailable');};

function pendingProjection(z,pluginRecordOf){
 const selection=z.object({protocol:z.literal(1),active:z.boolean().nullable(),narrate:z.boolean()}).strict();
 return {
  key:PROJECTION,
  stateVersion:1,
  stateSchema:z.object({pending:z.boolean().nullable(),narrate:z.boolean()}).strict(),
  init:()=>({pending:null,narrate:true}),
  apply(state,event){
   if(event.type===RECORD){
    const record=pluginRecordOf(event);
    if(!record)fail();
    const value=selection.parse(record.data);
    return {pending:value.active,narrate:value.narrate};
   }
   if(event.type==='plan/mode')return state.pending===null?state:{pending:null,narrate:state.narrate};
   return state;
  },
 };
}

/** Restore native selections before assembly while retaining its accepted-step commit. */
export async function apply(ctx){
 const anchor=ctx.get('profileContext')?.installAnchor;
 if(typeof anchor!=='string')fail();
 const require=createRequire(anchor);
 const entry=require.resolve('@deepseek-ai/dsh-plan-mode');
 const source=(await readFile(entry,'utf8')).replace(/\r\n/g,'\n');
 if(createHash('sha256').update(source).digest('hex')!==SOURCE_SHA256)fail();
 const manifest=JSON.parse(await readFile(new URL('../package.json',pathToFileURL(entry)),'utf8'));
 if(manifest.name!=='@deepseek-ai/dsh-plan-mode'||manifest.version!=='0.2.1-rc.2')fail();
 const native=await import(pathToFileURL(entry).href);
 const controller=ctx.get('planMode');
 if(!(controller instanceof native.PlanModeController))fail();
 const pending=controller.pendingIntents;
 if(!(pending instanceof WeakMap))fail();
 for(const method of ['get','set','delete']){
  if(Object.hasOwn(pending,method)||pending[method]!==WeakMap.prototype[method])fail();
 }
 const session=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href);
 if(typeof session.appendPluginRecord!=='function'||typeof session.pluginRecordOf!=='function')fail();
 const {z}=require('zod');
 const projections=ctx.get('sessionProjections');
 projections.register(pendingProjection(z,session.pluginRecordOf));
 const read=original=>{
  const state=projections.stateOf(original,PROJECTION);
  if(!state)fail();
  return state;
 };
 const originalGet=WeakMap.prototype.get.bind(pending);
 const originalSet=WeakMap.prototype.set.bind(pending);
 const originalDelete=WeakMap.prototype.delete.bind(pending);
 const record=(original,active,narrate)=>session.appendPluginRecord(original,RECORD,{protocol:1,active,narrate});
 const methods={
  get(original){
   const existing=originalGet(original);
   if(existing!==undefined)return existing;
   const state=read(original);
   if(state.pending===null)return undefined;
   const restored={active:state.pending,narrate:state.narrate};
   originalSet(original,restored);
   return restored;
  },
  set(original,value){
   if(!value||typeof value.active!=='boolean'||typeof value.narrate!=='boolean')fail();
   record(original,value.active,value.narrate);
   return originalSet(original,value);
  },
  delete(original){
   if(read(original).pending!==null)record(original,null,true);
   return originalDelete(original);
  },
 };
 for(const [method,value] of Object.entries(methods)){
  Object.defineProperty(pending,method,{value,writable:true,configurable:true});
 }
 ctx.on('agent/created',({agent})=>{methods.get(agent.session);});
 ctx.effect(()=>()=>{
  for(const [method,value] of Object.entries(methods)){
   if(Object.getOwnPropertyDescriptor(pending,method)?.value===value)delete pending[method];
  }
 });
}

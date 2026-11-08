export interface MemoryDreamIdentity {
 owner_id:string;
 workspace_id:string;
 project_id:string;
 agent_id:string;
 policy_version:number;
 epoch:number;
 cadence_slot:string;
}

export interface DreamProjectScope {
 owner_id:string;
 workspace_id:string;
 project_id:string;
 scope:'project';
 agent_id:null;
}

export interface DreamMemoryRecord {
 memory_id:string;
 owner_id:string;
 workspace_id:string;
 project_id:string;
 scope:'project'|'private';
 agent_id:string|null;
 version:number;
 source_revision:string|null;
 content:string;
}

export interface DreamConsolidationRecord {
 consolidation_id:string;
 owner_id:string;
 workspace_id:string;
 project_id:string;
 scope:'project'|'private';
 agent_id:string|null;
 run_id:string|null;
 status:string;
 version:number;
}

export interface DreamProposalInput {
 expected_version:number;
 summary:string;
 changes:unknown[];
}

export interface MemoryDreamToolPorts {
 list(scope:DreamProjectScope,input:{q?:string}):Promise<DreamMemoryRecord[]>;
 stage(scope:DreamProjectScope,runId:string,input:{memory_ids:string[]}):Promise<DreamConsolidationRecord>;
 propose(scope:DreamProjectScope,runId:string,consolidationId:string,input:DreamProposalInput):Promise<DreamConsolidationRecord>;
}

type AssertCurrent=()=>void|Promise<void>;
type RecordValue=Record<string,unknown>;

const invalid=()=>{throw new Error('memory_dream_tool_forbidden');};
function record(value:unknown):RecordValue{
 if(value===undefined)return {};
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
 const prototype=Object.getPrototypeOf(value);
 if(prototype!==Object.prototype&&prototype!==null)return invalid();
 return value as RecordValue;
}
function exact(value:RecordValue,keys:string[]){if(Object.keys(value).some(key=>!keys.includes(key)))invalid();}
function nonempty(value:unknown):value is string{return typeof value==='string'&&value.trim().length>0;}
function checkIdentity(identity:MemoryDreamIdentity,runId:string){
 if(!identity||!nonempty(identity.owner_id)||!nonempty(identity.workspace_id)||!nonempty(identity.project_id)||!nonempty(identity.agent_id)
  ||!Number.isSafeInteger(identity.policy_version)||identity.policy_version<1||!Number.isSafeInteger(identity.epoch)||identity.epoch<0
  ||!nonempty(identity.cadence_slot)||!nonempty(runId))invalid();
}
function sameProject(value:{owner_id:string;workspace_id:string;project_id:string;scope:string;agent_id:string|null},scope:DreamProjectScope){
 return value.owner_id===scope.owner_id&&value.workspace_id===scope.workspace_id&&value.project_id===scope.project_id
  &&value.scope==='project'&&value.agent_id===null;
}
function assertConsolidation(value:DreamConsolidationRecord,scope:DreamProjectScope,runId:string,status:'draft'|'proposed'){
 if(!value||!nonempty(value.consolidation_id)||!sameProject(value,scope)||value.run_id!==runId||value.status!==status||!Number.isSafeInteger(value.version)||value.version<1)
  throw new Error('memory_dream_source_forbidden');
}

/** Project-only tool surface for a Dream run; Jot remains responsible for source and epoch authorization. */
export function createMemoryDreamTools(identity:MemoryDreamIdentity,runId:string,ports:MemoryDreamToolPorts,assertCurrent:AssertCurrent){
 checkIdentity(identity,runId);
 const scope:DreamProjectScope={owner_id:identity.owner_id,workspace_id:identity.workspace_id,project_id:identity.project_id,scope:'project',agent_id:null};
 const current=async()=>{await assertCurrent();};
 return Object.freeze({
  async list(input?:unknown){
   const args=record(input);exact(args,['q']);
   if(args.q!==undefined&&(!nonempty(args.q)||args.q.length>256))invalid();
   await current();
   const rows=await ports.list(scope,args.q===undefined?{}:{q:args.q as string});
   if(!Array.isArray(rows)||rows.some(row=>!row||!sameProject(row,scope)))throw new Error('memory_dream_source_forbidden');
   await current();
   return rows;
  },
  async stage(input:unknown){
   const args=record(input);exact(args,['memory_ids']);
   if(!Array.isArray(args.memory_ids)||args.memory_ids.length<1||args.memory_ids.length>25
    ||args.memory_ids.some(id=>!nonempty(id))||new Set(args.memory_ids).size!==args.memory_ids.length)invalid();
   await current();
   const result=await ports.stage(scope,runId,{memory_ids:args.memory_ids as string[]});
   assertConsolidation(result,scope,runId,'draft');
   await current();
   return result;
  },
  async propose(consolidationId:unknown,input:unknown){
   if(!nonempty(consolidationId))invalid();
   const args=record(input);exact(args,['expected_version','summary','changes']);
   const changes=args.changes;
   if(!Number.isSafeInteger(args.expected_version)||Number(args.expected_version)<1||!nonempty(args.summary)||args.summary.length>2000
    ||!Array.isArray(changes)||changes.length>25)invalid();
   await current();
   const result=await ports.propose(scope,runId,consolidationId as string,{expected_version:Number(args.expected_version),summary:args.summary as string,changes:changes as unknown[]});
   assertConsolidation(result,scope,runId,'proposed');
   await current();
   return result;
  },
 });
}

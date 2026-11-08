export interface MemoryReasoningCandidate {
  memory_id:string;
  version:number;
  content:string;
}

export interface MemoryReasoningProviderInput {
  query:string;
  candidates:ReadonlyArray<Readonly<MemoryReasoningCandidate>>;
  limit:number;
  signal?:AbortSignal;
}

export interface MemoryReasoningProvider {
  selectCandidates(input:MemoryReasoningProviderInput):Promise<unknown>;
}

export interface MemoryReasoningReference {
  memory_id:string;
  version:number;
  rank:number;
  reason:'reasoning_provider';
}

export interface MemoryReasoningResult {
  method:'reasoning_provider';
  candidate_count:number;
  selected_ids:string[];
  references:MemoryReasoningReference[];
}

export interface MemoryReasoningRequest {
  query:string;
  candidates:ReadonlyArray<Readonly<MemoryReasoningCandidate>>;
  limit?:number;
  signal?:AbortSignal;
}

const MAX_QUERY_CHARS=2000;
const MAX_CANDIDATES=200;
const MAX_CANDIDATE_CONTENT_CHARS=20_000;
const MAX_TOTAL_CANDIDATE_CONTENT_CHARS=200_000;
const MAX_SELECTION=5;
const SAFE_AUXILIARY_ERRORS=new Set([
  'model_budget_exhausted','budget_usage_unknown','budget_usage_pending','budget_route_unavailable','budget_window_closed',
  'budget_run_inactive','budget_request_invalid','budget_dispatch_conflict','auxiliary_lease_revoked','task_generation_revoked','auxiliary_usage_unknown',
]);

function fail(code:string):never{throw new Error(code);}

function normalizeRequest(input:MemoryReasoningRequest){
  if(!input||typeof input.query!=='string'||!input.query.trim()||input.query.length>MAX_QUERY_CHARS)fail('memory_reasoning_query_invalid');
  if(!Array.isArray(input.candidates)||input.candidates.length>MAX_CANDIDATES)fail('memory_reasoning_candidates_invalid');
  const limit=input.limit??MAX_SELECTION;
  if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_SELECTION)fail('memory_reasoning_limit_invalid');
  const ids=new Set<string>();let totalContentChars=0;
  const candidates=input.candidates.map(candidate=>{
    if(!candidate||typeof candidate.memory_id!=='string'||!candidate.memory_id.trim()||candidate.memory_id.length>128
      ||!Number.isSafeInteger(candidate.version)||candidate.version<1||typeof candidate.content!=='string')fail('memory_reasoning_candidates_invalid');
    if(candidate.content.length>MAX_CANDIDATE_CONTENT_CHARS||(totalContentChars+=candidate.content.length)>MAX_TOTAL_CANDIDATE_CONTENT_CHARS)fail('memory_reasoning_candidates_too_large');
    if(ids.has(candidate.memory_id))fail('memory_reasoning_candidates_invalid');
    ids.add(candidate.memory_id);
    return {memory_id:candidate.memory_id,version:candidate.version,content:candidate.content};
  });
  return {query:input.query.trim(),candidates,ids,limit,signal:input.signal};
}

function selectedIds(value:unknown,allowed:Set<string>,limit:number):string[]{
  if(!value||typeof value!=='object'||Array.isArray(value))fail('memory_reasoning_result_invalid');
  const ids=(value as {selected_ids?:unknown}).selected_ids;
  if(!Array.isArray(ids)||ids.length>limit||ids.some(id=>typeof id!=='string'||!allowed.has(id))||new Set(ids).size!==ids.length){
    fail('memory_reasoning_result_invalid');
  }
  return [...ids] as string[];
}

/**
 * Provider boundary for reasoning-based selection. This adapter validates and
 * projects the already-authorized candidate set; it does not fetch or broaden
 * candidates and it does not connect a production provider by itself.
 */
export class MemoryReasoningAdapter {
  private readonly provider:MemoryReasoningProvider;
  constructor(provider:MemoryReasoningProvider){
    if(!provider||typeof provider.selectCandidates!=='function')fail('memory_reasoning_provider_invalid');
    this.provider=provider;
  }

  async select(input:MemoryReasoningRequest):Promise<MemoryReasoningResult>{
    const request=normalizeRequest(input);
    if(request.candidates.length===0)return {method:'reasoning_provider',candidate_count:0,selected_ids:[],references:[]};
    const versions=new Map(request.candidates.map(candidate=>[candidate.memory_id,candidate.version]));
    const providerCandidates=request.candidates.map(candidate=>({...candidate}));
    let response:unknown;
    try{
      response=await this.provider.selectCandidates({query:request.query,candidates:providerCandidates,limit:request.limit,...(request.signal?{signal:request.signal}:{})});
    }catch(error){
      if(error instanceof Error&&SAFE_AUXILIARY_ERRORS.has(error.message))throw error;
      fail(request.signal?.aborted?'memory_reasoning_aborted':'memory_reasoning_provider_failed');
    }
    const ids=selectedIds(response,request.ids,request.limit);
    return {
      method:'reasoning_provider',candidate_count:request.candidates.length,selected_ids:ids,
      references:ids.map((memory_id,index)=>({memory_id,version:versions.get(memory_id)!,rank:index+1,reason:'reasoning_provider'})),
    };
  }
}

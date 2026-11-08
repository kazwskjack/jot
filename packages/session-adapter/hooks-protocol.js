// Adapted from PilotDeck revision 783499ffdb2d501bf590b2e035acd027a882df10.
// See runtime-patches/PILOTDECK-AGPL-3.0.txt for the upstream GNU AGPL v3 license.
import {HOOK_EVENTS} from './hooks-config.js';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value : undefined;
const boolean = value => typeof value === 'boolean' ? value : undefined;
const bounded = value => {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('hook_input_limit');
  return JSON.parse(text);
};

/** The native caller owns base identity; payload fields cannot replace it. */
export function createHookInput(event, base, payload = {}) {
  if (!HOOK_EVENTS.includes(event) || !record(base) || !record(payload)
    || !['sessionId','transcriptPath','cwd'].every(key => typeof base[key] === 'string')) throw new Error('hook_input_invalid');
  const input = bounded({...payload, ...base, hookEventName:event});
  return input;
}

export function toLegacyHookInput(input) {
  const {hookEventName,sessionId,transcriptPath,permissionMode,agentId,agentType,...rest} = input;
  const legacy = Object.fromEntries(Object.entries(rest).map(([key,value]) => [key.replace(/[A-Z]/g, letter=>'_'+letter.toLowerCase()),value]));
  Object.assign(legacy,{hook_event_name:hookEventName,session_id:sessionId,transcript_path:transcriptPath,cwd:input.cwd});
  if (permissionMode !== undefined) legacy.permission_mode = permissionMode;
  if (agentId !== undefined) legacy.agent_id = agentId;
  if (agentType !== undefined) legacy.agent_type = agentType;
  return legacy;
}

function permissionRequest(value) {
  if (!record(value)) return;
  if (value.behavior === 'allow') return {behavior:'allow',updatedInput:record(value.updatedInput)?value.updatedInput:undefined,
    updatedPermissions:Array.isArray(value.updatedPermissions)?value.updatedPermissions:undefined};
  if (value.behavior === 'deny') return {behavior:'deny',message:string(value.message),interrupt:boolean(value.interrupt)};
}

export function parseHookOutput(stdout, event) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout,'utf8') > 1024 * 1024) throw new Error('hook_output_limit');
  let parsed;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {parsed = JSON.parse(trimmed);} catch {return {type:'sync'};}
    break;
  }
  if (!record(parsed)) return {type:'sync'};
  if (parsed.async === true) return {type:'async',raw:parsed};
  const value = parsed.hookSpecificOutput;
  let specific;
  if (record(value) && typeof value.hookEventName === 'string') {
    if (value.hookEventName !== event) throw new Error('hook_output_event_mismatch');
    specific = {
      hookEventName:value.hookEventName,additionalContext:string(value.additionalContext),initialUserMessage:string(value.initialUserMessage),
      watchPaths:Array.isArray(value.watchPaths)?value.watchPaths.filter(item=>typeof item==='string'):undefined,
      permissionDecision:['allow','deny','ask','passthrough'].includes(value.permissionDecision)?value.permissionDecision:undefined,
      permissionDecisionReason:string(value.permissionDecisionReason),updatedInput:record(value.updatedInput)?value.updatedInput:undefined,
      updatedMCPToolOutput:value.updatedMCPToolOutput,decision:permissionRequest(value.decision),retry:boolean(value.retry),worktreePath:string(value.worktreePath),
    };
  }
  return {type:'sync',continue:boolean(parsed.continue),suppressOutput:boolean(parsed.suppressOutput),stopReason:string(parsed.stopReason),
    decision:['approve','block'].includes(parsed.decision)?parsed.decision:undefined,reason:string(parsed.reason),systemMessage:string(parsed.systemMessage),specific,raw:parsed};
}

/** Effects are proposed data. Native permission, budget and operation authority still apply. */
export function hookEffects(output, hookName) {
  if (output.type === 'async') return [];
  const effects = [];
  if (output.systemMessage) effects.push({type:'system_message',content:output.systemMessage});
  if (output.continue === false || output.decision === 'block') effects.push({type:'block',reason:output.reason??output.stopReason??'Hook blocked execution.',stopReason:output.stopReason});
  const specific = output.specific;
  if (!specific) return effects;
  if (specific.additionalContext) effects.push({type:'additional_context',content:specific.additionalContext,source:hookName});
  if (specific.initialUserMessage) effects.push({type:'initial_user_message',message:specific.initialUserMessage});
  if (specific.watchPaths?.length) effects.push({type:'watch_paths',paths:specific.watchPaths});
  if (specific.worktreePath) effects.push({type:'worktree_path',path:specific.worktreePath});
  if (specific.permissionDecision) effects.push({type:'permission_decision',behavior:specific.permissionDecision,reason:specific.permissionDecisionReason});
  if (specific.updatedInput) effects.push({type:'updated_tool_input',input:specific.updatedInput});
  if (specific.updatedMCPToolOutput !== undefined) effects.push({type:'updated_mcp_tool_output',output:specific.updatedMCPToolOutput});
  if (specific.decision) effects.push({type:'permission_request_result',result:specific.decision});
  if (specific.retry) effects.push({type:'retry_permission_denied'});
  return effects;
}

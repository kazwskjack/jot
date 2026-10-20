// Optional compatibility delta for separately installed MIT-licensed DSH.
// Copyright (c) 2026 DeepSeek. See runtime-patches/DSH-MIT-LICENSE.txt.
import {patchDshPreSetupSource} from './dsh-pre-setup-patch.js';
import {patchDshPendingInputSource} from './dsh-pending-input-patch.js';
const classAnchor='var AgentLoop = class extends Service {\n';
const marker='\t/** Jot optional pre-storage admission; not an upstream API. */\n\tjotStorageAdmissionHookProtocol = 1;\n';
const typeAnchor='export declare class AgentLoop extends Service implements AgentFactory {\n';
const typeMarker='    readonly jotStorageAdmissionHookProtocol: 1;\n';
const event="/** Jot optional pre-storage admission; not an upstream API. */\ndeclare module '@deepseek-ai/cordis' {\n    interface Events {\n        'agent-loop/before-storage'(payload: { sessionId: string; source: 'startup' | 'resume'; signal: AbortSignal }): void | Promise<void>;\n    }\n}\n";
const once=(source,before,after)=>{if(source.split(before).length!==2)throw Error('dsh_storage_admission_patch_anchor');return source.replace(before,after);};
function early(owner,id,signal,source,indent){return [
 `${indent}${owner}.fiber.assertActive();`,
 `${indent}const jotAdmissionId = ${id};`,
 `${indent}const jotAdmissionSignal = AbortSignal.any([this.ownership.signal, ...${signal} === void 0 ? [] : [${signal}]]);`,
 `${indent}await raceAbort(${owner}.events.serial("agent-loop/before-storage", { sessionId: jotAdmissionId, source: "${source}", signal: jotAdmissionSignal }), jotAdmissionSignal, jotAdmissionId);`,
 `${indent}jotAdmissionSignal.throwIfAborted();`,
 `${indent}if (${id} !== jotAdmissionId) throw Error("dsh_storage_admission_identity_changed");`,
 `${indent}${owner}.fiber.assertActive();`,
 ].join('\n')+'\n';}
const create='\tasync create(id, options = {}, meta = {}) {\n';
const createAgent='\tasync createAgent(ownerCtx, options) {\n';
const resume='\t\t\t\ttry {\n\t\t\t\t\thandle = await raceAbortCall(() => persistence.open(id, "write", { signal: fused }), fused, id, (abandoned) => {';
const deltas=[
 [create,create+early('this.ctx','id','this.ownership.signal','startup','\t\t')],
 [createAgent,createAgent+early('ownerCtx','options.sessionId','options.signal','startup','\t\t')],
 [resume,'\t\t\t\ttry {\n'+early('ownerCtx','id','fused','resume','\t\t\t\t\t')+'\t\t\t\t\thandle = await raceAbortCall(() => persistence.open(id, "write", { signal: fused }), fused, id, (abandoned) => {'],
 ];
/** Exact-artifact transform layered on the existing reviewed setup/pending
 * deltas. Original persistence, driver, cancellation and planner remain intact. */
export function patchDshStorageAdmissionSource({version,runtimeSource,declarationSource,pendingInputWake=false}={}){
 if(typeof runtimeSource!=='string'||typeof declarationSource!=='string'||typeof pendingInputWake!=='boolean')throw Error('dsh_storage_admission_patch_invalid');
 const patched=runtimeSource.includes(marker),typed=declarationSource.includes(typeMarker);
 if(patched!==typed)throw Error('dsh_storage_admission_patch_partial');
 let runtime=runtimeSource,types=declarationSource;
 if(patched){
  runtime=once(runtime,classAnchor+marker,classAnchor);for(const [before,after] of deltas)runtime=once(runtime,after,before);
  types=once(once(types,typeAnchor+typeMarker,typeAnchor),event,'');
 }
 const base=(pendingInputWake?patchDshPendingInputSource:patchDshPreSetupSource)({version,runtimeSource:runtime,declarationSource:types});
 if(patched&&base.changed)throw Error('dsh_storage_admission_patch_partial');
 if(patched)return Object.freeze({...base,changed:false,nativeAdmissionProtocol:1,runtimeSource,declarationSource});
 runtime=once(base.runtimeSource,classAnchor,classAnchor+marker);for(const [before,after] of deltas)runtime=once(runtime,before,after);
 types=event+once(base.declarationSource,typeAnchor,typeAnchor+typeMarker);
 return Object.freeze({...base,changed:true,nativeAdmissionProtocol:1,runtimeSource:runtime,declarationSource:types});
}

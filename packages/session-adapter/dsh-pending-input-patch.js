// Optional compatibility delta for separately installed MIT-licensed DSH.
// Copyright (c) 2026 DeepSeek. See runtime-patches/DSH-MIT-LICENSE.txt.
import {patchDshPreSetupSource} from './dsh-pre-setup-patch.js';
const anchor='\tfollowup(input) {\n';
const method=[
 '\t/** Jot compatibility only: latch existing exact input behind native maintenance. */',
 '\tjotPendingInputProtocol = 1;',
 '\tjotResumePending(request) {',
 '\t\tconst valid = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);',
 '\t\tif (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).sort().join(",") !== "messageIds,requestId,seq" || !valid(request.requestId) || !Number.isSafeInteger(request.seq) || request.seq < 0 || !Array.isArray(request.messageIds) || !request.messageIds.length || request.messageIds.some(id => !valid(id)) || new Set(request.messageIds).size !== request.messageIds.length) throw Error("dsh_pending_input_invalid");',
 '\t\tif (this.phase.kind !== "maintenance" || this.phase.abort.signal.aborted || this.phase.wakeRequested || this.session.seq !== request.seq) throw Error("dsh_pending_input_changed");',
 '\t\tconst pending = [...this.inbox.nextStep, ...this.inbox.nextTurn];',
 '\t\tif (pending.length !== request.messageIds.length || pending.some((message, index) => message.id !== request.messageIds[index] || message.role !== "user" || message.source?.kind !== "user" || message.source.rpcId !== request.requestId)) throw Error("dsh_pending_input_identity");',
 '\t\t// The original driver owns the latch. No inbox append, removal or prompt.',
 '\t\tthis.wakeDriver();',
 '\t\treturn { accepted: true, messageIds: [...request.messageIds], seq: request.seq };',
 '\t}',
 '',
].join('\n');
const declarations=[
 '/** Jot optional existing-input wake extension; not an upstream API. */',
 "declare module '@deepseek-ai/dsh-agent' {",
 '    interface Agent {',
 '        readonly jotPendingInputProtocol?: 1;',
 '        jotResumePending?(request: { requestId: string; messageIds: readonly string[]; seq: number }): { accepted: true; messageIds: string[]; seq: number };',
 '    }',
 '}',
 '',
].join('\n');
const once=(source,before,after)=>{if(source.split(before).length!==2)throw Error('dsh_pending_input_patch_anchor');return source.replace(before,after);};

/** Pure exact-artifact transform, layered on the audited setup hooks. Does not
 * install into a running Host or authorize any product run. */
export function patchDshPendingInputSource({version,runtimeSource,declarationSource}={}){
 if(typeof runtimeSource!=='string'||typeof declarationSource!=='string')throw Error('dsh_pending_input_patch_invalid');
 const runtimePatched=runtimeSource.includes(method),typesPatched=declarationSource.includes(declarations);
 if(runtimePatched!==typesPatched)throw Error('dsh_pending_input_patch_partial');
 const base=patchDshPreSetupSource({version,runtimeSource:runtimePatched?once(runtimeSource,method,''):runtimeSource,declarationSource:typesPatched?once(declarationSource,declarations,''):declarationSource});
 if(runtimePatched&&base.changed)throw Error('dsh_pending_input_patch_partial');
 if(runtimePatched)return Object.freeze({changed:false,protocol:2,pendingInputProtocol:1,runtimeSource,declarationSource});
 return Object.freeze({changed:true,protocol:2,pendingInputProtocol:1,runtimeSource:once(base.runtimeSource,anchor,method+anchor),declarationSource:declarations+base.declarationSource});
}

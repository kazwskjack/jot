// Optional compatibility delta for separately installed MIT-licensed DSH.
// Copyright (c) 2026 DeepSeek. See runtime-patches/DSH-MIT-LICENSE.txt.
import {createHash} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const original={runtime:'00c4814d63f3d1e2754eb09144832d19b30499d6ea444730473f740b587948c2',declarations:'906f202b859b11f7b0a399d8c4921c47384dd6177c990d59b8a93026a9875e8e'};
const classAnchor='var AgentLoop = class extends Service {\n';
const protocol='\t/** Jot optional host-only setup hooks; not an upstream API. */\n\tjotPreSetupHookProtocol = 2;\n';
const setupAnchor='\t\t\t\t(await raceAbort(setup?.(prepared.agent.ctx, prepared.agent), prepared.signal, id))?.commit();\n\t\t\t\tawait this.appendUnstoredSuffix(stored, session);\n\t\t\t\treturn await prepared.publish(source);';
const abortAnchor='\t\t\t\tsignal: abort.signal,\n\t\t\t\tpublish: async (source) => {';
const abortBinding='\t\t\t\tsignal: abort.signal,\n\t\t\t\tjotAbortSetup: (reason) => abort.abort(reason),\n\t\t\t\tpublish: async (source) => {';
const hookedSetup=[
 '\t\t\t\tconst jotSignalCleanup = [];',
 '\t\t\t\ttry {',
 '\t\t\t\t\tawait raceAbort(agentEvents(prepared.agent.ctx, prepared.agent).serial("agent/before-setup", { source, signal: prepared.signal, bindAbortSignal: (signal) => { const abort = () => prepared.jotAbortSetup(signal.reason); if (signal.aborted) abort(); else { signal.addEventListener("abort", abort, { once: true }); jotSignalCleanup.push(() => signal.removeEventListener("abort", abort)); } } }), prepared.signal, id);',
 '\t\t\t\t\tprepared.signal.throwIfAborted();',
 '\t\t\t\t\tconst jotPreparedSetup = await raceAbort(setup?.(prepared.agent.ctx, prepared.agent), prepared.signal, id);',
 '\t\t\t\t\tawait raceAbort(agentEvents(prepared.agent.ctx, prepared.agent).serial("agent/after-setup", { source, signal: prepared.signal }), prepared.signal, id);',
 '\t\t\t\t\tprepared.signal.throwIfAborted();',
 '\t\t\t\t\tjotPreparedSetup?.commit();',
 '\t\t\t\t\tawait this.appendUnstoredSuffix(stored, session);',
 '\t\t\t\t\tprepared.signal.throwIfAborted();',
 '\t\t\t\t\treturn await prepared.publish(source);',
 '\t\t\t\t} finally { for (const cleanup of jotSignalCleanup) cleanup(); }',
].join('\n');
const eventAnchor='    interface Events {\n';
const event='        /** Jot optional host-only extensions around original setup. */\n        \'agent/before-setup\'(payload: { agent: Agent; source: \'startup\' | \'resume\'; signal: AbortSignal; bindAbortSignal(signal: AbortSignal): void }): void | Promise<void>;\n        \'agent/after-setup\'(payload: { agent: Agent; source: \'startup\' | \'resume\'; signal: AbortSignal }): void | Promise<void>;\n';
const typeAnchor='export declare class AgentLoop extends Service implements AgentFactory {\n';
const typeProtocol='    readonly jotPreSetupHookProtocol: 2;\n';
function once(source,before,after){if(source.split(before).length!==2)throw Error('dsh_pre_setup_patch_anchor');return source.replace(before,after);}

/** Pure transform; never edits a running installation. Only the exact tested
 * upstream rc2 distribution (or this exact complete delta) is accepted. */
export function patchDshPreSetupSource({version,runtimeSource,declarationSource}={}){
 if(version!=='0.2.0-rc.2'||typeof runtimeSource!=='string'||typeof declarationSource!=='string')throw Error('dsh_pre_setup_patch_version');
 const runtimePatched=runtimeSource.includes(protocol),typesPatched=declarationSource.includes(typeProtocol);
 if(runtimePatched!==typesPatched)throw Error('dsh_pre_setup_patch_partial');
 let runtime=runtimeSource,types=declarationSource;
 if(runtimePatched){runtime=once(runtime,classAnchor+protocol,classAnchor);runtime=once(runtime,hookedSetup,setupAnchor);runtime=once(runtime,abortBinding,abortAnchor);types=once(types,eventAnchor+event,eventAnchor);types=once(types,typeAnchor+typeProtocol,typeAnchor);}
 if(sha(runtime)!==original.runtime||sha(types)!==original.declarations)throw Error('dsh_pre_setup_patch_source_changed');
 if(runtimePatched)return Object.freeze({changed:false,protocol:2,runtimeSource,declarationSource});
 runtime=once(runtime,classAnchor,classAnchor+protocol);runtime=once(runtime,setupAnchor,hookedSetup);runtime=once(runtime,abortAnchor,abortBinding);types=once(types,eventAnchor,eventAnchor+event);types=once(types,typeAnchor,typeAnchor+typeProtocol);
 return Object.freeze({changed:true,protocol:2,runtimeSource:runtime,declarationSource:types});
}

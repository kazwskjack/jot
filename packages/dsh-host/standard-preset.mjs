// Reuse the installed official standard declaration, including its isolated
// compaction/planning/delegation groups. Do not copy or simplify its child list.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
export const name='jot-standard-preset';
export const inject=['agentPresets','profileContext'];
export async function apply(ctx,config={}){
 if(Object.keys(config).some(key=>key!=='budgeted')||config.budgeted!==undefined&&typeof config.budgeted!=='boolean')throw Error('jot_preset_config_invalid');
 // Resolve from the launcher's installation, exactly as in-box bundles do.
 // A source checkout outside node_modules has no package resolver ancestry.
 const anchor=ctx.get('profileContext')?.installAnchor;if(typeof anchor!=='string')throw Error('jot_host_installation_missing');
 const manifest=JSON.parse(await readFile(anchor,'utf8'));
 if(manifest.name!=='@deepseek-ai/dsh'||manifest.version!=='0.2.1-rc.2')throw Error('jot_host_runtime_version_mismatch');
 const require=createRequire(anchor);
 const {loadOverlayPatches}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
 const source=require.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml');
 const layers=loadOverlayPatches('jot',source),declarations=layers.flatMap(layer=>layer.insert??[]);
 const original=declarations.find(row=>row.id==='preset-standard');
 if(original?.name!=='@deepseek-ai/dsh-agent-preset'||original.config?.id!=='standard'||!Array.isArray(original.config.plugins))throw Error('jot_standard_preset_source_invalid');
 const presetIds=['jot-general',...(config.budgeted?['jot-workbench-budgeted']:[])];
 for(const id of presetIds){
 const remove=await ctx.agentPresets.register({...original.config,id,name:id==='jot-general'?'Jot':'Jot Workbench'});ctx.effect(()=>remove);
 const resolved=await ctx.agentPresets.resolve(id);
 if(!resolved||resolved.broken!==undefined)throw Error('jot_standard_preset_mount_failed');
 }
 ctx.provide('jotHostReady',Object.freeze({presetId:'jot-general',presetIds:Object.freeze(presetIds)}));
}

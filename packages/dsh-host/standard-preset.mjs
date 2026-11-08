// Reuse the installed official standard declaration, including its isolated
// compaction/planning/delegation groups. Do not copy or simplify its child list.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {JOT_PERSONALITY} from '../../src/jot-personality.mjs';
export const name='jot-standard-preset';
export const inject=['agentPresets','profileContext'];
export function buildStandardPreset(original){
 const result=structuredClone(original),personas=result.plugins.filter(row=>row.id==='persona'&&row.name==='@deepseek-ai/dsh-persona');
 if(personas.length!==1)throw Error('jot_standard_preset_source_invalid');
 const config=personas[0].config??{};
 personas[0].config={...config,prefix:[config.prefix,JOT_PERSONALITY].filter(value=>typeof value==='string'&&value.trim()).join('\n\n')};
 const planning=result.plugins.filter(row=>row.id==='planning'&&row.name==='cordis:group'&&row.group===true&&row.isolate?.planMode===true);
 if(planning.length!==1||!Array.isArray(planning[0].config)
  ||planning[0].config.filter(row=>row.id==='plan-mode'&&row.name==='@deepseek-ai/dsh-plan-mode').length!==1
  ||planning[0].config.some(row=>row.id==='jot-plan-mode-recovery'))throw Error('jot_standard_plan_source_invalid');
 planning[0].config.push({id:'jot-plan-mode-recovery',name:new URL('./plan-mode-recovery.mjs',import.meta.url).href});
 return result;
}
export async function readOfficialStandard(ctx){
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
 return structuredClone(original.config);
}
export async function apply(ctx,config={}){
 if(Object.keys(config).some(key=>key!=='budgeted')||config.budgeted!==undefined&&typeof config.budgeted!=='boolean')throw Error('jot_preset_config_invalid');
 const original=buildStandardPreset(await readOfficialStandard(ctx));
 const presetIds=['jot-general',...(config.budgeted?['jot-workbench-budgeted']:[])];
 for(const id of presetIds){
 const remove=await ctx.agentPresets.register({...original,id,name:id==='jot-general'?'Jot':'Jot Workbench'});ctx.effect(()=>remove);
 // resolve() may wait for the Host Loader to settle, including rows waiting on
 // jotHostReady. This activation owns that provider, so keep the check synchronous.
 const composition=ctx.agentPresets.inspectCompositions().find(value=>value.id===id);
 if(!composition||composition.modules.length===0||composition.leakedServices.length>0)throw Error('jot_standard_preset_mount_failed');
 }
 ctx.provide('jotHostReady',Object.freeze({presetId:'jot-general',presetIds:Object.freeze(presetIds)}));
}

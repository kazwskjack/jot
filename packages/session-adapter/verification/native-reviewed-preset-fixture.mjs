// Actual SDK Registry/Loader fixture. The only search body is local/scripted.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
export const PRESET_MARKER='Reviewed local preset instructions remain mounted.';

export async function mountReviewedPresetFixture(ctx,{runtime,presetId,artifactPaths}){
 const load=async name=>{const path=join(runtime,name,'lib/index.js');artifactPaths.push({id:name,path});return import(pathToFileURL(path).href);};
 const loader=await load('cordis-plugin-loader'),registry=await load('dsh-agent-preset-registry'),scope=await load('dsh-scope');
 const state={activations:0,executions:0,rejections:0};let tool,reviewedGeneration;
 const plugin={name:'jot-reviewed-fixture',inject:['tools','systemPrompt'],apply(context,config){
  state.activations++;
  const generation=Object.freeze({});if(state.activations===1)reviewedGeneration=generation;
  context.provide('jotReviewedFixtureGeneration',generation);
  context.systemPrompt.section({name:'jot:reviewed-fixture',order:100,text:()=>PRESET_MARKER});
  tool={name:'universe_search',description:'Return a deterministic local fixture result. No web request.',parameters:{type:'object',additionalProperties:false,required:['query'],properties:{query:{type:'string'}}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{state.executions++;return 'Checked local fixture result.';}};
  context.tools.register(tool);
  context.tools.guard(exec=>{if(config.policy==='reviewed'&&exec.name==='universe_search'&&exec.arguments?.query==='deny'){state.rejections++;return 'REVIEWED_PRESET_DENIED';}});
 }};
 await ctx.plugin(loader.default);ctx.loader.builtins['jot-reviewed-fixture']=plugin;
 await ctx.plugin(registry.default,{default:presetId});
 const definition={id:presetId,name:'Reviewed local fixture',plugins:[{id:'reviewed-capabilities',name:'cordis:jot-reviewed-fixture',isolate:{jotReviewedFixtureGeneration:true},config:{policy:'reviewed'}}]};let remove=await ctx.agentPresets.register(definition);ctx.effect(()=>()=>remove());
 const metadata=await ctx.agentPresets.resolve(presetId);assert.equal(metadata.broken,undefined);
 const mounts=ctx.agentPresets.inspectCompositions();assert.equal(mounts.length,1);assert.equal(mounts[0].id,presetId);assert.ok(reviewedGeneration);assert.equal(state.activations,1);
 artifactPaths.push({id:'reviewed-preset-fixture',path:fileURLToPath(import.meta.url)});
 const readback=agent=>({presetId:ctx.agentPresets.composedPreset(agent.ctx)??null,generationMatches:ctx.agentPresets.serviceFor(agent,'jotReviewedFixtureGeneration')===reviewedGeneration,exactTool:ctx.tools.get('universe_search',scope.scopeOf(agent.ctx))?.execute===tool.execute,rootToolAbsent:ctx.tools.get('universe_search')===undefined,...state});
 return {
  state,readback,
  async replaceGeneration(){await remove();remove=await ctx.agentPresets.register({...definition,plugins:[{...definition.plugins[0],config:{policy:'unreviewed'}}]});assert.equal((await ctx.agentPresets.resolve(presetId)).broken,undefined);},
  async verify({agent,phase}){
   const inventory=await ctx.agentPresets.compositionInventory(),entry=inventory.find(item=>item.id===presetId),current=ctx.agentPresets.inspectCompositions();
   if(ctx.loader.builtins['jot-reviewed-fixture']!==plugin||state.activations!==1||current.length!==1||current[0].id!==presetId||current[0].leakedServices.length!==0||entry?.broken!==undefined||entry?.rows.length!==1||entry.rows[0].moduleName!=='cordis:jot-reviewed-fixture'||entry.rows[0].enabled!==true)return false;
   if(phase==='prepared')return ctx.agentPresets.composedPreset(agent.ctx)===undefined;
   const actual=readback(agent);return actual.presetId===presetId&&actual.generationMatches&&actual.exactTool&&actual.rootToolAbsent;
  },
 };
}

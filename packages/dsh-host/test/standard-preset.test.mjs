import assert from 'node:assert/strict';
import {join} from 'node:path';
import test from 'node:test';
import * as standardPreset from '../standard-preset.mjs';
import {apply} from '../standard-preset.mjs';

const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
test('Work adds shared Jot personality to the official persona without changing its module tree or other configuration',()=>{
 assert.equal(typeof standardPreset.buildStandardPreset,'function');
 const original={id:'standard',name:'@deepseek-ai/dsh-agent-preset',plugins:[
  {id:'persona',name:'@deepseek-ai/dsh-persona',config:{prefix:'Official Work persona',temperature:0.4,voice:'warm'}},
  {id:'tool-web',name:'@deepseek-ai/dsh-tool-web',config:{search:true}},
  {id:'tool-fs',name:'@deepseek-ai/dsh-tool-fs',config:{read:true,write:true}},
  {id:'isolated-tools',name:'cordis:group',isolate:{tools:true},config:[{id:'planner',name:'@deepseek-ai/dsh-planner'},{id:'delegate',name:'@deepseek-ai/dsh-delegate'}]},
 ]},before=structuredClone(original);
 const result=standardPreset.buildStandardPreset(original);
 assert.deepEqual(original,before);
 assert.deepEqual(result.plugins.map(row=>row.id),original.plugins.map(row=>row.id));
 assert.deepEqual(result.plugins.filter(row=>row.id!=='persona'),original.plugins.filter(row=>row.id!=='persona'));
 const persona=result.plugins.find(row=>row.id==='persona');
 assert.match(persona.config.prefix,/Official Work persona/);
 assert.match(persona.config.prefix,/J is Dad and X is Mom/);
 assert.equal(persona.config.temperature,0.4);assert.equal(persona.config.voice,'warm');
});

test('Host readiness does not wait for preset audit during Host row activation',{skip:!runtime},async()=>{
 const definitions=[],provided=new Map(),effects=[];
 const context={
  agentPresets:{
   async register(definition){definitions.push(definition);return()=>{};},
   inspectCompositions(){return definitions.map(definition=>({id:definition.id,modules:definition.plugins.map(plugin=>plugin.id),leakedServices:[]}));},
   async resolve(){throw Error('preset audit cannot wait for Host loader settlement during activation');},
  },
  get(service){if(service==='profileContext')return{installAnchor:join(runtime,'dsh','package.json')};throw Error('unexpected service '+service);},
  effect(dispose){effects.push(dispose);},
  provide(name,value){provided.set(name,value);},
 };
 await apply(context,{budgeted:true});
 assert.deepEqual(definitions.map(definition=>definition.id),['jot-general','jot-workbench-budgeted']);
 assert.deepEqual(provided.get('jotHostReady'),{presetId:'jot-general',presetIds:['jot-general','jot-workbench-budgeted']});
 assert.equal(effects.length,2);
});

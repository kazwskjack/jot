import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
test('misfire API enums and advertised policies agree with the YAML contract',async()=>{
 const root=new URL('../../contracts/',import.meta.url),spec=JSON.parse(await readFile(new URL('openapi.json',root),'utf8')),yaml=await readFile(new URL('openapi.yaml',root),'utf8');
 const ajv=new Ajv({strict:false});addFormats(ajv);const validate=ajv.compile(spec.components.schemas.PersistentTaskTrigger);
 for(const kind of ['daily','weekly','cron']){
  const base=kind==='cron'?{kind,expression:'* * * * *',timezone:'UTC'}:{kind,time:'09:00',timezone:'UTC',...(kind==='weekly'?{weekdays:[1]}:{})};
  assert.equal(validate(base),true);
  for(const policy of ['coalesce','skip','catch_up'])assert.equal(validate({...base,missed_triggers:policy}),true,JSON.stringify(validate.errors));
  assert.equal(validate({...base,missed_triggers:'unbounded'}),false);
 }
 for(const name of ['PersistentTaskTrigger','WorkbenchTaskScheduleLimits'])assert.deepEqual(JSON.parse(yaml.split('\n').find(line=>line.startsWith('    '+name+': ')).split(': ').slice(1).join(': ')),spec.components.schemas[name]);
});

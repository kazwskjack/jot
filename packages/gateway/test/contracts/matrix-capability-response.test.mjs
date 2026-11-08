import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, mkdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../../src/server.ts';
import {ContractValidator} from '../../src/contracts/validator.ts';

test('capabilities retain the existing Matrix binding flag under response validation', async t => {
  const parent = resolve('.test-tmp/matrix-capability-response');
  mkdirSync(parent, {recursive:true});
  const dir = mkdtempSync(join(parent, 'case-'));
  const service = await buildServer({databasePath:join(dir,'gateway.sqlite'),uploadRoot:join(dir,'uploads'),
    workbenchRoot:join(dir,'workbench'),workspaces:['ws'],
    templateRoot:fileURLToPath(new URL('../../file-engine/templates/', import.meta.url))});
  t.after(async()=>{await service.app.close();service.db.close();});
  const response = await service.app.inject({method:'GET',url:'/v1/capabilities',headers:{'x-user-id':'matrix-capability-owner'}});
  assert.equal(response.statusCode,200,response.body);
  const body=response.json();
  assert.equal(body.workbench.matrix_bindings,false);
  const validator=new ContractValidator(),operation=validator.operationFor('GET','/v1/capabilities');
  assert.equal(validator.validateResponse(operation,200,{...body,workbench:{...body.workbench,matrix_bindings:'yes'}}).valid,false);
});

test('Matrix binding capability remains boolean and synchronized in JSON, YAML and types', () => {
  const json = JSON.parse(readFileSync(new URL('../../contracts/openapi.json',import.meta.url),'utf8'));
  const yaml = readFileSync(new URL('../../contracts/openapi.yaml',import.meta.url),'utf8');
  const line = yaml.split('\n').find(row=>row.startsWith('    WorkbenchCapabilities: '));
  const yamlSchema = JSON.parse(line.slice(line.indexOf(':')+1));
  assert.deepEqual(json.components.schemas.WorkbenchCapabilities.properties.matrix_bindings,{type:'boolean'});
  assert.deepEqual(yamlSchema.properties.matrix_bindings,{type:'boolean'});
  const types = readFileSync(new URL('../../contracts/types.ts',import.meta.url),'utf8');
  assert.match(types,/matrix_bindings\?:\s*boolean/);
});

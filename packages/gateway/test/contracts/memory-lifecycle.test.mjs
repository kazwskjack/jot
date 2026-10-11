import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ContractValidator} from '../../src/contracts/validator.ts';

const spec=JSON.parse(readFileSync(new URL('../../contracts/openapi.json',import.meta.url),'utf8'));
test('memory save validates bounded provenance and timezone-qualified expiry while keeping old CRUD valid',()=>{
 const validator=new ContractValidator(),op=validator.operationFor('POST','/v1/workspaces/{workspace_id}/memory');
 const old={scope:'project',project_id:'project',content:'Conclusion'};
 assert.equal(validator.validateRequest(op,old).valid,true);
 const input={...old,provenance:[{kind:'document',reference:'notes/source.md'}],source_revision:'rev-1',expires_at:'2026-10-04T12:00:00+08:00',supersedes:'memory-old'};
 assert.equal(validator.validateRequest(op,input).valid,true);
 for(const change of [{provenance:Array(21).fill({kind:'document',reference:'source'})},{provenance:[{kind:'x'.repeat(61),reference:'source'}]},{provenance:[{kind:'document',reference:'x'.repeat(2049)}]},{source_revision:'x'.repeat(129)},{expires_at:'2026-10-04T12:00:00'},{verified_at:'2026-10-04T12:00:00Z'},{owner_id:'other'}])assert.equal(validator.validateRequest(op,{...input,...change}).valid,false,JSON.stringify(change));
 assert.equal(validator.validateRequest(op,{...old,provenance:[],source_revision:null,expires_at:null,supersedes:null}).valid,true);
});
test('memory export has a versioned bounded public envelope and documented filters',()=>{
 const validator=new ContractValidator(),op=validator.operationFor('GET','/v1/workspaces/{workspace_id}/memory/export');
 assert.ok(op);
 const item={memory_id:'m',workspace_id:'ws',project_id:'p',scope:'project',agent_id:null,content:'Conclusion',verified:false,version:1,created_at:'2026-10-02T00:00:00Z',updated_at:'2026-10-02T00:00:00Z',provenance:[],source_revision:null,expires_at:null,supersedes:null,verified_at:null,status:'active',expired:false};
 const value={schema_version:1,workspace_id:'ws',exported_at:'2026-10-02T00:00:00Z',items:[{...item,history:[{version:1,content:'Conclusion',verified:false,provenance:[],source_revision:null,expires_at:null,supersedes:null,verified_at:null,status:'active',created_at:item.created_at,updated_at:item.updated_at}]}]};
 assert.equal(validator.validateResponse(op,200,value).valid,true);
 for(const change of [{schema_version:2},{owner_id:'other'},{items:[{...item,owner_id:'other'}]}])assert.equal(validator.validateResponse(op,200,{...value,...change}).valid,false);
 const parameters=spec.paths['/v1/workspaces/{workspace_id}/memory/export'].get.parameters;
 for(const name of ['agent_id','project_id','scope','include_expired','q'])assert.ok(parameters.some(p=>p.name===name),name);
});

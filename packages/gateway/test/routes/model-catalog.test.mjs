import test from 'node:test';
import assert from 'node:assert/strict';
import {buildServer} from '../../src/server.ts';
const entry={provider:'fixture',model:'chosen',reasoning_output:'none',supported_reasoning_efforts:['low','high']};
test('owned capabilities project actual configured host model metadata without credentials',async()=>{
 let calls=0;const service=await buildServer({databasePath:':memory:',workspaces:['ws'],modelCatalogClient:{modelCatalog:async signal=>{calls++;assert.ok(signal instanceof AbortSignal);return{protocol:1,ready:true,models:[structuredClone(entry)]};}}});
 try{
  const denied=await service.app.inject({method:'GET',url:'/v1/capabilities'});assert.equal(denied.statusCode,401);assert.equal(calls,0);
  const response=await service.app.inject({method:'GET',url:'/v1/capabilities',headers:{'x-user-id':'catalog-owner'}});
  assert.equal(response.statusCode,200);assert.deepEqual(response.json().models,[entry]);assert.equal(calls,1);
 }finally{await service.app.close();service.db.close();}
});
test('missing, unready, failed and malformed model metadata cannot become UI choices',async()=>{
 for(const payload of [undefined,{protocol:1,ready:false,models:[entry]},{protocol:2,ready:true,models:[entry]},{protocol:1,ready:true,models:[{...entry,credential:'fixture-private'}]},{protocol:1,ready:true,models:[entry,entry]}]){
  const service=await buildServer({databasePath:':memory:',workspaces:['ws'],...(payload===undefined?{}:{modelCatalogClient:{modelCatalog:async()=>payload}})});
  try{const response=await service.app.inject({method:'GET',url:'/v1/capabilities',headers:{'x-user-id':'catalog-owner'}});assert.equal(response.statusCode,200);assert.deepEqual(response.json().models,[]);assert.ok(!response.body.includes('fixture-private'));}
  finally{await service.app.close();service.db.close();}
 }
});

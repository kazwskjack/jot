import assert from 'node:assert/strict';
import {test} from 'node:test';
const projectionModule = await import('./model-routing-status.mjs').catch(() => null);
function projection(){
 const value=projectionModule?.modelRoutingStatus;
 assert.equal(typeof value,'function','model route status projection is missing');
 return value;
}
test('model route projection keeps stale health visible and preserves the configured fallback order',()=>{
 const project=projection();if(!project)return;
 assert.deepEqual(project({provider:'primary',model:'reasoner',fallbacks:[{provider:'backup',model:'fast'}]},[
  {provider:'primary',model:'reasoner',health:{status:'stale',observed_at:10,expires_at:20}},
  {provider:'backup',model:'fast',health:{status:'healthy',observed_at:20,expires_at:30}}
 ]),{
  primary:'主模型 primary/reasoner：健康检查已过期',
  fallbacks:'备用顺序：backup/fast（健康）'
 });
});
test('unlisted routes stay unknown and never expose model-supplied URL or credentials',()=>{
 const project=projection();if(!project)return;
 const value=project({provider:'untrusted',model:'https://attacker.invalid/model',fallbacks:[{provider:'untrusted',model:'secret-route',url:'https://attacker.invalid',credential:'do-not-render'}]},[
  {provider:'trusted',model:'safe',health:{status:'healthy',observed_at:10,expires_at:20}}
 ]);
 assert.deepEqual(value,{primary:'主模型（健康状态未知）',fallbacks:'备用顺序：备用路线 1（健康状态未知）'});
 assert.doesNotMatch(JSON.stringify(value),/attacker|secret-route|credential/);
});
test('an absent fallback configuration is explicit',()=>{
 const project=projection();if(!project)return;
 assert.equal(project({provider:'p',model:'m'},[{provider:'p',model:'m',health:{status:'unknown',observed_at:null,expires_at:null}}]).fallbacks,'备用顺序：未配置');
});
test('changing the primary route preserves fallback order without keeping the new primary twice',()=>{
 const value=projectionModule?.modelSelectionPreservingFallbacks;
 assert.equal(typeof value,'function','model route selection fallback preservation is missing');
 if(typeof value!=='function')return;
 assert.deepEqual(value({provider:'backup',model:'fast'},
  {provider:'primary',model:'reasoner',fallbacks:[{provider:'backup',model:'fast'},{provider:'last',model:'safe'}]}),
  {provider:'backup',model:'fast',fallbacks:[{provider:'last',model:'safe'}]});
});
test('an explicit fallback edit replaces the server order and an empty edit clears it',()=>{
 const value=projectionModule?.modelSelectionPreservingFallbacks;
 assert.equal(typeof value,'function','model route selection fallback preservation is missing');
 if(typeof value!=='function')return;
 const current={provider:'primary',model:'reasoner',fallbacks:[{provider:'backup',model:'fast'}]};
 assert.deepEqual(value({provider:'primary',model:'reasoner',fallbacks:[{provider:'last',model:'safe'}]},current),
  {provider:'primary',model:'reasoner',fallbacks:[{provider:'last',model:'safe'}]});
 assert.deepEqual(value({provider:'primary',model:'reasoner',fallbacks:undefined},current),
  {provider:'primary',model:'reasoner',fallbacks:[]});
});
test('malformed configured fallback state blocks a primary-model change',()=>{
 const value=projectionModule?.modelSelectionPreservingFallbacks;
 assert.equal(typeof value,'function','model route selection fallback preservation is missing');
 if(typeof value!=='function')return;
 assert.throws(()=>value({provider:'backup',model:'fast'},
  {provider:'primary',model:'reasoner',fallbacks:[{provider:'backup',model:'fast',url:'https://untrusted.invalid'}]}),/配置未确认/);
});

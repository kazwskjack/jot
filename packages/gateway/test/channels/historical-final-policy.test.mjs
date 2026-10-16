import test from 'node:test';import assert from 'node:assert/strict';
const decide=(await import('../../src/channels/historical-final-policy.ts').catch(()=>({}))).decideHistoricalFinalDelivery;
const receipt=JSON.stringify({provider_message_id:'synthetic-provider-id'});
const effect=(patch={})=>({effect_id:'effect-old',message_id:'final-message',artifact_ref:null,payload_json:JSON.stringify({kind:'text',text:'Old answer'}),status:'pending',generation:0,provider_receipt_json:null,lease_owner:null,lease_expires_at:null,...patch});
const input=(effects=[],patch={})=>({message_id:'final-message',text:'Final answer',recipient_authorized:true,effects,protected_effect_ids:[],...patch});

test('first delivery uses the final body and revoked recipient authority never produces a send decision',()=>{
 assert.equal(typeof decide,'function');const result=decide(input());assert.equal(result.kind,'queue');assert.equal(result.mode,'final');assert.equal(result.text,'Final answer');assert.deepEqual(result.supersede_ids,[]);assert.equal(result.execution_authorized,false);assert.equal(decide(input([],{recipient_authorized:false})).kind,'revoke');
});
test('only a proven undispatched old final body can be superseded',()=>{
 assert.deepEqual(decide(input([effect()])).supersede_ids,['effect-old']);
 for(const patch of [{generation:1},{lease_owner:'worker'},{lease_expires_at:1},{provider_receipt_json:receipt}])assert.equal(decide(input([effect(patch)])).kind,'hold');
 assert.equal(decide(input([effect()],{protected_effect_ids:['effect-old']})).kind,'hold');
});
test('a conclusively delivered older answer gets one clearly labeled correction plan',()=>{
 const result=decide(input([effect({status:'delivered',generation:1,provider_receipt_json:receipt})]));assert.equal(result.kind,'queue');assert.equal(result.mode,'correction');assert.equal(result.text,'更新后的结果：\nFinal answer');assert.deepEqual(result.corrects_ids,['effect-old']);assert.deepEqual(result.supersede_ids,[]);
});
test('unknown, sending and receipt-pending old bodies hold without another effect or clearing original facts',()=>{
 for(const status of ['sending','receipt_pending','outcome_unknown']){const rows=[effect({status,generation:1,provider_receipt_json:status==='receipt_pending'?receipt:null})],before=JSON.stringify(rows),result=decide(input(rows));assert.equal(result.kind,'hold',status);assert.ok(result.wait_for_ids.includes('effect-old'));assert.equal(JSON.stringify(rows),before);assert.equal(result.execution_authorized,false);}
});
test('matching final effects are reused across pending, sent and uncertain states rather than multiplied',()=>{
 for(const status of ['pending','sending','receipt_pending','outcome_unknown','delivered']){const result=decide(input([effect({status,payload_json:JSON.stringify({kind:'text',text:'Final answer'}),generation:status==='pending'?0:1,provider_receipt_json:['delivered','receipt_pending'].includes(status)?receipt:null})]));assert.equal(result.kind,'reuse',status);assert.equal(result.effect_id,'effect-old');assert.equal(result.state,status==='delivered'?'delivered':status==='pending'?'queued':'pending_receipt');}
});
test('partial or malformed provider receipts are not conclusive delivery',()=>{
 for(const provider_receipt_json of [null,'{}','not json',JSON.stringify({total:2,receipts:[{part_index:1,provider_message_id:'part-one'}]}),JSON.stringify({total:2,receipts:[{part_index:1,provider_message_id:'one'},{part_index:1,provider_message_id:'two'}]})])assert.equal(decide(input([effect({status:'delivered',generation:1,provider_receipt_json})])).kind,'hold');
 const full=JSON.stringify({total:2,receipts:[{part_index:1,provider_message_id:'one'},{part_index:2,provider_message_id:'two'}]});assert.equal(decide(input([effect({status:'delivered',generation:1,provider_receipt_json:full})])).mode,'correction');
});
test('file effects and separate progress messages retain their own intent and receipts',()=>{
 for(const separate of [{artifact_ref:'artifact-output',payload_json:null},{message_id:'progress-message'}]){const result=decide(input([effect({...separate,status:'delivered',generation:1,provider_receipt_json:receipt})]));assert.equal(result.kind,'queue');assert.equal(result.mode,'final');assert.deepEqual(result.supersede_ids,[]);assert.deepEqual(result.corrects_ids,[]);assert.equal(decide(input([effect({...separate,status:'outcome_unknown',generation:1})])).kind,'hold');}
});
test('duplicate matching effects, cancelled intent and malformed records hold rather than inventing a new send',()=>{
 const matching=effect({payload_json:JSON.stringify({kind:'text',text:'Final answer'})});assert.equal(decide(input([matching,{...matching,effect_id:'second'}])).kind,'hold');
 for(const patch of [{status:'cancelled'},{status:'invented'},{generation:'0'},{payload_json:'broken'},{payload_json:JSON.stringify({kind:'text',text:'Old answer',extra:true})},{effect_id:''}])assert.equal(decide(input([effect(patch)])).kind,'hold');
});
test('a known final effect retains unrelated unknown provenance and never treats the whole run as settled',()=>{
 const result=decide(input([effect({payload_json:JSON.stringify({kind:'text',text:'Final answer'}),status:'delivered',generation:1,provider_receipt_json:receipt}),effect({effect_id:'file-unknown',artifact_ref:'artifact-file',payload_json:null,status:'outcome_unknown',generation:1})]));assert.equal(result.kind,'reuse');assert.equal(result.state,'delivered');assert.deepEqual(result.unresolved_effect_ids,['file-unknown']);
});

test('repeated provider part identities and a delivered row with a remaining lease are contradictory evidence',()=>{
 const repeated=JSON.stringify({total:2,receipts:[{part_index:1,provider_message_id:'same'},{part_index:2,provider_message_id:'same'}]});for(const patch of [{provider_receipt_json:repeated},{provider_receipt_json:receipt,lease_owner:'still-owned'},{provider_receipt_json:receipt,lease_expires_at:1}])assert.equal(decide(input([effect({status:'delivered',generation:1,...patch})])).kind,'hold');
});
test('an already queued or delivered correction is the same final intent, not a correction of itself',()=>{
 for(const status of ['pending','delivered']){const result=decide(input([effect({status,payload_json:JSON.stringify({kind:'text',text:'更新后的结果：\nFinal answer'}),generation:status==='delivered'?1:0,provider_receipt_json:status==='delivered'?receipt:null})]));assert.equal(result.kind,'reuse');assert.equal(result.mode,'correction');}
});
test('malformed caller scope and duplicate source identities yield no actionable send plan',()=>{
 for(const value of [{...input(),text:''},{...input(),action:'send'},{...input(),recipient_authorized:'yes'},{...input(),message_id:'../other'},{...input(),protected_effect_ids:[42]},input([effect(),effect()])])assert.equal(decide(value).kind,'hold');
});

test('recipient revocation does not discard previously unknown send provenance',()=>{
 const rows=[effect({status:'outcome_unknown',generation:1})],before=JSON.stringify(rows),result=decide(input(rows,{recipient_authorized:false}));assert.equal(result.kind,'revoke');assert.deepEqual(result.unresolved_effect_ids,['effect-old']);assert.equal(JSON.stringify(rows),before);
});

test('cancelled or failed file effects with prior attempts or receipts retain their uncertainty',()=>{
 for(const status of ['cancelled','failed']){const file=effect({effect_id:'uncertain-file',artifact_ref:'artifact-file',payload_json:null,status,generation:1,provider_receipt_json:JSON.stringify({total:2,receipts:[{part_index:1,provider_message_id:'first'}]})}),result=decide(input([file]));assert.equal(result.kind,'hold');assert.deepEqual(result.unresolved_effect_ids,['uncertain-file']);const matching=effect({status:'delivered',generation:1,provider_receipt_json:receipt,payload_json:JSON.stringify({kind:'text',text:'Final answer'})});assert.deepEqual(decide(input([matching,file])).unresolved_effect_ids,['uncertain-file']);}
});

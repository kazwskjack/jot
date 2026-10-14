import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createAdapterHandler, apply } from '../index.js'

const token = 'a'.repeat(32)
function fixture() {
  const calls = []
  const handler = createAdapterHandler({ token, controller: {
    create: async request => { calls.push(request); return { sessionId: request.sessionId } },
  } })
  const invoke = cwd => handler({ method: 'POST', url: new URL('http://127.0.0.1/v1/sessions'),
    headers: { authorization: `Bearer ${token}` }, body: { session_id: 'path-probe', cwd } })
  return { calls, invoke }
}

test('Session creation preserves a host-native absolute workspace path', async () => {
  const { calls, invoke } = fixture()
  const cwd = path.resolve('workspace-fixture')
  assert.equal((await invoke(cwd)).status, 201)
  assert.deepEqual(calls, [{ sessionId: 'path-probe', cwd }])
})

test('Session creation rejects relative, drive-relative, malformed and non-string paths before Controller dispatch', async () => {
  for (const cwd of ['workspace', '../workspace', 'E:workspace', '', '/workspace\u0000hidden', ['/workspace'], { path: '/workspace' }]) {
    const { calls, invoke } = fixture()
    assert.equal((await invoke(cwd)).status, 422)
    assert.deepEqual(calls, [])
  }
})

test('documented public presets reach the original Controller without name translation', async () => {
  for (const agentPreset of ['jot-general', 'jot-general-batch50', 'jot-general-batch']) {
    const calls = []
    const handler = createAdapterHandler({ token, controller: { create: async request => {
      calls.push(request); return { sessionId: request.sessionId, agentPreset: request.agentPreset }
    } } })
    const response = await handler({ method: 'POST', url: new URL('http://127.0.0.1/v1/sessions'),
      headers: { authorization: `Bearer ${token}` }, body: { session_id: 'preset-probe', cwd: path.resolve('workspace-fixture'), agent_preset: agentPreset } })
    assert.equal(response.status, 201)
    assert.equal(calls[0].agentPreset, agentPreset)
    assert.equal(response.value.agentPreset, agentPreset)
  }
})

test('unknown preset is rejected before Controller admission', async () => {
  let invoked = false
  const handler = createAdapterHandler({ token, controller: { create: async () => { invoked = true } } })
  const response = await handler({ method: 'POST', url: new URL('http://127.0.0.1/v1/sessions'),
    headers: { authorization: `Bearer ${token}` }, body: { session_id: 'preset-probe', cwd: path.resolve('workspace-fixture'), agent_preset: 'not-registered' } })
  assert.equal(response.status, 422)
  assert.equal(invoked, false)
})

test('the documented default token environment admits host setup without opening a listener in this test', () => {
  const prior = process.env.JOT_SESSION_ADAPTER_TOKEN
  const legacy = process.env.jot_SESSION_ADAPTER_TOKEN
  try {
    delete process.env.jot_SESSION_ADAPTER_TOKEN
    // Windows environment names are case-insensitive; delete before assigning.
    process.env.JOT_SESSION_ADAPTER_TOKEN = token
    const ctx = Object.defineProperty({}, 'sessionController', { get() { throw new Error('original_controller_setup_reached') } })
    assert.throws(() => apply(ctx), /original_controller_setup_reached/)
  } finally {
    if (prior === undefined) delete process.env.JOT_SESSION_ADAPTER_TOKEN
    else process.env.JOT_SESSION_ADAPTER_TOKEN = prior
    if (legacy === undefined) delete process.env.jot_SESSION_ADAPTER_TOKEN
    else process.env.jot_SESSION_ADAPTER_TOKEN = legacy
  }
})

test('formal setup rejects malformed operation observers and observers without native roles',()=>{
 const prior=process.env.JOT_SESSION_ADAPTER_TOKEN;process.env.JOT_SESSION_ADAPTER_TOKEN=token;
 try{
  const ctx=Object.defineProperty({},'sessionController',{get(){throw Error('controller_must_not_be_reached');}});
  for(const reconcileOperations of [{},async()=>{}])assert.throws(()=>apply(ctx,{reconcileOperations}),/jot_session_adapter_config_invalid/);
 }finally{if(prior===undefined)delete process.env.JOT_SESSION_ADAPTER_TOKEN;else process.env.JOT_SESSION_ADAPTER_TOKEN=prior;}
});

test('formal setup rejects native operation origins without native roles',()=>{
 const prior=process.env.JOT_SESSION_ADAPTER_TOKEN;process.env.JOT_SESSION_ADAPTER_TOKEN=token;
 try{const ctx=Object.defineProperty({},'sessionController',{get(){throw Error('controller_must_not_be_reached');}});assert.throws(()=>apply(ctx,{nativeOperationOrigin:'http://localhost:18792'}),/jot_session_adapter_config_invalid/);}
 finally{if(prior===undefined)delete process.env.JOT_SESSION_ADAPTER_TOKEN;else process.env.JOT_SESSION_ADAPTER_TOKEN=prior;}
});

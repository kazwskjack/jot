// Real installed SDK, Gateway, Worker, native Goal and isolated IO; only the
// loopback Messages model endpoint is scripted. Opt in explicitly after wiring.
import test from 'node:test';
import {nativeIsolatedWorkCase} from './native-isolated-work-fixture.mjs';
const enabled=!!process.env.JOT_DSH_RUNTIME_MODULES&&process.env.JOT_NATIVE_ISOLATED_WORK_ACCEPTANCE==='true';
test('official SDK executes selected isolated work through original owner review and immutable output delivery',{skip:!enabled,timeout:150000},t=>nativeIsolatedWorkCase(t,{discovery:true}));
test('official SDK cold work continuation retains Session Goal objective and one isolated write',{skip:!enabled,timeout:180000},t=>nativeIsolatedWorkCase(t,{discovery:true,workWait:true}));

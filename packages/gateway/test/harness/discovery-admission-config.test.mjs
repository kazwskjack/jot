import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDiscoveryAdmissionEnabled} from '../../src/harness/discovery-admission-config.ts';

test('discovery admission harness flag defaults off and accepts only explicit boolean strings',()=>{
 assert.equal(parseDiscoveryAdmissionEnabled(undefined),false);
 assert.equal(parseDiscoveryAdmissionEnabled('false'),false);
 assert.equal(parseDiscoveryAdmissionEnabled('true'),true);
 for(const value of ['TRUE','False','1','yes',''])assert.throws(()=>parseDiscoveryAdmissionEnabled(value),/discovery_admission_config_invalid/);
});

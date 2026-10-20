import test from 'node:test';import assert from 'node:assert/strict';import {resolve} from 'node:path';
import {normalizeNativeGitHostConfig,createNativeGitHost} from '../native-git-host.js';
import {apply} from '../index.js';
const config=()=>({databasePath:resolve('synthetic.sqlite'),repositories:[{owner_id:'owner',project_id:'project',root:resolve('synthetic-repo')}],socket:'synthetic-local-socket',tokenEnv:'JOT_NATIVE_GIT_TEST_CONFIG_TOKEN'});
test('native Git selectors are exact operator configuration and copied before asynchronous use',()=>{
 const original=config(),copy=normalizeNativeGitHostConfig(original);original.repositories[0].root='untrusted';assert.notEqual(copy.repositories[0].root,'untrusted');assert.ok(Object.isFrozen(copy.repositories[0]));
 for(const invalid of [{...config(),module:'untrusted'},{...config(),databasePath:'relative.sqlite'},{...config(),repositories:[...config().repositories,...config().repositories]},{...config(),tokenEnv:'PATH'}])assert.throws(()=>normalizeNativeGitHostConfig(invalid),/native_git_host_config_invalid/);
 const ctx=Object.defineProperty({},'sessionController',{get(){throw Error('controller_must_not_be_reached');}});
 assert.throws(()=>apply(ctx,{nativeGit:config()}),/native_git_host_config_invalid/);
});
test('missing native startup custody is rejected before opening database or transport',async()=>{
 const key=config().tokenEnv,previous=process.env[key];process.env[key]='test-native-git-config-token-0000001';
 try{await assert.rejects(createNativeGitHost({ctx:{},bridge:{},config:config(),allowedPresets:new Set(['jot-general'])}),/native_git_host_unavailable/);}
 finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
});

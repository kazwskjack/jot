// Observe the installed Controller's real persistence absence contract. This
// creates no Session, Agent, model request or alternate Controller.
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
export const name='jot-native-session-absence-inspection';
export const inject=['sessionController','sessions','agents'];
export async function apply(ctx,{receipt}){
 const {ApiSessionNotFound}=createRequire(ctx.get('profileContext').installAnchor)('@deepseek-ai/dsh-api-session-controller');
 const id='jot-never-created-absence-fixture';
 try{await ctx.sessionController.inspect(id);throw Error('native_absence_fixture_unexpected_session');}
 catch(error){
  const fact={constructor:error.constructor?.name,name:error.name,code:error.code??null,own_properties:Object.getOwnPropertyNames(error).sort(),official_absence:error instanceof ApiSessionNotFound,cached:!!ctx.sessions.get(id),agent:!!ctx.agents.get(id)};
  await writeFile(receipt,JSON.stringify(fact));
  if(!fact.official_absence||fact.cached||fact.agent)throw Error('native_absence_fixture_unverified');
 }
}

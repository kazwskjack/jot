import assert from 'node:assert/strict';
import test from 'node:test';
import { registerPersistentTaskRoutes } from '../../src/persistent-tasks/routes.ts';

test('task preview, create and edit route schemas share strict Cron, delay and misfire contracts', () => {
  const registered=[];
  const app={
    get(...args){registered.push({method:'GET',url:args[0],options:typeof args[1]==='function'?{}:args[1]??{}});},
    post(...args){registered.push({method:'POST',url:args[0],options:typeof args[1]==='function'?{}:args[1]??{}});},
    patch(...args){registered.push({method:'PATCH',url:args[0],options:typeof args[1]==='function'?{}:args[1]??{}});}
  };
  registerPersistentTaskRoutes(app,{},()=> 'alice',{},{});

  const routes=[
    registered.find(route=>route.method==='POST'&&route.url==='/v1/persistent-tasks/preview'),
    registered.find(route=>route.method==='POST'&&route.url==='/v1/persistent-tasks'),
    registered.find(route=>route.method==='PATCH'&&route.url==='/v1/persistent-tasks/:taskId')
  ];
  assert.ok(routes.every(Boolean));
  const validCron={kind:'cron',expression:'5,35 8-10/2 1,15 JAN-MAR MON-FRI',timezone:'Asia/Hong_Kong'};
  const validDelay={kind:'delay',delay_seconds:1};
  const validMisfires=[
    {kind:'daily',time:'09:00',timezone:'UTC',missed_triggers:'skip'},
    {kind:'weekly',time:'09:00',timezone:'UTC',weekdays:[1],missed_triggers:'catch_up'},
    {...validCron,missed_triggers:'coalesce'}
  ];
  for (const route of routes) {
    const bodySchema=route.options.schema.body;
    const validate=route.options.validatorCompiler({schema:bodySchema});
    const payload=route.url.endsWith('/preview')
      ? {trigger:validCron}
      : route.method==='PATCH'
        ? {expected_version:1,title:'Task',trigger:validCron}
        : {title:'Task',agent_id:'agent',objective:'Check a fixture',trigger:validCron};
    assert.equal(validate(payload),true,JSON.stringify(validate.errors));
    for (const trigger of validMisfires) {
      const policyPayload=route.url.endsWith('/preview')
        ? {trigger}
        : route.method==='PATCH'
          ? {expected_version:1,title:'Task',trigger}
          : {title:'Task',agent_id:'agent',objective:'Check a fixture',trigger};
      assert.equal(validate(policyPayload),true,JSON.stringify(validate.errors));
    }
    const delayPayload=route.url.endsWith('/preview')
      ? {trigger:validDelay}
      : route.method==='PATCH'
        ? {expected_version:1,title:'Task',trigger:validDelay}
        : {title:'Task',agent_id:'agent',objective:'Check a fixture',trigger:validDelay};
    assert.equal(validate(delayPayload),true,JSON.stringify(validate.errors));
  }

  const create=routes[1];
  const validateCreate=create.options.validatorCompiler({schema:create.options.schema.body});
  for (const invalid of [
    {kind:'delay',delay_seconds:0},
    {kind:'delay',delay_seconds:31536001},
    {kind:'cron',expression:'0 0 * * *',timezone:'UTC',command:'echo bad'},
    {kind:'cron',expression:'0 0 * * *',timezone:'UTC',missed_triggers:'unbounded'}
  ]) {
    assert.equal(validateCreate({title:'Task',agent_id:'agent',objective:'Check a fixture',trigger:invalid}),false);
  }
  assert.equal(validateCreate({title:'Task',agent_id:'agent',objective:'Check a fixture',trigger:{kind:'cron',expression:'0 0 * * *',timezone:'UTC'.repeat(34)}}),false);
});

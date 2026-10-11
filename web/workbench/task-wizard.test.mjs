import test from 'node:test';
import assert from 'node:assert/strict';
import * as form from './form-state.mjs';
const valid={title:'Follow up',agent_id:'a',objective:'Collect evidence',kind:'daily',time:'09:00',timezone:'UTC',max_runs:'5'};
test('wizard validates the current step without requiring fields from later steps',()=>{
 assert.equal(typeof form.validateTaskWizardStep,'function');
 assert.doesNotThrow(()=>form.validateTaskWizardStep({...valid,kind:'unset',max_runs:'invalid'},0));
 assert.throws(()=>form.validateTaskWizardStep({...valid,title:''},0));
 assert.throws(()=>form.validateTaskWizardStep({...valid,time:'25:00'},1));
 assert.throws(()=>form.validateTaskWizardStep({...valid,max_runs:'0'},2));
 assert.throws(()=>form.validateTaskWizardStep({...valid,objective:''},3));
 assert.throws(()=>form.validateTaskWizardStep(valid,5));
 assert.doesNotThrow(()=>form.validateTaskWizardStep(valid,4));
 assert.doesNotThrow(()=>form.validateTaskWizardStep(valid,3));
});

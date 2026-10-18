import test from 'node:test';
import assert from 'node:assert/strict';

const policy = await import('./prompt-composer-policy.mjs').catch(() => ({}));
const options = [{provider:'real',model:'alpha',supported_reasoning_efforts:['medium','high','xhigh']},{provider:'other',model:'alpha',supported_reasoning_efforts:['minimal']}];

test('effort cycling uses the selected provider and only server-supported levels',()=>{
 assert.equal(typeof policy.nextEffort,'function','composer effort policy must exist');
 assert.equal(policy.nextEffort(options,{provider:'real',model:'alpha'}),'xhigh');
 assert.equal(policy.nextEffort(options,{provider:'real',model:'alpha',reasoning_effort:'xhigh'}),'medium');
 assert.equal(policy.nextEffort(options,{provider:'other',model:'alpha'}),'minimal');
 assert.equal(policy.nextEffort(options,{provider:'absent',model:'alpha'}),undefined);
});
test('changing model prefers high only when supported and never fabricates an effort',()=>{
 assert.equal(typeof policy.modelSelection,'function','composer model policy must exist');
 assert.deepEqual(policy.modelSelection(options[0]),{provider:'real',model:'alpha',reasoning_effort:'high'});
 assert.deepEqual(policy.modelSelection({provider:'real',model:'none',supported_reasoning_efforts:[]}),{provider:'real',model:'none'});
 assert.deepEqual(policy.modelSelection(options[1]),{provider:'other',model:'alpha',reasoning_effort:'minimal'});
});
test('Enter sends while Shift+Enter and IME confirmation preserve the draft',()=>{
 assert.equal(typeof policy.isSubmitKey,'function','composer keyboard policy must exist');
 assert.equal(policy.isSubmitKey({key:'Enter'}),true);
 assert.equal(policy.isSubmitKey({key:'Enter',shiftKey:true}),false);
 assert.equal(policy.isSubmitKey({key:'Enter',isComposing:true}),false);
 assert.equal(policy.isSubmitKey({key:'Enter',keyCode:229}),false);
 assert.equal(policy.isSubmitKey({key:'a'}),false);
});
test('attachments, voice activity and a draft keep the composer expanded after blur',()=>{
 assert.equal(typeof policy.isComposerExpanded,'function','composer expansion policy must exist');
 assert.equal(policy.isComposerExpanded({}),false);
 for(const state of [{focused:true},{value:'draft'},{hasAttachments:true},{voiceActive:true},{menu:'model'}]) assert.equal(policy.isComposerExpanded(state),true);
 assert.equal(policy.isComposerExpanded({value:'  \n'}),false);
});

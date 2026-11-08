import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const workbenchRoot=fileURLToPath(new URL('.',import.meta.url));
const output=fileURLToPath(new URL('../../.test-tmp/host-settings-read-panel-test/',import.meta.url));
await mkdir(output,{recursive:true});
await build({entryPoints:[join(workbenchRoot,'HostSettingsReadPanel.tsx')],bundle:true,format:'cjs',platform:'node',external:['react'],outfile:join(output,'HostSettingsReadPanel.cjs'),logLevel:'silent'});
const require=createRequire(import.meta.url);
const {default:HostSettingsReadPanel}=require(join(output,'HostSettingsReadPanel.cjs'));

function renderer(component){
 const internals=React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,slots=[];
 let cursor=0,effects=[];
 const dispatcher={
  useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return[slots[index],next=>{slots[index]=typeof next==='function'?next(slots[index]):next;}];},
  useRef(initial){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
  useEffect(create,deps){
   const index=cursor++,previous=slots[index],changed=!previous||!deps||deps.length!==previous.deps.length||deps.some((value,i)=>!Object.is(value,previous.deps[i]));
   if(changed)effects.push(()=>{previous?.cleanup?.();const cleanup=create();slots[index]={deps,cleanup};});
  },
 };
 return{
  render(props){
   cursor=0;effects=[];const previous=internals.H;internals.H=dispatcher;
   let tree;try{tree=component(props);}finally{internals.H=previous;}
   const pending=effects;
   return{tree,markup:renderToStaticMarkup(tree),flushEffects(){for(const effect of pending)effect();}}
  },
 };
}

function nodes(node){
 if(Array.isArray(node))return node.flatMap(nodes);
 if(!React.isValidElement(node))return[];
 return[node,...nodes(node.props.children)];
}
function button(frame,label){
 const found=nodes(frame.tree).find(node=>node.type==='button'&&node.props.children===label);
 assert.ok(found,`button ${label} is rendered`);return found;
}
async function settle(){await new Promise(resolve=>setImmediate(resolve));}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const snapshot=marker=>({protocol:1,source:'dsh-settings-controller',namespaces:[{
 namespace:'agent-default-model',revision:7,state:'ready',applies:'live',secrets:[],value:{marker},
}]});
const props=(client,scopeKey,namespaces=['agent-default-model'],enabled=true)=>({enabled,namespaces,client,scopeKey});

test('an already loaded Host settings snapshot is cleared when task scope changes',async()=>{
 const read=deferred(),client={approveSettingsRead:async()=>({approved:true,namespaces:['agent-default-model']}),namespaceSettings:async()=>read.promise};
 const ui=renderer(HostSettingsReadPanel);
 let frame=ui.render(props(client,'task-a'));frame.flushEffects();
 button(frame,'批准并连接 Host').props.onClick();await settle();
 frame=ui.render(props(client,'task-a'));
 button(frame,'读取').props.onClick();
 read.resolve(snapshot('OWNER_A_PRIVATE_SETTING'));await settle();
 frame=ui.render(props(client,'task-a'));
 assert.match(frame.markup,/OWNER_A_PRIVATE_SETTING/,'the approved Host snapshot is visible in its original scope');

 frame=ui.render(props(client,'task-b'));
 assert.doesNotMatch(frame.markup,/OWNER_A_PRIVATE_SETTING/,'a task switch hides the previous scope before effects run');
 assert.ok(nodes(frame.tree).some(node=>node.type==='button'&&node.props.children==='批准并连接 Host'));
 frame.flushEffects();
});

test('late Host read success or failure cannot alter the new client/task/namespace scope',async()=>{
 const read=deferred(),clientA={approveSettingsRead:async()=>({approved:true,namespaces:['agent-default-model']}),namespaceSettings:async()=>read.promise};
 const clientB={approveSettingsRead:async()=>({approved:true,namespaces:['other-models']}),namespaceSettings:async()=>({})};
 const ui=renderer(HostSettingsReadPanel);
 let frame=ui.render(props(clientA,'task-a'));frame.flushEffects();
 button(frame,'批准并连接 Host').props.onClick();await settle();
 frame=ui.render(props(clientA,'task-a'));
 button(frame,'读取').props.onClick();

 frame=ui.render(props(clientB,'task-b',['other-models']));
 assert.doesNotMatch(frame.markup,/正在读取|OWNER_A_PRIVATE_SETTING/,'scope changes synchronously clear loading and approved state');
 assert.ok(nodes(frame.tree).some(node=>node.type==='button'&&node.props.children==='批准并连接 Host'));
 frame.flushEffects();

 read.resolve(snapshot('OWNER_A_PRIVATE_SETTING'));await settle();
 frame=ui.render(props(clientB,'task-b',['other-models']));
 assert.doesNotMatch(frame.markup,/OWNER_A_PRIVATE_SETTING/,'a late success from the previous scope is discarded');
 assert.doesNotMatch(frame.markup,/Host 设置读取失败/,'a late failure from the previous scope is discarded');

 const rejectedRead=deferred(),clientC={approveSettingsRead:async()=>({approved:true,namespaces:['agent-default-model']}),namespaceSettings:async()=>rejectedRead.promise};
 frame=ui.render(props(clientC,'task-c'));frame.flushEffects();
 frame=ui.render(props(clientC,'task-c'));
 button(frame,'批准并连接 Host').props.onClick();await settle();
 frame=ui.render(props(clientC,'task-c'));
 button(frame,'读取').props.onClick();
 frame=ui.render(props(clientB,'task-d',['other-models']));
 frame.flushEffects();
 rejectedRead.reject(new Error('old_scope_read_failed'));await settle();
 frame=ui.render(props(clientB,'task-d',['other-models']));
 assert.doesNotMatch(frame.markup,/old_scope_read_failed|Host 设置读取失败|正在读取/,'a late read failure and finally cannot alter new-scope state');
});

test('a late Host approval failure does not leave an error or loading state in the new scope',async()=>{
 const approval=deferred(),clientA={approveSettingsRead:()=>approval.promise,namespaceSettings:async()=>({})};
 const clientB={approveSettingsRead:async()=>({approved:true,namespaces:['other-models']}),namespaceSettings:async()=>({})};
 const ui=renderer(HostSettingsReadPanel);
 let frame=ui.render(props(clientA,'task-a'));frame.flushEffects();
 button(frame,'批准并连接 Host').props.onClick();
 frame=ui.render(props(clientA,'task-a'));
 assert.match(frame.markup,/等待 DSH owner 批准/);

 frame=ui.render(props(clientB,'task-b',['other-models']));
 assert.doesNotMatch(frame.markup,/等待 DSH owner 批准|Host 设置读取失败/,'the new scope renders clean synchronously');
 frame.flushEffects();
 approval.reject(new Error('old_scope_approval_failed'));await settle();
 frame=ui.render(props(clientB,'task-b',['other-models']));
 assert.doesNotMatch(frame.markup,/Host 设置读取失败/,'a late approval failure cannot leak into the new scope');
 assert.ok(nodes(frame.tree).some(node=>node.type==='button'&&node.props.children==='批准并连接 Host'));
});

test('a previous approval error is cleared synchronously when the owner scope changes',async()=>{
 const clientA={approveSettingsRead:async()=>{throw new Error('HOST_BOOTSTRAP_DENIED');},namespaceSettings:async()=>({})};
 const clientB={approveSettingsRead:async()=>({approved:true,namespaces:['other-models']}),namespaceSettings:async()=>({})};
 const ui=renderer(HostSettingsReadPanel);
 let frame=ui.render(props(clientA,'task-a'));frame.flushEffects();
 button(frame,'批准并连接 Host').props.onClick();await settle();
 frame=ui.render(props(clientA,'task-a'));
 assert.match(frame.markup,/HOST_BOOTSTRAP_DENIED/);

 frame=ui.render(props(clientB,'task-b',['other-models']));
 assert.doesNotMatch(frame.markup,/HOST_BOOTSTRAP_DENIED/,'an old approval error is hidden immediately after the scope changes');
 assert.ok(nodes(frame.tree).some(node=>node.type==='button'&&node.props.children==='批准并连接 Host'));
});

test('disabling and re-enabling Host settings read clears the previous approval',async()=>{
 const client={approveSettingsRead:async()=>({approved:true,namespaces:['agent-default-model']}),namespaceSettings:async()=>({})};
 const ui=renderer(HostSettingsReadPanel);
 let frame=ui.render(props(client,'task-a'));frame.flushEffects();
 button(frame,'批准并连接 Host').props.onClick();await settle();
 frame=ui.render(props(client,'task-a'));
 assert.match(frame.markup,/已批准 1 个 namespace/);

 frame=ui.render(props(client,'task-a',['agent-default-model'],false));
 assert.equal(frame.markup,'');
 frame.flushEffects();
 frame=ui.render(props(client,'task-a'));
 assert.doesNotMatch(frame.markup,/已批准 1 个 namespace/,'approval does not survive the disabled scope');
 assert.ok(nodes(frame.tree).some(node=>node.type==='button'&&node.props.children==='批准并连接 Host'));
});

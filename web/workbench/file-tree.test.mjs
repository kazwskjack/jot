import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFileTree} from './file-tree.mjs';

const file=(path,version=1)=>({path,version,size:12,sha256:'a'.repeat(64)});

test('nested workspace paths form sorted folders and preserve file metadata',()=>{
 const tree=buildFileTree([
  file('src/zeta.ts'),
  file('README.md',2),
  file('src/components/Button.tsx'),
  file('assets/logo.svg'),
 ]);
 assert.deepEqual(tree,[
  {name:'assets',path:'assets',kind:'directory',children:[{name:'logo.svg',path:'assets/logo.svg',kind:'file',file:file('assets/logo.svg')}]},
  {name:'README.md',path:'README.md',kind:'file',file:file('README.md',2)},
  {name:'src',path:'src',kind:'directory',children:[
   {name:'components',path:'src/components',kind:'directory',children:[{name:'Button.tsx',path:'src/components/Button.tsx',kind:'file',file:file('src/components/Button.tsx')}]},
   {name:'zeta.ts',path:'src/zeta.ts',kind:'file',file:file('src/zeta.ts')},
  ]},
 ]);
});

test('tree rejects absolute and traversal paths before displaying host paths',()=>{
 for(const path of ['/etc/passwd','C:/Users/'+'alice/.env','src/../secret.txt','src/.credentials']){
  assert.throws(()=>buildFileTree([file(path)]),/workspace_path_unsafe/);
 }
});

test('tree rejects duplicate paths and file-directory collisions',()=>{
 assert.throws(()=>buildFileTree([file('notes/today.md'),file('notes/today.md')]),/workspace_file_tree_conflict/);
 assert.throws(()=>buildFileTree([file('notes'),file('notes/today.md')]),/workspace_file_tree_conflict/);
 assert.throws(()=>buildFileTree([file('notes/today.md'),file('notes')]),/workspace_file_tree_conflict/);
});

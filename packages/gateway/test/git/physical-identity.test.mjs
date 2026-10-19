import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {GitIndexEffects} from '../../src/git/index-effects.ts';

test('physical Git binding retains distinct 64-bit file identities beyond Number precision',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jot-git-identity-')),a=join(root,'first'),b=join(root,'second');await mkdir(a);await mkdir(b);
 t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const first=100486566687151644n,second=first+1n,native=fs.lstatSync,dev=native(root,{bigint:true}).dev;
 assert.equal(Number(first),Number(second));
 // Model the actual NTFS failure deterministically on every platform. Preserve
 // native type/mode behavior; only the test directories' inode IDs change.
 fs.lstatSync=(path,options)=>{
  const stat=native(path,options),value=String(path)===a?first:String(path)===b?second:null;
  if(value!==null)Object.defineProperty(stat,'ino',{value:options?.bigint?value:Number(value)});return stat;
 };
 syncBuiltinESMExports();
 try{
  const kernel=new GitIndexEffects({root});
  assert.equal(kernel.directorySync(a),dev+':'+first);
  assert.equal(kernel.directorySync(b),dev+':'+second);
 }finally{fs.lstatSync=native;syncBuiltinESMExports();}
});

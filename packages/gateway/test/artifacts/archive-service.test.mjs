import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import {spawnSync} from 'node:child_process'
import { openProductDatabase } from '../../src/db/database.ts'
import { ArtifactArchiveService } from '../../src/artifacts/archive-service.ts'

function fixture() {
  const root = mkdtempSync(fileURLToPath(new URL('./ga-archive-', import.meta.url))); const db = openProductDatabase(join(root, 'db.sqlite'))
  const local = join(root, 'ready', 'uploads', 'artifact-1');
  mkdirSync(join(root, 'ready', 'uploads'), { recursive: true }); writeFileSync(local, 'hello')
  const old = new Date(Date.now() - 25 * 3600_000).toISOString()
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 1, old, old)
  db.prepare("INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('artifact-1', 'conv', 'owner', 'upload', 1, old, old)
  db.prepare("INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('artifact-1', 1, local, createHash('sha256').update('hello').digest('hex'), 5, 'text/plain', JSON.stringify({ file_name: '报告?.txt', status: 'ready' }), old)
  db.prepare("INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run('artifact-1', 'pending', 'present', old, old, old)
  return { root, db, local }
}

async function verifiedFixture(x){
 const remote=new Map();
 const service=new ArtifactArchiveService(x.db,x.root,{
  mkdir:async()=>{},upload:async(path,directory,name)=>remote.set(`${directory}/${name}`,readFileSync(path)),
  meta:async path=>{const bytes=remote.get(path);return bytes?{size:bytes.length,md5:createHash('md5').update(bytes).digest('hex')}:null;},
  download:async(path,destination)=>writeFileSync(destination,remote.get(path)),
 });
 assert.equal((await service.archivePending()).verified,1);return service;
}

test('verified cleanup preserves same-size local bytes changed after the remote check',async()=>{
 const x=fixture();try{
  const service=await verifiedFixture(x);writeFileSync(x.local,'world');
  assert.equal(service.cleanupVerified().deleted,0);
  assert.equal(readFileSync(x.local,'utf8'),'world');
  assert.equal(x.db.prepare('SELECT local_state FROM ga_artifact_archives').get().local_state,'present');
 }finally{x.db.close();rmSync(x.root,{recursive:true,force:true});}
});

test('verified cleanup refuses a manifest path pointing at another local artifact',async()=>{
 const x=fixture();try{
  const service=await verifiedFixture(x),other=join(x.root,'ready','uploads','other-artifact');writeFileSync(other,'hello');
  const manifest=JSON.parse(x.db.prepare('SELECT remote_md5 FROM ga_artifact_archives').get().remote_md5);manifest[0].local_path=other;
  x.db.prepare('UPDATE ga_artifact_archives SET remote_md5=?').run(JSON.stringify(manifest));
  assert.equal(service.cleanupVerified().deleted,0);
  assert.equal(readFileSync(other,'utf8'),'hello');assert.equal(existsSync(x.local),true);
  assert.equal(x.db.prepare('SELECT local_state FROM ga_artifact_archives').get().local_state,'present');
 }finally{x.db.close();rmSync(x.root,{recursive:true,force:true});}
});

test('verified cleanup cannot delete a newer current version using the old remote manifest',async()=>{
 const x=fixture();try{
  const service=await verifiedFixture(x),next=join(x.root,'ready','uploads','artifact-1-v2');writeFileSync(next,'new-version');
  x.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
   .run('artifact-1',2,next,createHash('sha256').update('new-version').digest('hex'),11,'text/plain',JSON.stringify({file_name:'new.txt',status:'ready'}),new Date().toISOString());
  x.db.prepare('UPDATE ga_artifacts SET current_version=2').run();
  assert.equal(service.cleanupVerified().deleted,0);
  assert.equal(readFileSync(next,'utf8'),'new-version');assert.equal(existsSync(x.local),true);
  assert.equal(x.db.prepare('SELECT local_state FROM ga_artifact_archives').get().local_state,'present');
 }finally{x.db.close();rmSync(x.root,{recursive:true,force:true});}
});

for(const changed of [false,true])test(`verified multipart cleanup checks every part before removing any (${changed?'changed final part':'matching bytes'})`,async()=>{
 const x=fixture();try{
  const second=join(x.root,'ready','uploads','part-2');writeFileSync(second,'world');
  for(const [index,path,content] of [[0,x.local,'hello'],[1,second,'world']])x.db.prepare('INSERT INTO ga_artifact_parts VALUES(?,?,?,?,?,?,?,?,?)')
   .run('artifact-1',index,path,'part-'+index+'.txt',createHash('sha256').update(content).digest('hex'),5,'text/plain','{}',new Date().toISOString());
  const service=await verifiedFixture(x);if(changed)writeFileSync(second,'other');
  assert.equal(service.cleanupVerified().deleted,changed?0:1);
  assert.equal(existsSync(x.local),changed);assert.equal(existsSync(second),changed);
  if(changed){assert.equal(readFileSync(x.local,'utf8'),'hello');assert.equal(readFileSync(second,'utf8'),'other');}
 }finally{x.db.close();rmSync(x.root,{recursive:true,force:true});}
});

test('verified cleanup content hashing does not hold SQLite writer admission for unrelated work',async()=>{
 const x=fixture(),original=fs.readSync;let checked=false;
 try{
  const service=await verifiedFixture(x),inode=fs.statSync(x.local).ino;
  fs.readSync=function(fd,...args){
   if(!checked&&fs.fstatSync(fd).ino===inode){
    checked=true;
    const child=spawnSync(process.execPath,['--input-type=module','-e',
     "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=75');db.prepare('UPDATE ga_conversations SET title=? WHERE id=?').run('Unrelated writer completed','conv');db.close();console.log('committed');",join(x.root,'db.sqlite')],{encoding:'utf8',windowsHide:true});
    assert.equal(child.status,0,'an independent writer must commit while content hashing is paused');
    assert.equal(child.stdout.trim(),'committed');
   }
   return original.call(this,fd,...args);
  };syncBuiltinESMExports();
  assert.equal(service.cleanupVerified().deleted,1);assert.equal(checked,true);
  assert.equal(x.db.prepare('SELECT title FROM ga_conversations').get().title,'Unrelated writer completed');
 }finally{fs.readSync=original;syncBuiltinESMExports();x.db.close();rmSync(x.root,{recursive:true,force:true});}
});

for(const change of ['reference','lease'])test(`verified cleanup rechecks a ${change} changed during content validation before deleting`,async()=>{
 const x=fixture(),original=fs.readSync;let changed=false;
 try{
  const service=await verifiedFixture(x),inode=fs.statSync(x.local).ino;
  fs.readSync=function(fd,...args){
   if(!changed&&fs.fstatSync(fd).ino===inode){
    changed=true;
    if(change==='reference')x.db.prepare('UPDATE ga_artifact_versions SET sha256=?').run('0'.repeat(64));
    else x.db.prepare('INSERT INTO ga_artifact_leases(artifact_id,lease_id,expires_at,created_at) VALUES(?,?,?,?)')
     .run('artifact-1','new-reader',new Date(Date.now()+3600000).toISOString(),new Date().toISOString());
   }
   return original.call(this,fd,...args);
  };syncBuiltinESMExports();
  assert.equal(service.cleanupVerified().deleted,0);assert.equal(changed,true);assert.equal(readFileSync(x.local,'utf8'),'hello');
  assert.equal(x.db.prepare('SELECT local_state FROM ga_artifact_archives').get().local_state,'present');
 }finally{fs.readSync=original;syncBuiltinESMExports();x.db.close();rmSync(x.root,{recursive:true,force:true});}
});

test('archive verifies exact remote size and md5 before marking an artifact verified', async () => {
  const x = fixture(); const remote = new Map()
  try {
    const client = {
      mkdir: async () => {},
      upload: async (path, directory, name) => remote.set(`${directory}/${name}`, Buffer.from(readFileSync(path))),
      meta: async path => { const data = remote.get(path); return data ? { size: data.length, md5: '5d41402abc4b2a76b9719d911017c592' } : null },
      download: async () => { throw new Error('unused') },
    }
    const service = new ArtifactArchiveService(x.db, x.root, client)
    assert.equal((await service.archivePending(new Date())).verified, 1)
    const row = x.db.prepare('SELECT * FROM ga_artifact_archives WHERE artifact_id=?').get('artifact-1')
    assert.equal(row.backup_status, 'verified'); assert.match(row.remote_path, /^\/jot_file\//)
  } finally { x.db.close(); rmSync(x.root, { recursive: true, force: true }) }
})

test('cleanup deletes only verified files older than 24 hours without an active lease', async () => {
  const x = fixture()
  try {
    const service = await verifiedFixture(x)
    assert.equal(service.cleanupVerified(new Date(), 24).deleted, 1); assert.equal(existsSync(x.local), false)
    assert.equal(x.db.prepare("SELECT local_state FROM ga_artifact_archives WHERE artifact_id='artifact-1'").get().local_state, 'deleted')
  } finally { x.db.close(); rmSync(x.root, { recursive: true, force: true }) }
})

test('verified cleanup preserves incomplete legacy manifests instead of treating a path alone as backup proof',()=>{
 const x=fixture();try{
  x.db.prepare("UPDATE ga_artifact_archives SET backup_status='verified',remote_md5=?").run(JSON.stringify([{local_path:x.local}]));
  const service=new ArtifactArchiveService(x.db,x.root,{mkdir:async()=>{},upload:async()=>{},meta:async()=>null,download:async()=>{}});
  assert.equal(service.cleanupVerified().deleted,0);assert.equal(existsSync(x.local),true);
 }finally{x.db.close();rmSync(x.root,{recursive:true,force:true});}
});

test('cleanup preserves files with an active task lease', async () => {
  const x = fixture()
  try {
    x.db.prepare("UPDATE ga_artifact_archives SET backup_status='verified',remote_path='/jot_file/x',remote_md5=?,verified_at=? WHERE artifact_id='artifact-1'").run(JSON.stringify([{ local_path: x.local }]), new Date().toISOString())
    x.db.prepare('INSERT INTO ga_artifact_leases(artifact_id,lease_id,expires_at,created_at) VALUES(?,?,?,?)')
      .run('artifact-1', 'run', new Date(Date.now()+3600_000).toISOString(), new Date().toISOString())
    const service = new ArtifactArchiveService(x.db, x.root, { mkdir: async()=>{}, upload: async()=>{}, meta: async()=>null, download: async()=>{} })
    assert.equal(service.cleanupVerified(new Date(), 24).deleted, 0); assert.equal(existsSync(x.local), true)
  } finally { x.db.close(); rmSync(x.root, { recursive: true, force: true }) }
})

test('existing remote bytes are verified by isolated download when provider md5 differs without uploading again', async () => {
  const x = fixture(); let uploads = 0; let downloads = 0; let downloadedPath;
  try {
    const client = {
      mkdir: async () => {}, upload: async () => { uploads += 1 },
      meta: async () => ({ size: 5, md5: '00000000000000000000000000000000' }),
      download: async (remote, local) => { downloads += 1; downloadedPath = local; writeFileSync(local, 'hello') },
    }
    assert.deepEqual(await new ArtifactArchiveService(x.db, x.root, client).archivePending(), { attempted: 1, verified: 1, failed: 0 });
    assert.equal(uploads, 0); assert.equal(downloads, 1);
    assert.notEqual(downloadedPath, x.local); assert.equal(existsSync(downloadedPath), false);
    assert.equal(readFileSync(x.local, 'utf8'), 'hello');
    const row = x.db.prepare('SELECT * FROM ga_artifact_archives').get();
    assert.equal(row.backup_status, 'verified');
    assert.equal(JSON.parse(row.remote_md5)[0].md5, '5d41402abc4b2a76b9719d911017c592');
  } finally { x.db.close(); rmSync(x.root, { recursive: true, force: true }) }
})

for (const failure of ['same-size-corruption', 'wrong-size', 'download-error']) {
  test(`provider md5 mismatch with ${failure} preserves local file and never marks verified`, async () => {
    const x = fixture(); let downloadedPath;
    try {
      const client = {
        mkdir: async () => {}, upload: async () => {},
        meta: async () => ({ size: 5, md5: '00000000000000000000000000000000' }),
        download: async (remote, local) => {
          downloadedPath = local;
          writeFileSync(local, failure === 'wrong-size' ? 'bad' : 'wrong');
          if (failure === 'download-error') throw new Error('baidu_download_failed');
        },
      }
      assert.deepEqual(await new ArtifactArchiveService(x.db, x.root, client).archivePending(), { attempted: 1, verified: 0, failed: 1 });
      assert.equal(typeof downloadedPath, 'string');
      assert.equal(existsSync(downloadedPath), false);
      assert.equal(readFileSync(x.local, 'utf8'), 'hello');
      const row = x.db.prepare('SELECT * FROM ga_artifact_archives').get();
      assert.equal(row.backup_status, 'retry'); assert.equal(row.local_state, 'present');
      assert.equal(row.verified_at, null); assert.equal(row.remote_md5, null);
    } finally { x.db.close(); rmSync(x.root, { recursive: true, force: true }) }
  })
}

test('new upload with inaccurate provider md5 requires downloaded bytes to match', async () => {
  const x = fixture(); let uploads = 0; let downloads = 0;
  try {
    const client = {
      mkdir: async () => {}, upload: async () => { uploads += 1 },
      meta: async () => uploads ? { size: 5, md5: '00000000000000000000000000000000' } : null,
      download: async (remote, local) => { downloads += 1; writeFileSync(local, 'hello') },
    }
    assert.equal((await new ArtifactArchiveService(x.db, x.root, client).archivePending()).verified, 1);
    assert.equal(uploads, 1); assert.equal(downloads, 1);
  } finally { x.db.close(); rmSync(x.root, { recursive: true, force: true }) }
})

test('matching existing remote checksum avoids both reupload and verification download', async () => {
  const x = fixture(); let transfers = 0;
  try {
    const client = {
      mkdir: async () => {}, upload: async () => { transfers += 1 },
      meta: async () => ({ size: 5, md5: '5D41402ABC4B2A76B9719D911017C592' }),
      download: async () => { transfers += 1 },
    }
    assert.equal((await new ArtifactArchiveService(x.db, x.root, client).archivePending()).verified, 1);
    assert.equal(transfers, 0);
  } finally { x.db.close(); rmSync(x.root, { recursive: true, force: true }) }
})

for (const remote of [null, { size: 4, md5: '5d41402abc4b2a76b9719d911017c592' }]) {
  test(`missing or wrong-sized remote metadata after upload cannot be verified (${remote === null ? 'missing' : 'size'})`, async () => {
    const x = fixture(); let downloads = 0;
    try {
      const client = { mkdir: async () => {}, upload: async () => {}, meta: async () => remote,
        download: async () => { downloads += 1 } };
      const result = await new ArtifactArchiveService(x.db, x.root, client).archivePending();
      assert.equal(result.verified, 0); assert.equal(result.failed, 1); assert.equal(downloads, 0);
      assert.equal(x.db.prepare('SELECT backup_status FROM ga_artifact_archives').get().backup_status, 'retry');
    } finally { x.db.close(); rmSync(x.root, { recursive: true, force: true }) }
  })
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const invalid = () => Error('文件操作原请求记录无法读取');
const changed = () => Error('原请求记录已变化，请重读文件操作回执');
const unavailable = () => Error('文件操作持久存储不可用，请重读原请求');
const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
 && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function memoryStorage() {
 const values = new Map();
 return {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); },
  removeItem: key => { values.delete(key); },
 };
}

// Per-command tombstones prevent legacy tabs from resurrecting acknowledged work.
export class DurableFileRecoveryStore {
 static async open(factory, namespace, createStore, legacyStorage) {
  if (!factory || typeof namespace !== 'string' || !namespace || namespace.length > 1024) throw unavailable();
  const sync = createStore(memoryStorage());
  const db = await new Promise((resolve, reject) => {
   let abandoned = false;
   const request = factory.open('jot-file-command-receipts-v1', 1);
   request.onupgradeneeded = () => {
    const records = request.result.createObjectStore('commands');
    records.createIndex('pending', ['namespace', 'status']);
   };
   request.onsuccess = () => { if (abandoned) request.result.close(); else resolve(request.result); };
   request.onerror = request.onblocked = () => { abandoned = true; reject(unavailable()); };
  });
  const store = new DurableFileRecoveryStore(db, namespace, sync);
  db.onversionchange = () => store.close();
  try {
   const legacy = createStore(legacyStorage);
   const original = typeof legacy.readRecord === 'function' ? legacy.readRecord() : legacy.read();
   if (legacy.issue) throw invalid();
   if (original?.command) {
    await store.migrate(original.command, original.closing === true);
    // The strict journal commit precedes removal of the matching old hint.
    try { legacy.complete(original.command); } catch { /* Its tombstone fences later migration. */ }
   }
   const first = await store.firstPending();
   if (first) {
    sync.saveCommand(first.command);
    if (first.closing) sync.requestClose();
   }
   return store;
  } catch (error) { store.close(); throw error; }
 }
 constructor(db, namespace, sync) {
  this.db = db;
  this.namespace = namespace;
  this.sync = sync;
  this.revisions = new Map();
 }
 close() { this.db.close(); }
 get closing() { return this.sync.closing === true; }
 get issue() { return this.sync.issue ?? ''; }
 read() { return this.sync.read(); }
 saveCommand(...args) { return this.sync.saveCommand(...args); }
 complete(...args) { return this.sync.complete(...args); }
 requestClose() { return this.sync.requestClose(); }
 validate(command) { return this.sync.validate(command); }

 transaction(mode, operation) {
  return new Promise((resolve, reject) => {
   let tx, result, failure;
   try {
    tx = this.db.transaction('commands', mode, mode === 'readwrite' ? {durability: 'strict'} : {});
    if (mode === 'readwrite' && tx.durability !== 'strict') { tx.abort(); reject(unavailable()); return; }
   } catch { reject(unavailable()); return; }
   const fail = error => { failure = error; try { tx.abort(); } catch {} };
   tx.oncomplete = () => resolve(result);
   tx.onerror = () => {};
   tx.onabort = () => reject(failure ?? unavailable());
   try { operation(tx.objectStore('commands'), value => { result = value; }, fail); }
   catch (error) { fail(error); }
  });
 }
 record(value, key) {
  if (!exact(value, ['version', 'namespace', 'command', 'closing', 'revision', 'status'])
   || value.version !== 1 || value.namespace !== this.namespace
   || typeof value.closing !== 'boolean' || value.closing && typeof this.sync.requestClose !== 'function'
   || !Number.isSafeInteger(value.revision) || value.revision < 1
   || !['pending', 'acknowledged'].includes(value.status)) throw invalid();
  this.validate(value.command);
  if (!same(key, [this.namespace, value.command.key])) throw invalid();
  return value;
 }
 async firstPending() {
  const value = await this.transaction('readonly', (records, done, fail) => {
   const cursor = records.index('pending').openCursor(IDBKeyRange.only([this.namespace, 'pending']));
   cursor.onsuccess = () => {
    try { const row = cursor.result; done(row ? structuredClone(this.record(row.value, row.primaryKey)) : null); }
    catch (error) { fail(error); }
   };
  });
  if (value) this.revisions.set(value.command.key, value.revision);
  return value;
 }
 async migrate(command, closing) {
  this.validate(command);
  if (closing && typeof this.sync.requestClose !== 'function') throw invalid();
  const key = [this.namespace, command.key];
  await this.transaction('readwrite', (records, done, fail) => {
   const read = records.get(key);
   read.onsuccess = () => {
    try {
     const prior = read.result && this.record(read.result, key);
     if (prior && !same(prior.command, command)) throw invalid();
     if (prior && (prior.status === 'acknowledged' || prior.closing || !closing)) { done(prior); return; }
     const revision = (prior?.revision ?? 0) + 1;
     if (!Number.isSafeInteger(revision)) throw invalid();
     const value = {version: 1, namespace: this.namespace, command: structuredClone(command), closing, revision, status: 'pending'};
     records.put(value, key); done(value);
    } catch (error) { fail(error); }
   };
  });
 }
 async persist(command) {
  this.validate(command);
  const local = typeof this.sync.readRecord === 'function' ? this.sync.readRecord() : this.sync.read();
  if (!same(local?.command, command) || this.issue) throw changed();
  const closing = local.closing === true, key = [this.namespace, command.key];
  const value = await this.transaction('readwrite', (records, done, fail) => {
   const read = records.get(key);
   read.onsuccess = () => {
    try {
     const prior = read.result && this.record(read.result, key), expected = this.revisions.get(command.key);
     if (prior?.revision !== expected
      || prior && (!same(prior.command, command) || prior.status !== 'pending' || prior.closing && !closing)) throw changed();
     const revision = (prior?.revision ?? 0) + 1;
     if (!Number.isSafeInteger(revision)) throw invalid();
     const next = {version: 1, namespace: this.namespace, command: structuredClone(command), closing, revision, status: 'pending'};
     if (prior) { records.put(next, key); done(next); return; }
     // Imported pending requests remain queued before a new command is admitted.
     const pending = records.index('pending').openCursor(IDBKeyRange.only([this.namespace, 'pending']));
     pending.onsuccess = () => {
      try {
       if (pending.result) throw changed();
       records.put(next, key); done(next);
      } catch (error) { fail(error); }
     };
    } catch (error) { fail(error); }
   };
  });
  this.revisions.set(command.key, value.revision);
 }
 async acknowledge(command) {
  this.validate(command);
  const key = [this.namespace, command.key], expected = this.revisions.get(command.key);
  const value = await this.transaction('readwrite', (records, done, fail) => {
   const read = records.get(key);
   read.onsuccess = () => {
    try {
     const prior = this.record(read.result, key);
     if (!same(prior.command, command) || prior.status !== 'pending' || prior.revision !== expected) throw changed();
     const revision = prior.revision + 1;
     if (!Number.isSafeInteger(revision)) throw invalid();
     const next = {...prior, revision, status: 'acknowledged'};
     records.put(next, key); done(next);
    } catch (error) { fail(error); }
   };
  });
  this.revisions.set(command.key, value.revision);
 }
}

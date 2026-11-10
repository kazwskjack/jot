import {createHash} from 'node:crypto';
import {closeSync, lstatSync, mkdirSync, openSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_SOURCES = 128;
const PAGE_CHARS = 16384;
const SHA = /^[a-f0-9]{64}$/;
const APPLICATION_ID = 1246973779;
const hash = value => createHash('sha256').update(value).digest('hex');

/** Private producer snapshots. Public paths and opaque spill locators never select storage. */
export function createNativeSearchSourceStore({readIdentity}) {
  let connection, disposed = false;

  function check(identity) {
    if (disposed || !isDeepStrictEqual(readIdentity(), identity)) throw Error('native_search_source_changed');
    if (connection) {
      const info = lstatSync(connection.path);
      if (!isDeepStrictEqual(connection.identity, identity) || !info.isFile() || info.isSymbolicLink()
        || info.ino !== connection.ino || info.dev !== connection.dev
        || realpathSync(connection.path) !== connection.path) throw Error('native_search_source_changed');
    }
  }

  async function database(identity, create) {
    check(identity);
    if (connection) return connection.db;
    const {DatabaseSync} = await import('node:sqlite');
    check(identity);
    if (connection) return connection.db;
    const directory = join(identity.profileDirectory, '.jot-native-search-sources');
    if (create) {
      try { mkdirSync(directory, {mode: 0o700}); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    let directoryInfo;
    try { directoryInfo = lstatSync(directory); }
    catch (error) { if (error?.code === 'ENOENT') throw Error('native_search_source_not_found'); throw error; }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || realpathSync(directory) !== directory)
      throw Error('native_search_source_changed');
    const path = join(directory, 'sources.sqlite');
    if (create) {
      try { closeSync(openSync(path, 'wx', 0o600)); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    let info;
    try { info = lstatSync(path); }
    catch (error) { if (error?.code === 'ENOENT') throw Error('native_search_source_not_found'); throw error; }
    if (!info.isFile() || info.isSymbolicLink() || realpathSync(path) !== path) throw Error('native_search_source_changed');
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=75;');
      const application = db.prepare('PRAGMA application_id').get().application_id;
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (create && application === 0 && version === 0) {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get())
            throw Error('native_search_source_store_invalid');
          db.exec(`CREATE TABLE native_search_sources (
            source_key TEXT PRIMARY KEY CHECK(length(source_key)=64),
            metadata_json TEXT NOT NULL CHECK(length(CAST(metadata_json AS BLOB))<=65536),
            sha256 TEXT NOT NULL CHECK(length(sha256)=64),
            bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND ${MAX_SOURCE_BYTES})
          ) STRICT;
          CREATE TABLE native_search_source_chunks (
            source_key TEXT NOT NULL REFERENCES native_search_sources(source_key),
            chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),
            content BLOB NOT NULL CHECK(length(content) BETWEEN 1 AND 65536),
            PRIMARY KEY(source_key,chunk_index)
          ) STRICT;
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);
        } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
      } else if (application !== APPLICATION_ID || version !== 1) throw Error('native_search_source_store_invalid');
      connection = {db, path, ino: info.ino, dev: info.dev, identity};
      check(identity);
      return db;
    } catch (error) {
      if (connection?.db === db) connection = undefined;
      db.close();
      throw error;
    }
  }

  function metadata(db, key) {
    const row = db.prepare(`SELECT
      CASE WHEN length(CAST(metadata_json AS BLOB))<=65536 THEN metadata_json END AS metadata_json,
      CASE WHEN length(sha256)=64 THEN sha256 END AS sha256, bytes,
      (SELECT coalesce(sum(length(content)),0) FROM native_search_source_chunks
       WHERE source_key=s.source_key) AS actual_bytes
      FROM native_search_sources s WHERE source_key=?`).get(key);
    if (!row) throw Error('native_search_source_not_found');
    if (typeof row.metadata_json !== 'string' || Buffer.byteLength(row.metadata_json) > 65536
      || !SHA.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0
      || row.bytes > MAX_SOURCE_BYTES || row.actual_bytes !== row.bytes) throw Error('native_search_source_store_invalid');
    const value = JSON.parse(row.metadata_json);
    if (value.sha256 !== row.sha256 || value.bytes !== row.bytes
      || !Number.isSafeInteger(value.chars) || value.chars < 0 || value.chars > row.bytes)
      throw Error('native_search_source_store_invalid');
    return value;
  }

  return Object.freeze({
    async save(identity, key, value, content) {
      if (!SHA.test(key) || typeof content !== 'string' || Buffer.byteLength(content) > MAX_SOURCE_BYTES)
        throw Error('native_search_source_capacity');
      const bytes = Buffer.from(content, 'utf8');
      if (value.bytes !== bytes.length || value.chars !== content.length || value.sha256 !== hash(bytes))
        throw Error('native_search_source_store_invalid');
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) > 65536) throw Error('native_search_source_store_invalid');
      const db = await database(identity, true);
      check(identity);
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = db.prepare(`SELECT
          CASE WHEN length(CAST(metadata_json AS BLOB))<=65536 THEN metadata_json END AS metadata_json
          FROM native_search_sources WHERE source_key=?`).get(key);
        if (previous) {
          if (previous.metadata_json !== encoded) throw Error('native_search_source_conflict');
        } else {
          const total = db.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM native_search_sources').get();
          if (total.count >= MAX_SOURCES || total.bytes + bytes.length > MAX_TOTAL_BYTES)
            throw Error('native_search_source_capacity');
          db.prepare('INSERT INTO native_search_sources VALUES(?,?,?,?)').run(key, encoded, value.sha256, bytes.length);
          const insert = db.prepare('INSERT INTO native_search_source_chunks VALUES(?,?,?)');
          for (let offset = 0; offset < bytes.length; offset += 65536)
            insert.run(key, offset / 65536, bytes.subarray(offset, offset + 65536));
        }
        check(identity);
        db.exec('COMMIT');
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    },
    async inspect(identity, key) {
      if (!SHA.test(key)) throw Error('native_search_source_invalid');
      const db = await database(identity, false);
      check(identity);
      const result = metadata(db, key);
      check(identity);
      return result;
    },
    async read(identity, key, expected, offset) {
      if (!SHA.test(key) || !Number.isSafeInteger(offset) || offset < 0 || offset > expected.chars)
        throw Error('native_search_source_offset_invalid');
      const db = await database(identity, false);
      check(identity);
      db.exec('BEGIN');
      try {
        const value = metadata(db, key);
        if (!isDeepStrictEqual(value, expected)) throw Error('native_search_source_changed');
        const digest = createHash('sha256'), decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
        let position = 0, text = '', complete = false;
        const accept = part => {
          if (!complete && position + part.length > offset) {
            const start = Math.max(0, offset - position);
            if (start > 0 && /[\uDC00-\uDFFF]/.test(part[start])) throw Error('native_search_source_offset_invalid');
            let end = Math.min(part.length, start + PAGE_CHARS - text.length);
            if (end < part.length && /[\uD800-\uDBFF]/.test(part[end - 1])) { end--; complete = true; }
            text += part.slice(start, end);
            if (text.length === PAGE_CHARS) complete = true;
          }
          position += part.length;
        };
        const chunk = db.prepare('SELECT content AS data FROM native_search_source_chunks WHERE source_key=? AND chunk_index=?');
        for (let offsetBytes = 0; offsetBytes < value.bytes; offsetBytes += 65536) {
          const data = chunk.get(key, offsetBytes / 65536)?.data;
          if (!(data instanceof Uint8Array) || data.length !== Math.min(65536, value.bytes - offsetBytes))
            throw Error('native_search_source_store_invalid');
          digest.update(data);
          accept(decoder.decode(data, {stream: true}));
        }
        accept(decoder.decode());
        if (digest.digest('hex') !== value.sha256 || position !== value.chars) throw Error('native_search_source_store_invalid');
        check(identity);
        db.exec('COMMIT');
        return {text, offset_chars: offset, total_chars: position,
          ...(offset + text.length < position ? {next_offset_chars: offset + text.length} : {})};
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    },
    dispose() { disposed = true; connection?.db.close(); connection = undefined; },
  });
}

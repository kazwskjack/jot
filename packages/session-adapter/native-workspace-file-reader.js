import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {sessionHeaderIdentity} from './session-header-identity.js';
import {validateNativeFileRangeRequest,validateNativeFileRange,validateNativeFileStat} from '../gateway/src/harness/native-file-range.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const hash = value => createHash('sha256').update(value).digest('hex');

/** Borrow the native owner-facing workspaceFiles API and its original read policy. */
export function createNativeWorkspaceFileReader({readIdentity,readState,createPeer}) {
  const entries = new Set(), lifetime = new AbortController();
  let disposed = false;
  async function close(entry) {
    if (!entry.closing) entry.closing = Promise.resolve().then(async()=>{
      await entry.peer?.dispose();
    });
    return entry.closing;
  }
  return Object.freeze({
    async read(ownerId,sessionId,value,signal) {
      const input = validateNativeFileRangeRequest(value);
      const active = AbortSignal.any([signal,lifetime.signal]);
      active.throwIfAborted();
      if (disposed) throw Error('native_file_range_unavailable');
      const identity = readIdentity();
      if (identity.ownerId !== ownerId) throw Error('native_file_range_forbidden');
      if (typeof sessionId !== 'string' || !ID.test(sessionId)) throw Error('native_file_range_invalid');
      if (entries.size >= 4) throw Error('native_file_range_capacity');
      const state = readState(), session = state.sessions?.get(sessionId);
      if (!state.files || !state.filesystem || typeof state.gateway?.invoke !== 'function'
        || typeof state.persistence?.stat !== 'function' || typeof createPeer !== 'function')
        throw Error('native_file_range_unavailable');
      const check = () => {
        active.throwIfAborted();
        const current = readState();
        if (disposed || !isDeepStrictEqual(readIdentity(),identity)
          || ['gateway','files','filesystem','sessions','persistence'].some(key=>current[key]!==state[key])
          || state.sessions.get(sessionId)!==session) throw Error('native_file_range_changed');
      };
      const header = async() => {
        check();
        const value = session?.header ?? (await state.persistence.stat(sessionId,{signal:active}))?.header;
        check();
        if (value?.id !== sessionId || session && session.id !== sessionId) throw Error('native_file_range_session_not_found');
        return sessionHeaderIdentity(value);
      };
      const entry = {peer:undefined,closing:undefined};
      entries.add(entry);
      let originalHeader, response, closed = false;
      try {
        try {
          originalHeader = await header();
          check();
          const sessionSha = hash(JSON.stringify([identity.ownerId,identity.profileId,originalHeader]));
          if (input.session_sha256 !== undefined && input.session_sha256 !== sessionSha) throw Error('native_file_range_changed');
          entry.peer = createPeer();
          const invoke = async(method,args) => {
            check();
            const result = await state.gateway.invoke({namespace:'workspaceFiles',method,
              args:{workspaceFileScopeId:sessionId,path:input.path,...args},peer:entry.peer,signal:active});
            check();
            return result;
          };
          const before = validateNativeFileStat(await invoke('stat',{}));
          if (input.version !== undefined && (before.version !== input.version || before.absolutePath !== input.absolute_path
            || (before.bytes??null) !== input.file_size_bytes))
            throw Error('native_file_range_changed');
          const result = await invoke('readBytes',{options:{range:{offset:input.offset_bytes,length:input.length_bytes}}});
          if (!result || typeof result !== 'object' || Array.isArray(result) || !(result.data instanceof Uint8Array)
            || result.data.length > input.length_bytes || result.offset !== input.offset_bytes || typeof result.eof !== 'boolean'
            || Object.keys(result).sort().join(',') !== ['absolutePath','version','offset','data','eof',
              ...(result.bytes!==undefined?['bytes']:[])].sort().join(',')) throw Error('native_file_range_source_invalid');
          const data = Buffer.from(result.data), eof = result.eof;
          const observed = validateNativeFileStat({absolutePath:result.absolutePath,version:result.version,
            ...(result.bytes!==undefined?{bytes:result.bytes}:{})});
          const after = validateNativeFileStat(await invoke('stat',{}));
          if (!isDeepStrictEqual(before,observed) || !isDeepStrictEqual(before,after) || await header() !== originalHeader)
            throw Error('native_file_range_changed');
          response = validateNativeFileRange({protocol:1,session_id:sessionId,profile_id:identity.profileId,
            session_sha256:sessionSha,absolute_path:before.absolutePath,version:before.version,file_size_bytes:before.bytes??null,
            offset_bytes:input.offset_bytes,data_base64:data.toString('base64'),chunk_sha256:hash(data),eof,
            execution_authorized:false},sessionId,input);
          check();
        } finally { await close(entry); closed = true; }
        if (await header() !== originalHeader) throw Error('native_file_range_changed');
        check();
        return response;
      } finally {
        if (closed) entries.delete(entry);
      }
    },
    async dispose() {
      disposed = true;
      lifetime.abort();
      const results = await Promise.allSettled([...entries].map(close));
      if (results.some(result=>result.status==='rejected')) throw Error('native_file_range_cleanup_failed');
    },
  });
}

import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createNativeSearchSourceStore} from './native-search-source-store.js';
import {sessionHeaderIdentity} from './session-header-identity.js';
import {publicNativeFileSearch, publicNativeToolResult, sessionToolCallId} from './native-tool-result.js';
import {updateNativeChildLogHash} from './native-child-closure.js';

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const callId = value => typeof value === 'string' && value.length > 0 && value.length <= 8192;
const hash = value => createHash('sha256').update(value).digest('hex');
const eventHash = value => updateNativeChildLogHash(createHash('sha256'), value).digest('hex');
const sourceKey = (identity, sessionId, seq) => hash(JSON.stringify([identity.ownerId, identity.profileId, sessionId, seq]));

/** Capture at the reviewed native producer and authorize reads from the final native result. */
export function createNativeSearchSource({readIdentity, agents, sessions, persistence}) {
  const store = createNativeSearchSourceStore({readIdentity});
  const lifetime = new AbortController();
  let disposed = false, captures = 0, reads = 0;
  function check(identity, signal) {
    signal?.throwIfAborted();
    if (disposed || !isDeepStrictEqual(readIdentity(), identity)) throw Error('native_search_source_changed');
  }

  async function captureSource(exec, save, saved) {
    if (disposed || exec?.parent !== undefined || !['glob', 'grep'].includes(exec?.name))
      throw Error('native_search_source_invalid');
    const signal = exec.signal, identity = readIdentity(), agent = exec.agent, session = agent?.session;
    const sessionId = session?.id;
    check(identity, signal);
    if (!ID.test(sessionId ?? '') || agent.id !== sessionId || agents.get(sessionId) !== agent
      || sessions.get(sessionId) !== session || session.header?.id !== sessionId
      || !callId(exec.callId) || save?.owner?.sessionId !== sessionId
      || save.source?.kind !== 'tool' || save.source.toolName !== exec.name || save.source.callId !== exec.callId
      || save.source.label !== 'result' || save.suggestedName !== `${exec.name}-results.txt`
      || typeof save.content !== 'string' || Buffer.byteLength(save.content) > 32 * 1024 * 1024
      || saved?.bytes !== Buffer.byteLength(save.content) || typeof saved.locator !== 'string'
      || !saved.locator || saved.locator.length > 32768 || typeof saved.retrievalHint !== 'string'
      || saved.retrievalHint.length > 16384) throw Error('native_search_source_invalid');
    let call;
    for (let seq = session.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(seq);
      if (event?.seq !== seq) throw Error('native_search_source_changed');
      if (['tool/call', 'tool/result'].includes(event.type) && sessionToolCallId(event.data) === exec.callId) {
        if (event.type !== 'tool/call' || event.data.name !== exec.name) throw Error('native_search_source_changed');
        call = event;
        break;
      }
    }
    if (!call) throw Error('native_search_source_changed');
    const metadata = {protocol: 1, owner_id: identity.ownerId, profile_id: identity.profileId,
      session_id: sessionId, session_header_sha256: hash(sessionHeaderIdentity(session.header)),
      call_id: exec.callId, call_seq: call.seq, call_sha256: eventHash(call), tool_name: exec.name,
      locator: saved.locator, retrieval_hint: saved.retrievalHint,
      bytes: saved.bytes, chars: save.content.length, sha256: hash(save.content),
      scope: exec.name === 'grep' ? 'all_entries_with_native_line_previews' : 'all_paths'};
    await store.save(identity, sourceKey(identity, sessionId, call.seq), metadata, save.content);
    check(identity, signal);
    if (agents.get(sessionId) !== agent || sessions.get(sessionId) !== session || agent.session !== session
      || eventHash(session.eventAt(call.seq)) !== metadata.call_sha256) throw Error('native_search_source_changed');
  }

  async function readSource(ownerId, sessionId, input, signal, search = false) {
    const identity = readIdentity();
    check(identity, signal);
    if (identity.ownerId !== ownerId) throw Error('native_search_source_forbidden');
    const allowed = search ? ['call_seq', 'tool_name', 'q', 'source_sha256'] : ['call_seq', 'tool_name', 'offset_chars', 'source_sha256'];
    if (!ID.test(sessionId) || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !allowed.includes(key))
      || !Number.isSafeInteger(input.call_seq) || input.call_seq < 0 || !['glob', 'grep'].includes(input.tool_name)
      || (search ? typeof input.q !== 'string' || !input.q || input.q !== input.q.trim() || input.q.length > 200
        : !Number.isSafeInteger(input.offset_chars) || input.offset_chars < 0)
      || input.source_sha256 !== undefined && (typeof input.source_sha256 !== 'string' || !SHA.test(input.source_sha256))
      || !search && input.offset_chars > 0 && input.source_sha256 === undefined) throw Error('native_search_source_invalid');
    const key = sourceKey(identity, sessionId, input.call_seq);
    const metadata = await store.inspect(identity, key);
    check(identity, signal);
    if (metadata.protocol !== 1 || metadata.owner_id !== ownerId || metadata.profile_id !== identity.profileId
      || metadata.session_id !== sessionId || metadata.call_seq !== input.call_seq || metadata.tool_name !== input.tool_name
      || !callId(metadata.call_id) || !SHA.test(metadata.call_sha256) || !SHA.test(metadata.session_header_sha256)
      || typeof metadata.locator !== 'string' || !metadata.locator || typeof metadata.retrieval_hint !== 'string'
      || metadata.scope !== (input.tool_name === 'grep' ? 'all_entries_with_native_line_previews' : 'all_paths'))
      throw Error('native_search_source_invalid');
    if (input.source_sha256 !== undefined && input.source_sha256 !== metadata.sha256) throw Error('native_search_source_changed');
    const agent = agents.get(sessionId), session = sessions.get(sessionId);
    let handle, backend;
    try {
      if (agent || session) {
        if (!agent || agent.id !== sessionId || agent.session !== session || session?.id !== sessionId)
          throw Error('native_search_source_changed');
      } else {
        backend = persistence();
        handle = await backend.open(sessionId, 'read', {signal});
        check(identity, signal);
        if (handle.id !== sessionId || handle.access !== 'read') throw Error('native_search_source_changed');
      }
      const header = session?.header ?? handle.header;
      if (hash(sessionHeaderIdentity(header)) !== metadata.session_header_sha256) throw Error('native_search_source_changed');
      const eventAt = async seq => {
        check(identity, signal);
        if (session) {
          if (agents.get(sessionId) !== agent || sessions.get(sessionId) !== session || agent.session !== session)
            throw Error('native_search_source_changed');
          return session.eventAt(seq);
        }
        if (persistence() !== backend) throw Error('native_search_source_changed');
        const result = await handle.read(seq, 1, {signal});
        check(identity, signal);
        if (persistence() !== backend) throw Error('native_search_source_changed');
        if (!Array.isArray(result?.events) || result.events.length > 1) throw Error('native_search_source_changed');
        return result.events[0];
      };
      const call = await eventAt(metadata.call_seq);
      if (!call || call.seq !== metadata.call_seq || call.type !== 'tool/call' || call.data?.name !== metadata.tool_name
        || sessionToolCallId(call.data) !== metadata.call_id || eventHash(call) !== metadata.call_sha256)
        throw Error('native_search_source_changed');
      let result;
      const sourceEnd = session?.seq;
      for (let seq = call.seq + 1; sourceEnd === undefined || seq < sourceEnd; seq++) {
        const event = await eventAt(seq);
        if (!event) break;
        if (event.seq !== seq) throw Error('native_search_source_changed');
        if (event.type === 'tool/result' && event.sourceEventSeqs?.length === 1 && event.sourceEventSeqs[0] === call.seq
          && event.surfaceOp === 'append' && sessionToolCallId(event.data) === metadata.call_id) { result = event; break; }
      }
      if (!result) throw Error('native_search_source_pending');
      const selected = publicNativeFileSearch(result.data?.meta);
      const message = result.data?.message;
      const recovery = `Full ${metadata.tool_name === 'glob' ? 'sorted' : 'grep'} result stored at: ${metadata.locator}. ${metadata.retrieval_hint}`;
      if (message?.role !== 'tool' || message.isError !== false || message.source?.kind !== 'tool'
        || message.source.callId !== metadata.call_id || message.toolCallId !== metadata.call_id
        || publicNativeToolResult(result.data, false).failed || !selected
        || selected.shape !== 'source_limit' && selected.shape !== (metadata.tool_name === 'glob' ? 'paths' : 'matches')
        || !Array.isArray(message.content) || !message.content.some(value => value?.type === 'text' && typeof value.text === 'string' && value.text.includes(recovery)))
        throw Error('native_search_source_unavailable');
      const resultSha = eventHash(result);
      const page = search ? await store.search(identity, key, metadata, input.q)
        : await store.read(identity, key, metadata, input.offset_chars);
      check(identity, signal);
      if (eventHash(await eventAt(call.seq)) !== metadata.call_sha256 || eventHash(await eventAt(result.seq)) !== resultSha
        || hash(sessionHeaderIdentity(session?.header ?? handle.header)) !== metadata.session_header_sha256)
        throw Error('native_search_source_changed');
      return {protocol: 1, session_id: sessionId, call_seq: call.seq, tool_call_id: metadata.call_id,
        tool_name: metadata.tool_name, call_sha256: metadata.call_sha256, result_seq: result.seq, result_sha256: resultSha,
        source_sha256: metadata.sha256, source_bytes: metadata.bytes, scope: metadata.scope,
        ...page, execution_authorized: false};
    } finally { await handle?.close(); }
  }

  return Object.freeze({
    protocol: 1,
    async capture(exec, save, saved) {
      if (captures >= 2) throw Error('native_search_source_capacity');
      captures++;
      try { return await captureSource(exec, save, saved); }
      finally { captures--; }
    },
    async read(ownerId, sessionId, input, signal) {
      if (reads >= 4) throw Error('native_search_source_capacity');
      reads++;
      try { return await readSource(ownerId, sessionId, input, AbortSignal.any([signal, lifetime.signal])); }
      finally { reads--; }
    },
    async search(ownerId, sessionId, input, signal) {
      if (reads >= 4) throw Error('native_search_source_capacity');
      reads++;
      try { return await readSource(ownerId, sessionId, input, AbortSignal.any([signal, lifetime.signal]), true); }
      finally { reads--; }
    },
    dispose() { disposed = true; lifetime.abort(); store.dispose(); },
  });
}

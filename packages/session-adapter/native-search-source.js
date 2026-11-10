import {validateNativeSearchMembersRequest,validateNativeSearchMembers,validateNativeSearchMemberRangeRequest,validateNativeSearchMemberRange} from '../gateway/src/harness/native-search-members.js';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {isAbsolute,resolve} from 'node:path';
import {createNativeSearchSourceStore} from './native-search-source-store.js';
import {sessionHeaderIdentity} from './session-header-identity.js';
import {publicNativeFileSearch, publicNativeToolResult, sessionToolCallId} from './native-tool-result.js';
import {updateNativeChildLogHash} from './native-child-closure.js';

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const callId = value => typeof value === 'string' && value.length > 0 && value.length <= 8192;
const hash = value => createHash('sha256').update(value).digest('hex');
const eventHash = value => updateNativeChildLogHash(createHash('sha256'), value).digest('hex');
const memberKey = (identity,sessionId,seq) => hash(JSON.stringify([identity.ownerId,identity.profileId,sessionId,seq,'members-v1']));
const sourceKey = (identity, sessionId, seq) => hash(JSON.stringify([identity.ownerId, identity.profileId, sessionId, seq]));

/** Capture at the reviewed native producer and authorize reads from the final native result. */
export function createNativeSearchSource({readIdentity, agents, sessions, persistence}) {
  const store = createNativeSearchSourceStore({readIdentity});
  const lifetime = new AbortController(), runs = new WeakMap();
  let disposed = false, captures = 0, reads = 0;
  function check(identity, signal) {
    signal?.throwIfAborted();
    if (disposed || !isDeepStrictEqual(readIdentity(), identity)) throw Error('native_search_source_changed');
  }

  function producer(exec) {
    if (disposed || exec?.parent !== undefined || !['glob','grep'].includes(exec?.name)) throw Error('native_search_source_invalid');
    const signal=exec.signal,identity=readIdentity(),agent=exec.agent,session=agent?.session,sessionId=session?.id;
    check(identity,signal);
    if(!ID.test(sessionId??'')||agent.id!==sessionId||agent.session!==session||agents.get(sessionId)!==agent
      ||sessions.get(sessionId)!==session||session.header?.id!==sessionId||!callId(exec.callId))throw Error('native_search_source_invalid');
    let call;
    for(let seq=session.seq-1;seq>=0;seq--){
      const event=session.eventAt(seq);
      if(event?.seq!==seq)throw Error('native_search_source_changed');
      if(['tool/call','tool/result'].includes(event.type)&&sessionToolCallId(event.data)===exec.callId){
        if(event.type!=='tool/call'||event.data.name!==exec.name)throw Error('native_search_source_changed');
        call=event;break;
      }
    }
    if(!call)throw Error('native_search_source_changed');
    const callSha=eventHash(call),headerSha=hash(sessionHeaderIdentity(session.header));
    const assert=()=>{
      check(identity,signal);
      check(identity,exec.signal);
      if(agents.get(sessionId)!==agent||sessions.get(sessionId)!==session||agent.session!==session
        ||eventHash(session.eventAt(call.seq))!==callSha||hash(sessionHeaderIdentity(session.header))!==headerSha)
        throw Error('native_search_source_changed');
    };
    return {identity,session,sessionId,call,callSha,headerSha,assert};
  }

  async function captureSource(exec, save, saved) {
    const {identity,session,sessionId,call,assert}=producer(exec);
    if(save?.owner?.sessionId!==sessionId||save.source?.kind!=='tool'||save.source.toolName!==exec.name
      ||save.source.callId!==exec.callId||save.source.label!=='result'||save.suggestedName!==`${exec.name}-results.txt`
      ||typeof save.content!=='string'||Buffer.byteLength(save.content)>32*1024*1024
      ||saved?.bytes!==Buffer.byteLength(save.content)||typeof saved.locator!=='string'||!saved.locator||saved.locator.length>32768
      ||typeof saved.retrievalHint!=='string'||saved.retrievalHint.length>16384)throw Error('native_search_source_invalid');
    const metadata = {protocol: 1, owner_id: identity.ownerId, profile_id: identity.profileId,
      session_id: sessionId, session_header_sha256: hash(sessionHeaderIdentity(session.header)),
      call_id: exec.callId, call_seq: call.seq, call_sha256: eventHash(call), tool_name: exec.name,
      locator: saved.locator, retrieval_hint: saved.retrievalHint,
      bytes: saved.bytes, chars: save.content.length, sha256: hash(save.content),
      scope: exec.name === 'grep' ? 'all_entries_with_native_line_previews' : 'all_paths'};
    await store.save(identity, sourceKey(identity, sessionId, call.seq), metadata, save.content);
    assert();
  }

  function observeRun(exec,workdir) {
    if (exec?.parent !== undefined || !exec?.agent) return;
    const context = producer(exec);
    if (typeof workdir !== 'string' || !isAbsolute(workdir) || workdir.length > 32768 || workdir.includes('\0'))
      throw Error('native_search_source_invalid');
    runs.set(exec,{...context,workdir});
  }

  async function captureMemberSource(exec,value,content) {
    const run = runs.get(exec);
    if (!run) throw Error('native_search_source_unavailable');
    run.assert();
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(content) || content.length !== 1
      || Object.keys(content[0] ?? {}).sort().join(',') !== 'text,type' || content[0].type !== 'text'
      || typeof content[0].text !== 'string' || Buffer.byteLength(content[0].text) > 32*1024*1024)
      throw Error('native_search_source_invalid');
    const glob = exec.name === 'glob', rows = glob ? value.paths : value.matches;
    if (Object.keys(value).sort().join(',') !== (glob ? 'paths,root' : 'matches') || !Array.isArray(rows))
      throw Error('native_search_source_invalid');
    const originalTotal = rows.length, contentSha = eventHash(content);
    let count = 0;
    function* chunks() {
      let buffer = Buffer.allocUnsafe(65536), used = 0, previous;
      count = 0;
      for (const row of rows) {
        const path = glob ? row : row?.path;
        if (typeof path !== 'string' || !path || path.length > 32768 || path.includes('\0'))
          throw Error('native_search_source_invalid');
        if (path === previous) continue;
        previous = path;
        count++;
        const bytes = Buffer.from(JSON.stringify({path})+'\n','utf8');
        for (let offset = 0; offset < bytes.length;) {
          const length = Math.min(buffer.length-used,bytes.length-offset);
          bytes.copy(buffer,used,offset,offset+length);
          used += length;
          offset += length;
          if (used === buffer.length) {
            yield buffer;
            buffer = Buffer.allocUnsafe(65536);
            used = 0;
          }
        }
      }
      if (used) yield buffer.subarray(0,used);
    }
    await store.saveChunks(run.identity,memberKey(run.identity,run.sessionId,run.call.seq),stats => ({
      protocol:1,owner_id:run.identity.ownerId,profile_id:run.identity.profileId,session_id:run.sessionId,
      session_header_sha256:run.headerSha,call_id:exec.callId,call_seq:run.call.seq,call_sha256:run.callSha,
      tool_name:exec.name,scope:'typed_search_members',workdir:run.workdir,content_sha256:contentSha,
      original_total:originalTotal,member_count:count,...stats,
    }),chunks);
    run.assert();
  }

  async function readSource(ownerId, sessionId, input, signal, operation = 'read') {
    const search=operation==='search',members=operation==='members';
    if(members)input=validateNativeSearchMembersRequest(input);
    const identity = readIdentity();
    check(identity, signal);
    if (identity.ownerId !== ownerId) throw Error('native_search_source_forbidden');
    const allowed = members ? ['call_seq','tool_name','offset_members','members_sha256']
      : search ? ['call_seq','tool_name','q','source_sha256'] : ['call_seq','tool_name','offset_chars','source_sha256'];
    if (!ID.test(sessionId) || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !allowed.includes(key))
      || !Number.isSafeInteger(input.call_seq) || input.call_seq < 0 || !['glob', 'grep'].includes(input.tool_name)
      || (members ? !Number.isSafeInteger(input.offset_members)||input.offset_members<0
        : search ? typeof input.q !== 'string' || !input.q || input.q !== input.q.trim() || input.q.length > 200
        : !Number.isSafeInteger(input.offset_chars) || input.offset_chars < 0)
      || input.source_sha256 !== undefined && (typeof input.source_sha256 !== 'string' || !SHA.test(input.source_sha256))
      || !search&&!members&&input.offset_chars>0&&input.source_sha256===undefined
      || members&&(input.members_sha256!==undefined&&(typeof input.members_sha256!=='string'||!SHA.test(input.members_sha256))
        ||input.offset_members>0&&input.members_sha256===undefined)) throw Error('native_search_source_invalid');
    const key = (members?memberKey:sourceKey)(identity, sessionId, input.call_seq);
    const metadata = await store.inspect(identity, key);
    check(identity, signal);
    if (metadata.protocol !== 1 || metadata.owner_id !== ownerId || metadata.profile_id !== identity.profileId
      || metadata.session_id !== sessionId || metadata.call_seq !== input.call_seq || metadata.tool_name !== input.tool_name
      || !callId(metadata.call_id) || !SHA.test(metadata.call_sha256) || !SHA.test(metadata.session_header_sha256)
      || (members ? metadata.scope!=='typed_search_members'||typeof metadata.workdir!=='string'||!isAbsolute(metadata.workdir)
        ||!SHA.test(metadata.content_sha256)||!Number.isSafeInteger(metadata.member_count)||metadata.member_count<0
        ||!Number.isSafeInteger(metadata.original_total)||metadata.member_count>metadata.original_total
        : typeof metadata.locator!=='string'||!metadata.locator||typeof metadata.retrieval_hint!=='string'
          ||metadata.scope!==(input.tool_name==='grep'?'all_entries_with_native_line_previews':'all_paths')))
      throw Error('native_search_source_invalid');
    if ((members?input.members_sha256:input.source_sha256) !== undefined && (members?input.members_sha256:input.source_sha256) !== metadata.sha256) throw Error('native_search_source_changed');
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
      const recovery = members ? undefined : `Full ${metadata.tool_name === 'glob' ? 'sorted' : 'grep'} result stored at: ${metadata.locator}. ${metadata.retrieval_hint}`;
      if (message?.role !== 'tool' || message.isError !== false || message.source?.kind !== 'tool'
        || message.source.callId !== metadata.call_id || message.toolCallId !== metadata.call_id
        || publicNativeToolResult(result.data, false).failed || !selected
        || selected.shape !== 'source_limit' && selected.shape !== (metadata.tool_name === 'glob' ? 'paths' : 'matches')
        || !Array.isArray(message.content) || (members ? eventHash(message.content)!==metadata.content_sha256
          ||result.data.meta?.total!==metadata.original_total
          : !message.content.some(value=>value?.type==='text'&&typeof value.text==='string'&&value.text.includes(recovery))))
        throw Error('native_search_source_unavailable');
      const resultSha = eventHash(result);
      const page = members ? await store.memberPage(identity,key,metadata,input.offset_members)
        : search ? await store.search(identity, key, metadata, input.q)
        : await store.read(identity, key, metadata, input.offset_chars);
      check(identity, signal);
      if (eventHash(await eventAt(call.seq)) !== metadata.call_sha256 || eventHash(await eventAt(result.seq)) !== resultSha
        || hash(sessionHeaderIdentity(session?.header ?? handle.header)) !== metadata.session_header_sha256)
        throw Error('native_search_source_changed');
      const response = {protocol: 1, session_id: sessionId, call_seq: call.seq, tool_call_id: metadata.call_id,
        tool_name: metadata.tool_name, call_sha256: metadata.call_sha256, result_seq: result.seq, result_sha256: resultSha,
        ...(members?{members_sha256:metadata.sha256,workdir:metadata.workdir,original_total:metadata.original_total}
          :{source_sha256:metadata.sha256,source_bytes:metadata.bytes,scope:metadata.scope}),
        ...page, execution_authorized: false};
      return members?validateNativeSearchMembers(response,sessionId,input):response;
    } finally { await handle?.close(); }
  }

  return Object.freeze({
    protocol: 1,
    observeRun,
    async captureMembers(exec,value,content){
      if(captures>=2){runs.delete(exec);throw Error('native_search_source_capacity');}
      captures++;
      try{return await captureMemberSource(exec,value,content);}
      finally{captures--;runs.delete(exec);}
    },
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
      try { return await readSource(ownerId, sessionId, input, AbortSignal.any([signal, lifetime.signal]), 'search'); }
      finally { reads--; }
    },
    async members(ownerId,sessionId,input,signal){
      if(reads>=4)throw Error('native_search_source_capacity');
      reads++;
      try{return await readSource(ownerId,sessionId,input,AbortSignal.any([signal,lifetime.signal]),'members');}
      finally{reads--;}
    },
    async fileRange(ownerId,sessionId,value,files,signal) {
      if (reads >= 4) throw Error('native_search_source_capacity');
      reads++;
      try {
        const active = AbortSignal.any([signal,lifetime.signal]), identity = readIdentity();
        const input = validateNativeSearchMemberRangeRequest(value), member = input.member;
        const query = {call_seq:member.call_seq,tool_name:member.tool_name,
          offset_members:member.index,members_sha256:member.members_sha256};
        const original = await readSource(ownerId,sessionId,query,active,'members');
        check(identity,active);
        if (original.call_sha256 !== member.call_sha256 || original.result_sha256 !== member.result_sha256
          || original.items[0]?.index !== member.index) throw Error('native_search_source_changed');
        const path = resolve(original.workdir,original.items[0].path);
        const range = await files.read(ownerId,sessionId,{...input.range,path},active);
        check(identity,active);
        const current = await readSource(ownerId,sessionId,query,active,'members');
        check(identity,active);
        if (!isDeepStrictEqual(current,original)) throw Error('native_search_source_changed');
        return validateNativeSearchMemberRange({member_index:member.index,members_sha256:member.members_sha256,
          call_sha256:member.call_sha256,result_sha256:member.result_sha256,range},sessionId,input);
      } finally { reads--; }
    },
    dispose() { disposed = true; lifetime.abort(); store.dispose(); },
  });
}

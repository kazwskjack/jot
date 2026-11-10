import {posix,win32} from 'node:path';

const SHA = /^[a-f0-9]{64}$/;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !value.includes('\0');

export function validateNativeSearchMembersRequest(value) {
  const fields = ['call_seq','tool_name','offset_members'];
  if (record(value) && value.members_sha256 !== undefined) fields.push('members_sha256');
  if (!record(value) || Object.keys(value).sort().join(',') !== fields.sort().join(',')
    || !Number.isSafeInteger(value.call_seq) || value.call_seq < 0 || !['glob','grep'].includes(value.tool_name)
    || !Number.isSafeInteger(value.offset_members) || value.offset_members < 0
    || (fields.length === 4 ? typeof value.members_sha256 !== 'string' || !SHA.test(value.members_sha256) : value.offset_members !== 0))
    throw Error('native_search_source_invalid');
  return Object.freeze({...value});
}

/** Original indexed paths remain data. Opening one still requires native owner file authority. */
export function validateNativeSearchMembers(value,sessionId,input) {
  const request = validateNativeSearchMembersRequest(input);
  const fields = ['protocol','session_id','call_seq','tool_call_id','tool_name','call_sha256','result_seq','result_sha256',
    'members_sha256','workdir','original_total','offset_members','total_members','items','execution_authorized'];
  if (record(value) && value.next_offset_members !== undefined) fields.push('next_offset_members');
  if (!record(value) || Object.keys(value).sort().join(',') !== fields.sort().join(',')
    || value.protocol !== 1 || value.execution_authorized !== false || value.session_id !== sessionId
    || value.call_seq !== request.call_seq || value.tool_name !== request.tool_name
    || typeof value.tool_call_id !== 'string' || !value.tool_call_id || value.tool_call_id.length > 8192
    || !['call_sha256','result_sha256','members_sha256'].every(key => typeof value[key] === 'string' && SHA.test(value[key]))
    || request.members_sha256 !== undefined && request.members_sha256 !== value.members_sha256
    || !Number.isSafeInteger(value.result_seq) || value.result_seq <= value.call_seq
    || !text(value.workdir) || !posix.isAbsolute(value.workdir) && !win32.isAbsolute(value.workdir)
    || !Number.isSafeInteger(value.original_total) || value.original_total < 0
    || !Number.isSafeInteger(value.total_members) || value.total_members < 0 || value.total_members > value.original_total
    || value.offset_members !== request.offset_members || value.offset_members > value.total_members
    || !Array.isArray(value.items) || value.items.length !== Math.min(256,value.total_members-value.offset_members)
    || value.items.some((item,index) => !record(item) || Object.keys(item).sort().join(',') !== 'index,path'
      || item.index !== value.offset_members+index || !text(item.path)))
    throw Error('native_search_source_invalid');
  const end = value.offset_members+value.items.length;
  if (end < value.total_members ? value.next_offset_members !== end : value.next_offset_members !== undefined)
    throw Error('native_search_source_invalid');
  return Object.freeze({...value,items:Object.freeze(value.items.map(item => Object.freeze({...item})))});
}

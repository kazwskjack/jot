import {createHash} from 'node:crypto';

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 32768;
const text = value => opaque(value) && !value.includes('\0');
const record = value => value && typeof value === 'object' && !Array.isArray(value);

/** Opaque native versions and canonical paths constrain freshness, never read authority. */
export function validateNativeFileRangeRequest(value) {
  const fields = ['path','offset_bytes','length_bytes'];
  if (record(value) && ['version','absolute_path','session_sha256','file_size_bytes'].some(key => value[key] !== undefined))
    fields.push('version','absolute_path','session_sha256','file_size_bytes');
  if (!record(value) || Object.keys(value).sort().join(',') !== fields.sort().join(',') || !text(value.path)
    || !Number.isSafeInteger(value.offset_bytes) || value.offset_bytes < 0
    || !Number.isSafeInteger(value.length_bytes) || value.length_bytes < 1 || value.length_bytes > 65536
    || value.offset_bytes > Number.MAX_SAFE_INTEGER - value.length_bytes
    || (fields.length > 3 ? !opaque(value.version) || !text(value.absolute_path)
      || typeof value.session_sha256 !== 'string' || !SHA.test(value.session_sha256)
      || value.file_size_bytes !== null && (!Number.isSafeInteger(value.file_size_bytes) || value.file_size_bytes < 0) : value.offset_bytes !== 0))
    throw Error('native_file_range_invalid');
  return Object.freeze({...value});
}

/** Validate the actual native stat vocabulary without interpreting its version. */
export function validateNativeFileStat(value) {
  const fields = ['absolutePath','version'];
  if (record(value) && value.bytes !== undefined) fields.push('bytes');
  if (!record(value) || Object.keys(value).sort().join(',') !== fields.sort().join(',')
    || !text(value.absolutePath) || !opaque(value.version)
    || value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes < 0))
    throw Error('native_file_range_source_invalid');
  return Object.freeze({...value});
}

/** Source bytes are verified independently of native freshness and Session identity. */
export function validateNativeFileRange(value,sessionId,input) {
  const request = validateNativeFileRangeRequest(input);
  const fields = ['protocol','session_id','profile_id','session_sha256','absolute_path','version','file_size_bytes',
    'offset_bytes','data_base64','chunk_sha256','eof','execution_authorized'];
  if (!record(value) || Object.keys(value).sort().join(',') !== fields.sort().join(',')
    || value.protocol !== 1 || value.execution_authorized !== false || value.session_id !== sessionId
    || typeof value.profile_id !== 'string' || !ID.test(value.profile_id)
    || typeof value.session_sha256 !== 'string' || !SHA.test(value.session_sha256)
    || !text(value.absolute_path) || !opaque(value.version) || value.offset_bytes !== request.offset_bytes
    || value.file_size_bytes !== null && (!Number.isSafeInteger(value.file_size_bytes) || value.file_size_bytes < 0)
    || request.version !== undefined && (value.version !== request.version || value.absolute_path !== request.absolute_path
      || value.session_sha256 !== request.session_sha256 || value.file_size_bytes !== request.file_size_bytes)
    || typeof value.data_base64 !== 'string' || value.data_base64.length > 87384
    || typeof value.chunk_sha256 !== 'string' || !SHA.test(value.chunk_sha256) || typeof value.eof !== 'boolean')
    throw Error('native_file_range_source_invalid');
  const data = Buffer.from(value.data_base64,'base64');
  if (data.toString('base64') !== value.data_base64 || data.length > request.length_bytes
    || createHash('sha256').update(data).digest('hex') !== value.chunk_sha256
    || (value.file_size_bytes === null ? value.eof !== (data.length < request.length_bytes)
      : data.length !== Math.min(request.length_bytes,Math.max(0,value.file_size_bytes-request.offset_bytes))
        || value.eof !== (request.offset_bytes+data.length>=value.file_size_bytes)))
    throw Error('native_file_range_source_invalid');
  return Object.freeze({...value});
}

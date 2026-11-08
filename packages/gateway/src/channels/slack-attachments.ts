import { createHash } from 'node:crypto';

const MAX_BYTES = 20 * 1024 * 1024;
type Row = Record<string, unknown>;
export type SlackFile = Readonly<{ id: string; created: number; user: string; name: string;
  mimetype: string; size: number; metadataSha256: string }>;
export type SlackDownloadedFile = Readonly<{provider_file_id:string;file_name:string;media_type:string;
  size_bytes:number;sha256:string;bytes:Buffer}>;
export type SlackFileTransport = (url: URL, init: RequestInit) => Promise<Response>;

function canonical(raw: unknown): Omit<SlackFile, 'metadataSha256'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('slack_file_metadata_invalid');
  const r = raw as Row;
  if (typeof r.id !== 'string' || !/^F[A-Z0-9]{2,80}$/.test(r.id)
    || typeof r.user !== 'string' || !/^[UW][A-Z0-9]{2,80}$/.test(r.user)
    || !Number.isSafeInteger(r.created) || Number(r.created) < 1
    || typeof r.name !== 'string' || !r.name || r.name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(r.name)
    || typeof r.mimetype !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(r.mimetype)
    || !Number.isSafeInteger(r.size) || Number(r.size) < 1 || Number(r.size) > MAX_BYTES
    || r.is_external !== false || r.mode !== 'hosted' || r.editable !== false) throw Error('slack_file_metadata_invalid');
  return { id: r.id, created: Number(r.created), user: r.user, name: r.name, mimetype: r.mimetype, size: Number(r.size) };
}

export function slackFiles(value: unknown, user: string): readonly SlackFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length || value.length > 10) throw Error('slack_file_metadata_invalid');
  const ids = new Set<string>();
  let aggregate = 0;
  return value.map(raw => {
    const f = canonical(raw);
    aggregate += f.size;
    if (f.user !== user || ids.has(f.id) || aggregate > MAX_BYTES) throw Error('slack_file_metadata_invalid');
    ids.add(f.id);
    return Object.freeze({ ...f, metadataSha256: createHash('sha256').update(JSON.stringify(f)).digest('hex') });
  });
}

export function slackFileIdentity(file: SlackFile) {
  return `${file.id}:${file.created}:${file.metadataSha256}`;
}

async function bounded(response: Response, max: number, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) {
    await response.body?.cancel(); throw Error('slack_file_size_invalid');
  }
  if (!response.body) throw Error('slack_file_body_invalid');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const parts: Buffer[] = []; let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw Error('slack_file_size_invalid');
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts, total);
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}

/** URLs in webhook payloads never authorize a request. Resolve the signed immutable
 * file identity through the authenticated API, then restrict the returned URL. */
export async function downloadSlackFiles(input: { files: readonly SlackFile[]; teamId: string;
  botToken: string; transport?: SlackFileTransport }): Promise<SlackDownloadedFile[]> {
  const transport = input.transport ?? fetch;
  const signal = AbortSignal.timeout(2000);
  const downloaded: SlackDownloadedFile[] = [];
  for (const file of input.files) {
    signal.throwIfAborted();
    const api = new URL('https://slack.com/api/files.info'); api.searchParams.set('file', file.id);
    const response = await transport(api, { headers: { authorization: `Bearer ${input.botToken}` }, redirect: 'manual', signal });
    if (response.status !== 200) { await response.body?.cancel(); throw Error('slack_file_lookup_failed'); }
    let data: Row;
    try { data = JSON.parse((await bounded(response, 64 * 1024, signal)).toString('utf8')); }
    catch { throw Error('slack_file_lookup_invalid'); }
    if (data.ok !== true || !data.file) throw Error('slack_file_lookup_invalid');
    const current = canonical(data.file);
    if (createHash('sha256').update(JSON.stringify(current)).digest('hex') !== file.metadataSha256) throw Error('slack_file_version_conflict');
    const raw = data.file as Row;
    let url: URL;
    try { url = new URL(String(raw.url_private_download ?? raw.url_private)); } catch { throw Error('slack_file_origin_invalid'); }
    if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.port || url.username || url.password
      || url.hash || !url.pathname.startsWith(`/files-pri/${input.teamId}-${file.id}/`)
      || /%2f|%5c|%2e/i.test(url.pathname)) throw Error('slack_file_origin_invalid');
    const download = await transport(url, { headers: { authorization: `Bearer ${input.botToken}` }, redirect: 'manual', signal });
    if (download.status !== 200) { await download.body?.cancel(); throw Error('slack_file_download_failed'); }
    const media = download.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (media !== file.mimetype.toLowerCase()) { await download.body?.cancel(); throw Error('slack_file_media_mismatch'); }
    const bytes = await bounded(download, Math.min(file.size, MAX_BYTES), signal);
    if (bytes.length !== file.size) throw Error('slack_file_size_invalid');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    downloaded.push(Object.freeze({provider_file_id:slackFileIdentity(file),file_name:file.name,
      media_type:file.mimetype,size_bytes:file.size,sha256,bytes}));
  }
  return downloaded;
}

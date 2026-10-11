import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 192 && b === 0 && c === 2) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  // Conservatively allow global unicast only, excluding translation/tunnel and documentation ranges.
  return /^[23][0-9a-f]{3}:/.test(normalized) && !normalized.startsWith('2001:')
    && !normalized.startsWith('2002:') && !normalized.startsWith('3fff:');
}

export function validatePageUrl(value: unknown): URL {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new Error('unsafe_page_url'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))
    || !host.includes('.') && !isIP(host) || (isIP(host) && !publicAddress(host))
    || /(^|\.)(localhost|local|internal|home|lan|test|invalid)$/.test(host.toLowerCase())) throw new Error('unsafe_page_url');
  url.hash = ''; return url;
}

type Address = { address: string; family: number };
export function pinnedLookup(address: Address): LookupFunction {
  return (_hostname,options,callback)=>options.all ? callback(null,[address]) : callback(null,address.address,address.family);
}
export type PageResponse = { status: number; location?: string; contentType?: string; text: string };
export type PageReaderOptions = {
  resolve?: (hostname: string) => Promise<Address[]>;
  request?: (url: URL, address: Address) => Promise<PageResponse>;
};

async function pinnedRequest(url: URL, address: Address): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport(url, {
      method: 'GET', agent: false, headers: { Accept: 'text/html,text/plain,application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'Jot-Persistent-Tasks/1' },
      // DNS is not consulted again by the socket; TLS still verifies the original hostname.
      lookup: pinnedLookup(address),
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 262144) { response.destroy(new Error('page_too_large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'),
        ...(response.headers.location ? { location: response.headers.location } : {}),
        ...(response.headers['content-type'] ? { contentType: response.headers['content-type'] } : {}) }));
    });
    const timeout = setTimeout(() => req.destroy(new Error('page_timeout')), 10000);
    req.on('close', () => clearTimeout(timeout)); req.on('error', reject); req.end();
  });
}

export async function readPublicPage(value: string, options: PageReaderOptions = {}): Promise<{ text: string; url: string }> {
  let url = validatePageUrl(value);
  const resolve = options.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  const request = options.request ?? pinnedRequest;
  for (let hop = 0; hop <= 5; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('unsafe_page_url');
    const response = await request(url, addresses[0]!);
    if ([301,302,303,307,308].includes(response.status)) {
      if (!response.location || hop === 5) throw new Error('page_redirect_limit');
      url = validatePageUrl(new URL(response.location, url).href); continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error('page_http_error');
    if (!/^text\/(html|plain)|^application\/(json|xhtml\+xml)/i.test(response.contentType ?? '')) throw new Error('page_content_type');
    if (Buffer.byteLength(response.text) > 262144) throw new Error('page_too_large');
    return { text: response.text.replace(/\r\n/g, '\n').trim(), url: url.href };
  }
  throw new Error('page_redirect_limit');
}

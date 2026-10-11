/** Shared request hashing for HTTP idempotency and its committed task receipt. */
export function canonicalJson(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value&&typeof value==='object'&&!Buffer.isBuffer(value)){
    const row=value as Record<string,unknown>;
    return `{${Object.keys(row).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
  }
  if(Buffer.isBuffer(value))return JSON.stringify(value.toString('base64'));
  return JSON.stringify(value)??'null';
}

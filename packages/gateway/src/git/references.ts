/** Full reference grammar shared by original review, evidence and inventory. */
export function validGitReference(value:unknown):value is string{
 return typeof value==='string'&&value.startsWith('refs/')&&value.length<=1024
  &&Buffer.from(value,'utf8').toString('utf8')===value&&!/[\x00-\x20\x7f~^:?*\[\\]/.test(value)
  &&!value.includes('..')&&!value.includes('@{')
  &&value.split('/').every(part=>!!part&&!part.startsWith('.')&&!part.endsWith('.')&&!part.endsWith('.lock'));
}

/** Full reference grammar shared by original review, evidence and inventory. */
export function validGitReference(value:unknown):value is string{
 return typeof value==='string'&&value.startsWith('refs/')&&value.length<=1024
  &&Buffer.from(value,'utf8').toString('utf8')===value&&!/[\x00-\x20\x7f~^:?*\[\\]/.test(value)
  &&!value.includes('..')&&!value.includes('@{')
  &&value.split('/').every(part=>!!part&&!part.startsWith('.')&&!part.endsWith('.')&&!part.endsWith('.lock'));
}

/** Git's per-worktree ref exceptions share the same rule in copies and source proofs. */
export function gitReferenceScope(ref:string):'git'|'common'{
 return ref==='HEAD'||/^refs\/(?:bisect|worktree|rewritten)\//.test(ref)?'git':'common';
}

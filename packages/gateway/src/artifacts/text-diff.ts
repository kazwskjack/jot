/** Keep the original positional line comparison and public header format. */
export function formatTextDiff(before:string,after:string,fromLabel:string,toLabel:string){
 const left=before.split(/\r?\n/),right=after.split(/\r?\n/);
 const lines=[`--- ${fromLabel}`,`+++ ${toLabel}`];
 for(let index=0;index<Math.max(left.length,right.length);index++){
  if(left[index]===right[index])continue;
  if(left[index]!==undefined)lines.push(`-${left[index]}`);
  if(right[index]!==undefined)lines.push(`+${right[index]}`);
 }
 return lines.join('\n');
}

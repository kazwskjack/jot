import {createHash} from 'node:crypto';
import {artifactTextBoundary,searchRetainedArtifactText,readRetainedArtifactTextPage} from './text-content.ts';

function* textLines(text:string){
 let start=0;
 while(start<=text.length){
  const newline=text.indexOf('\n',start);
  if(newline===-1){yield text.slice(start);break;}
  const end=newline>start&&text[newline-1]==='\r'?newline-1:newline;
  yield text.slice(start,end);start=newline+1;
 }
}
/** Preserve the original positional comparison, CRLF splitting and public headers. */
function* differenceLines(before:string,after:string,fromLabel:string,toLabel:string){
 yield `--- ${fromLabel}`;yield `+++ ${toLabel}`;
 const left=textLines(before),right=textLines(after);
 for(;;){
  const beforeLine=left.next(),afterLine=right.next();
  if(beforeLine.done&&afterLine.done)break;
  if(beforeLine.value===afterLine.value&&beforeLine.done===afterLine.done)continue;
  if(!beforeLine.done)yield `-${beforeLine.value}`;
  if(!afterLine.done)yield `+${afterLine.value}`;
 }
}
export function formatTextDiff(before:string,after:string,fromLabel:string,toLabel:string){
 return [...differenceLines(before,after,fromLabel,toLabel)].join('\n');
}

/** Drain the complete generated difference before returning its page or first match. */
export function scanTextDiff(before:string,after:string,fromLabel:string,toLabel:string,offset=0,q?:string){
 const hash=createHash('sha256'),start=Math.max(0,offset-1),stop=offset+16385;
 let total=0,window='',carry='',first=true,match:ReturnType<typeof searchRetainedArtifactText>['match'];
 for(const line of differenceLines(before,after,fromLabel,toLabel)){
  const chunk=(first?'':'\n')+line;first=false;hash.update(chunk);
  const left=Math.max(0,start-total),right=Math.min(chunk.length,stop-total);
  if(right>left)window+=chunk.slice(left,right);
  if(q&&!match){
   const text=carry+chunk,found=searchRetainedArtifactText(text,q).match;
   if(found&&found.match_offset_chars+found.match_text.length+60<=text.length){
    const base=total-carry.length;
    match={...found,offset_chars:base+found.offset_chars,match_offset_chars:base+found.match_offset_chars};carry='';
   }else carry=text.slice(artifactTextBoundary(text,Math.max(0,text.length-2*q.length-122)));
  }
  total+=chunk.length;
 }
 if(q&&!match){
  const found=searchRetainedArtifactText(carry,q).match;
  if(found){const base=total-carry.length;match={...found,offset_chars:base+found.offset_chars,match_offset_chars:base+found.match_offset_chars};}
 }
 const page=readRetainedArtifactTextPage(window,offset-start),end=offset+page.text.length;
 return {diff_sha256:hash.digest('hex'),offset_chars:offset,total_chars:total,text:page.text,
  page_sha256:createHash('sha256').update(page.text).digest('hex'),...(end<total?{next_offset_chars:end}:{}),...(match?{match}:{})};
}

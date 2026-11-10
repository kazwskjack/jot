import type {TerminalBuffer} from './terminal-assets';

export type TerminalPrompt={signature:string;options:{number:string;label:string}[]};

/** Adapted from pinned PilotDeck Shell.tsx. Only the rendered cursor neighborhood is inspected. */
export function terminalPrompt(buffer:TerminalBuffer):TerminalPrompt|undefined {
  const cursor=buffer.baseY+buffer.cursorY,end=Math.min(buffer.length-1,cursor+10),lines:string[]=[];
  for(let index=Math.max(0,cursor-20);index<=end;index++)lines.push(buffer.getLine(index)?.translateToString(true)??'');
  const footer=lines.findLastIndex(line=>/esc to cancel|enter to select/i.test(line));
  if(footer<0)return;
  const found=new Map<string,string>();
  for(let index=footer-1;index>=Math.max(0,footer-15);index--){
    const match=lines[index]!.match(/^\s*[❯›>]?\s*(\d+)\.\s+(.+)/);
    if(match&&Number(match[1])>=1&&Number(match[1])<=5&&match[2]!.trim()&&!found.has(match[1]!))found.set(match[1]!,match[2]!.trim());
  }
  const options:TerminalPrompt['options']=[];
  for(let number=1;number<=found.size;number++){
    const label=found.get(String(number));if(!label)break;
    options.push({number:String(number),label});
  }
  if(options.length>=2)return {signature:JSON.stringify([cursor,lines]),options};
}

/** Original URL punctuation/protocol rules, applied after xterm has interpreted ANSI. */
export function terminalLinks(buffer:TerminalBuffer):string[] {
  let text='',nextWrapped=false;
  for(let index=Math.min(buffer.length-1,buffer.baseY+buffer.cursorY+10);index>=0&&text.length<32768;index--){
    const line=buffer.getLine(index);if(!line)continue;
    text=line.translateToString(true)+(nextWrapped?'':'\n')+text;nextWrapped=line.isWrapped;
  }
  text=text.slice(-32768);
  const matches=text.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/gi)??[];
  let wrapped:string[]=[];
  for(const row of text.split(/\r?\n/)){
    const line=row.trim(),start=line.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/i);
    if(start){
      if(wrapped.length)matches.push(wrapped.join(''));
      wrapped=[start[0]];
    }else if(wrapped.length&&/^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/.test(line))wrapped.push(line);
    else{if(wrapped.length)matches.push(wrapped.join(''));wrapped=[];}
  }
  if(wrapped.length)matches.push(wrapped.join(''));
  const urls=new Set<string>();
  for(const match of matches){
    try{
      const url=new URL(match.trim().replace(/[)\]}>.,;:!?]+$/,''));
      if(url.protocol==='http:'||url.protocol==='https:')urls.add(url.href);
    }catch{}
  }
  const sorted=[...urls].sort();
  return sorted.filter((url,index)=>!sorted[index+1]?.startsWith(url));
}

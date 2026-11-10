import type {TerminalInput} from '../../packages/gateway/src/terminal/stream.js';

type Entry={command:TerminalInput;bytes:number;posted:boolean};
type Limits={maxInputBytes:number;maxBufferedBytes:number;maxCols:number;maxRows:number};
/** One physical attachment owns its sequence and every unacknowledged input byte. */
export class TerminalInputSender {
  private readonly entries=new Map<number,Entry>();
  private sequence=0;
  private nextToPost=1;
  private acknowledged=0;
  private bytes=0;
  private inFlight=0;
  private sending=false;
  private closed=false;
  private writable=false;
  private revoked=false;
  private readonly encoder=new TextEncoder();
  constructor(private readonly limits:Limits,private readonly window:{maxBytes:number;frameOverheadBytes:number},
    private readonly post:(command:TerminalInput)=>Promise<void>,private readonly pending:(value:boolean)=>void,
    private readonly refused:(message:string)=>void,private readonly failed:()=>void) {}
  get canWrite(){return !this.closed&&this.writable;}
  get unconfirmedCount(){let count=0;for(const entry of this.entries.values())if(entry.posted)count++;return count;}
  private cost(command:TerminalInput){return this.encoder.encode(JSON.stringify(command)).length+this.window.frameOverheadBytes;}
  setWritable(value:boolean) {
    if(this.writable&&!value)this.revoked=true;
    this.writable=value&&!this.revoked;
    if(!value){
      let dropped=0;
      for(const [sequence,entry] of this.entries)if(!entry.posted){this.entries.delete(sequence);this.bytes-=entry.bytes;dropped++;}
      this.pending(this.entries.size>0);
      if(dropped)this.refused('控制权已转移，未发送的输入已清除。');
    }
    this.pump();
  }
  write(data:string) {
    if(!data)return true;
    if(this.closed||!this.writable)return false;
    const remaining=this.limits.maxBufferedBytes-this.bytes;
    if(data.length>remaining){this.refused('输入超过当前原生缓冲范围，请分段粘贴。');return false;}
    const raw=this.encoder.encode(data),decoder=new TextDecoder('utf-8',{fatal:true}),batch:Entry[]=[];
    let offset=0,bytes=0,sequence=this.sequence;
    const capacity=Math.min(this.window.maxBytes,this.limits.maxBufferedBytes);
    while(offset<raw.length){
      let end=Math.min(raw.length,offset+this.limits.maxInputBytes);
      while(end>offset&&end<raw.length&&(raw[end]!&0xc0)===0x80)end--;
      let entry:Entry|undefined;
      while(end>offset){
        const command:TerminalInput={type:'write',sequence:sequence+1,data:decoder.decode(raw.subarray(offset,end))};
        const cost=this.cost(command);
        if(cost<=capacity){entry={command,bytes:cost,posted:false};break;}
        end=offset+Math.floor((end-offset)/2);
        while(end>offset&&end<raw.length&&(raw[end]!&0xc0)===0x80)end--;
      }
      if(!entry||bytes+entry.bytes>remaining){this.refused('输入超过当前原生字节或缓冲范围，请分段粘贴。');return false;}
      batch.push(entry);bytes+=entry.bytes;sequence++;offset=end;
    }
    for(const entry of batch)this.entries.set(entry.command.sequence,entry);
    this.sequence=sequence;this.bytes+=bytes;this.pending(true);this.pump();return true;
  }
  resize(cols:number,rows:number) {
    if(this.closed||!this.writable||!Number.isSafeInteger(cols)||cols<2||cols>this.limits.maxCols
      ||!Number.isSafeInteger(rows)||rows<1||rows>this.limits.maxRows)return false;
    const command:TerminalInput={type:'resize',sequence:this.sequence+1,cols,rows},bytes=this.cost(command);
    if(bytes>this.window.maxBytes||bytes>this.limits.maxBufferedBytes-this.bytes)return false;
    this.entries.set(command.sequence,{command,bytes,posted:false});this.sequence++;this.bytes+=bytes;
    this.pending(true);this.pump();return true;
  }
  acknowledge(sequence:number,refusal?:'read-only'|'not-running') {
    const entry=this.entries.get(sequence);
    if(this.closed||!entry?.posted||sequence!==this.acknowledged+1)throw Error('终端输入确认序号不匹配');
    this.entries.delete(sequence);this.acknowledged=sequence;this.bytes-=entry.bytes;this.inFlight-=entry.bytes;
    if(refusal){this.setWritable(false);this.refused(refusal==='read-only'?'终端控制权已转移，可重新连接。':'终端进程已经结束。');}
    this.pending(this.entries.size>0);this.pump();
  }
  private pump() {
    if(this.closed||!this.writable||this.sending)return;
    const entry=this.entries.get(this.nextToPost);
    if(!entry||entry.bytes>this.window.maxBytes-this.inFlight)return;
    entry.posted=true;this.nextToPost++;this.inFlight+=entry.bytes;this.sending=true;
    const sequence=entry.command.sequence;
    void this.post(entry.command).then(()=>{this.sending=false;this.pump();},()=>{
      if(this.closed)return;
      if(sequence<=this.acknowledged){this.sending=false;this.pump();return;}
      this.close();this.failed();
    });
  }
  close() {
    const count=this.entries.size;this.closed=true;this.writable=false;this.entries.clear();this.bytes=0;this.inFlight=0;
    this.pending(false);return count;
  }
}

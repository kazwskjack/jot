import {readGeneratedPng} from './upload-recovery.mjs';

type Size={width:number;height:number};
const bounded=(size:Size)=>Number.isSafeInteger(size.width)&&Number.isSafeInteger(size.height)&&size.width>0&&size.height>0&&size.width<=4096&&size.height<=4096&&size.width*size.height<=4194304;
const ascii=(bytes:Uint8Array,start:number)=>String.fromCharCode(...bytes.subarray(start,start+4));
/** Inspect static headers before a browser decoder receives any untrusted inline image. */
export async function mcpInlineImageSize(bytes:Uint8Array<ArrayBuffer>,mime:string):Promise<Size|undefined>{
 if(bytes.length>512*1024)return;
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let size:Size|undefined;
 if(mime==='image/png'){
  let offset=8,ended=false,data=false;
  if(bytes.length<33)return;
  while(offset+12<=bytes.length){
   const length=view.getUint32(offset),kind=ascii(bytes,offset+4),next=offset+12+length;if(next>bytes.length)return;
   if(['acTL','fcTL','fdAT'].includes(kind)||kind==='IHDR'&&offset!==8)return;
   if(offset===8&&(kind!=='IHDR'||length!==13))return;
   if(kind==='IDAT')data=true;
   if(kind==='IEND'){if(length!==0||next!==bytes.length)return;ended=true;break;}
   offset=next;
  }
  if(!ended||!data)return;
  size=await readGeneratedPng(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
 }else if(mime==='image/jpeg'){
  if(bytes.length<4||bytes[0]!==255||bytes[1]!==216)return;
  let offset=2,scan=false;
  while(offset<bytes.length){
   if(bytes[offset++]!==255)return;while(bytes[offset]===255)offset++;
   const marker=bytes[offset++];if(marker===218){scan=true;break;}if(marker===undefined||marker===217||marker===216||marker===1||marker>=208&&marker<=215||marker===0)return;
   if(offset+2>bytes.length)return;const length=view.getUint16(offset);if(length<2||offset+length>bytes.length)return;
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
    if(![192,193,194].includes(marker)||size||length<8)return;
    const components=bytes[offset+7]!;if(components<1||components>4||length!==8+3*components)return;
    size={width:view.getUint16(offset+5),height:view.getUint16(offset+3)};
   }
   offset+=length;
  }
  if(!scan)return;
 }else if(mime==='image/webp'){
  if(bytes.length<20||ascii(bytes,0)!=='RIFF'||ascii(bytes,8)!=='WEBP'||view.getUint32(4,true)+8!==bytes.length)return;
  let offset=12,canvas:Size|undefined,count=0;
  const uint24=(at:number)=>bytes[at]!+bytes[at+1]!*256+bytes[at+2]!*65536;
  while(offset+8<=bytes.length){
   const kind=ascii(bytes,offset),length=view.getUint32(offset+4,true),start=offset+8,next=start+length+(length%2);if(next>bytes.length)return;
   if(kind==='ANIM'||kind==='ANMF')return;
   if(kind==='VP8X'){if(length!==10||canvas||bytes[start]!&2)return;canvas={width:uint24(start+4)+1,height:uint24(start+7)+1};}
   if(kind==='VP8 '){if(length<10||bytes[start]!&1||bytes[start+3]!==157||bytes[start+4]!==1||bytes[start+5]!==42)return;
    count++;size={width:view.getUint16(start+6,true)&16383,height:view.getUint16(start+8,true)&16383};}
   if(kind==='VP8L'){if(length<5||bytes[start]!==47)return;const bits=view.getUint32(start+1,true);if(bits>>>29)return;
    count++;size={width:(bits&16383)+1,height:((bits>>>14)&16383)+1};}
   offset=next;
  }
  if(offset!==bytes.length||count!==1||canvas&&size&&(canvas.width!==size.width||canvas.height!==size.height))return;
 }
 return size&&bounded(size)?{width:size.width,height:size.height}:undefined;
}

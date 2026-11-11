// Appearance image preflight adapts Jot's existing mcp-inline-image parser.
import {MAX_BACKGROUND_BYTES} from './light-appearance.mjs';
const ascii=(b,at)=>String.fromCharCode(...b.subarray(at,at+4));
export function appearanceImageSize(bytes,mime,{stored=false}={}){
 if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>MAX_BACKGROUND_BYTES)return null;
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let size=null;
 if(mime==='image/png'){
  if(bytes.length<45||![137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n))return null;
  let offset=8,data=false,ended=false,chunks=0;
  while(offset+12<=bytes.length){
   if(++chunks>65536)return null;
   const length=view.getUint32(offset),kind=ascii(bytes,offset+4),next=offset+length+12;if(next>bytes.length)return null;
   if(offset===8){if(kind!=='IHDR'||length!==13)return null;size={width:view.getUint32(offset+8),height:view.getUint32(offset+12)};}
   else if(kind==='IHDR')return null;
   if(stored&&['acTL','fcTL','fdAT'].includes(kind))return null;
   if(kind==='IDAT')data=true;
   if(kind==='IEND'){if(length!==0||next!==bytes.length)return null;ended=true;break;}
   offset=next;
  }
  if(!data||!ended)return null;
 }else if(mime==='image/jpeg'){
  if(stored||bytes.length<4||bytes[0]!==255||bytes[1]!==216)return null;
  let offset=2,scan=false;
  while(offset<bytes.length){
   if(bytes[offset++]!==255)return null;while(bytes[offset]===255)offset++;
   const marker=bytes[offset++];if(marker===218){scan=true;break;}
   if(marker===undefined||marker===217||marker===216||marker===1||marker>=208&&marker<=215||marker===0||offset+2>bytes.length)return null;
   const length=view.getUint16(offset);if(length<2||offset+length>bytes.length)return null;
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
    if(![192,193,194].includes(marker)||size||length<8)return null;
    const components=bytes[offset+7];if(components<1||components>4||length!==8+3*components)return null;
    size={width:view.getUint16(offset+5),height:view.getUint16(offset+3)};
   }
   offset+=length;
  }
  if(!scan)return null;
 }else if(mime==='image/webp'){
  if(bytes.length<20||ascii(bytes,0)!=='RIFF'||ascii(bytes,8)!=='WEBP'||view.getUint32(4,true)+8!==bytes.length)return null;
  let offset=12,canvas=null,count=0,animated=false,chunks=0;
  const uint24=at=>bytes[at]+bytes[at+1]*256+bytes[at+2]*65536;
  while(offset+8<=bytes.length){
   if(++chunks>65536)return null;
   const kind=ascii(bytes,offset),length=view.getUint32(offset+4,true),start=offset+8,next=start+length+(length%2);if(next>bytes.length)return null;
   if(kind==='ANIM'||kind==='ANMF')animated=true;
   if(kind==='VP8X'){if(length!==10||canvas)return null;animated=animated||!!(bytes[start]&2);canvas={width:uint24(start+4)+1,height:uint24(start+7)+1};}
   if(kind==='VP8 '){if(length<10||bytes[start]&1||bytes[start+3]!==157||bytes[start+4]!==1||bytes[start+5]!==42)return null;count++;size={width:view.getUint16(start+6,true)&16383,height:view.getUint16(start+8,true)&16383};}
   if(kind==='VP8L'){if(length<5||bytes[start]!==47)return null;const bits=view.getUint32(start+1,true);if(bits>>>29)return null;count++;size={width:(bits&16383)+1,height:((bits>>>14)&16383)+1};}
   offset=next;
  }
  if(offset!==bytes.length||stored&&animated)return null;
  if(animated){if(!canvas)return null;size=canvas;}
  else if(count!==1||canvas&&size&&(canvas.width!==size.width||canvas.height!==size.height))return null;
 }else return null;
 const edge=stored?3840:32768,pixels=stored?3840*3840:64*1024*1024;
 return size&&Number.isSafeInteger(size.width)&&Number.isSafeInteger(size.height)&&size.width>0&&size.height>0&&size.width<=edge&&size.height<=edge&&size.width*size.height<=pixels?size:null;
}

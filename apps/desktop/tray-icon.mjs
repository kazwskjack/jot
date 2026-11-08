import {deflateSync} from 'node:zlib';

const signature=Buffer.from([137,80,78,71,13,10,26,10]);
const crcTable=Uint32Array.from({length:256},(_,value)=>{
 let crc=value;
 for(let bit=0;bit<8;bit++)crc=(crc&1)?(0xedb88320^(crc>>>1)):(crc>>>1);
 return crc>>>0;
});
function crc32(buffer){let crc=0xffffffff;for(const byte of buffer)crc=crcTable[(crc^byte)&0xff]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type,'ascii'),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,checksum]);}

export function buildTrayIconPng(){
 const width=16,height=16,rows=Buffer.alloc(height*(1+width*4));
 const blue=[48,89,206,255],white=[255,255,255,255];
 const glyph=new Set(['6,4','7,4','8,4','9,4','10,4','9,5','9,6','9,7','9,8','9,9','9,10','8,11','7,12','6,12','5,11']);
 for(let y=0;y<height;y++){
  const row=y*(1+width*4);rows[row]=0;
  for(let x=0;x<width;x++){
   const offset=row+1+x*4,dx=x-7.5,dy=y-7.5;
   const inDisc=dx*dx+dy*dy<=55;
   const color=inDisc?(glyph.has(`${x},${y}`)?white:blue):[0,0,0,0];
   rows.set(color,offset);
  }
 }
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 return Buffer.concat([signature,chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}

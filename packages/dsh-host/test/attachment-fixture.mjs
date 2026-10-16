import {deflateSync,crc32} from 'node:zlib';
/** Deterministic synthetic RGB PNG. No user image or generated binary asset. */
export function syntheticAttachmentPng(){
 const width=128,height=128,header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const raw=Buffer.alloc((width*3+1)*height,180);for(let y=0;y<height;y++)raw[y*(width*3+1)]=0;
 const chunk=(name,bytes)=>{const type=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(Buffer.concat([type,bytes])));return Buffer.concat([size,type,bytes,crc]);};
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}

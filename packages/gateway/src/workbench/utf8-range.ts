export function validateFileRange(offsetBytes:number,limitBytes:number):void {
  if(!Number.isSafeInteger(offsetBytes)||offsetBytes<0||!Number.isSafeInteger(limitBytes)||limitBytes<1||limitBytes>65536){
    throw Error('invalid_file_range');
  }
}

/** Byte offsets remain tied to the source hash and never split a UTF-8 scalar. */
export function readUtf8Range(bytes:Buffer,offsetBytes:number,limitBytes:number){
  validateFileRange(offsetBytes,limitBytes);
  if(offsetBytes>bytes.length)throw Error('invalid_file_range');
  if(offsetBytes<bytes.length&&(bytes[offsetBytes]!&0xc0)===0x80)throw Error('invalid_file_range');
  let end=Math.min(bytes.length,offsetBytes+limitBytes);
  while(end>offsetBytes&&end<bytes.length&&(bytes[end]!&0xc0)===0x80)end--;
  if(end===offsetBytes&&offsetBytes<bytes.length)throw Error('invalid_file_range');
  return {offset_bytes:offsetBytes,returned_bytes:end-offsetBytes,eof:end===bytes.length,content:bytes.subarray(offsetBytes,end).toString('utf8')};
}

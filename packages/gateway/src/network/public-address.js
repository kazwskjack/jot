import {isIP} from 'node:net';

function ipv6Words(address){
 let value=address.toLowerCase();
 if(value.includes('.')){
  const split=value.lastIndexOf(':');if(split<0)return;
  const octets=value.slice(split+1).split('.').map(Number);if(octets.length!==4||octets.some(n=>!Number.isInteger(n)||n<0||n>255))return;
  value=`${value.slice(0,split)}:${((octets[0]<<8)|octets[1]).toString(16)}:${((octets[2]<<8)|octets[3]).toString(16)}`;
 }
 const pieces=value.split('::');if(pieces.length>2)return;
 const left=pieces[0]?pieces[0].split(':'):[],right=pieces.length===2&&pieces[1]?pieces[1].split(':'):[];
 if([...left,...right].some(part=>! /^[0-9a-f]{1,4}$/.test(part)))return;
 const missing=8-left.length-right.length;if((pieces.length===1&&missing!==0)||(pieces.length===2&&missing<1))return;
 return [...left.map(part=>parseInt(part,16)),...Array(missing).fill(0),...right.map(part=>parseInt(part,16))];
}
export function isPublicNetworkAddress(address){
 const family=isIP(address);
 if(family===4){
  const octets=address.split('.').map(Number);
  if(octets.length!==4||octets.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
  const a=octets[0],b=octets[1],c=octets[2];
  return !(a===0||a===10||a===127||a>223||(a===100&&b>=64&&b<=127)||(a===169&&b===254)
   ||(a===172&&b>=16&&b<=31)||(a===192&&(b===0||b===168||b===88&&c===99))
   ||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));
 }
 if(family!==6)return false;
 const words=ipv6Words(address);if(!words)return false;
 const first=words[0],second=words[1];
 return first>=0x2000&&first<=0x3fff&&!(first===0x2001&&(second<0x0200||second===0x0db8))&&first!==0x2002;
}

export function isLoopbackNetworkAddress(address){
 const family=isIP(address);
 if(family===4)return Number(address.split('.')[0])===127;
 if(family!==6)return false;
 const words=ipv6Words(address);
 if(!words)return false;
 return words.slice(0,7).every(word=>word===0)&&words[7]===1
  ||words.slice(0,5).every(word=>word===0)&&words[5]===0xffff&&(words[6]>>>8)===127;
}

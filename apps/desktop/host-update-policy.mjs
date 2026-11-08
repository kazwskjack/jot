import {createPublicKey} from 'node:crypto';
import {isAbsolute,relative,resolve,sep} from 'node:path';

const sha256Pattern=/^[a-f0-9]{64}$/;
const sequencePattern=/^[1-9][0-9]{0,19}$/;
const keyIdPattern=/^[A-Za-z0-9._-]{1,64}$/;
const channelPattern=/^[a-z][a-z0-9-]{0,31}$/;
const productPattern=/^[a-z][a-z0-9.-]{1,63}$/;
const architectures=new Set(['x64','arm64','ia32','arm','riscv64','ppc64','s390x']);

function record(value){return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function keys(value,expected){return record(value)&&Object.keys(value).sort().join(',')===expected.slice().sort().join(',');}
function inside(parent,child){
 const rel=relative(resolve(parent),resolve(child));
 if(rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))return true;
 if(process.platform==='win32'){
  const first=resolve(parent).toLocaleLowerCase('en-US'),second=resolve(child).toLocaleLowerCase('en-US');
  const folded=relative(first,second);
  return folded===''||(!folded.startsWith('..'+sep)&&folded!=='..'&&!isAbsolute(folded));
 }
 return false;
}
function absolutePath(value){return typeof value==='string'&&isAbsolute(value)&&resolve(value)===value;}
function disabled(reason){return Object.freeze({enabled:false,reason});}

export function loadHostUpdatePolicy(input,{platform=process.platform,arch=process.arch}={}){
 if(input===undefined||input===null)return disabled('desktop_update_host_policy_missing');
 if(!record(input))return disabled('desktop_update_host_policy_invalid');
 if(input.enabled===false)return disabled('desktop_update_host_policy_disabled');
 const expected=['enabled','product','channel','origin','pathPrefix','platform','arch','minimumSequence','trustedKeys','platformSigners','installRoot','userDataRoot','stateRoot','backupConfig'];
 const profile=Object.hasOwn(input,'profile')?input.profile:'standalone';
 if((!keys(input,expected)&&!keys(input,[...expected,'profile']))||input.enabled!==true||!['standalone','desktop-electron'].includes(profile))return disabled('desktop_update_host_policy_invalid');
 try{
  if(typeof input.product!=='string'||!productPattern.test(input.product)||typeof input.channel!=='string'||!channelPattern.test(input.channel))throw new Error();
  const origin=new URL(input.origin);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||origin.origin!==input.origin)throw new Error();
  if(typeof input.pathPrefix!=='string'||!input.pathPrefix.startsWith('/')||input.pathPrefix.startsWith('//')||input.pathPrefix.endsWith('/')||input.pathPrefix.includes('\\')||/[?#%\x00-\x1f\x7f]/.test(input.pathPrefix)||input.pathPrefix.slice(1).split('/').some(part=>!part||part==='.'||part==='..'))throw new Error();
  if(!['win32','darwin','linux'].includes(platform)||!architectures.has(arch)||input.platform!==platform||input.arch!==arch)throw new Error();
  if(typeof input.minimumSequence!=='string'||!sequencePattern.test(input.minimumSequence))throw new Error();
  if(!record(input.trustedKeys)||Object.keys(input.trustedKeys).length===0)throw new Error();
  const trustedKeys={};
  for(const [id,pem]of Object.entries(input.trustedKeys)){
   if(!keyIdPattern.test(id)||typeof pem!=='string'||pem.length>4096)throw new Error();
   const key=createPublicKey(pem);if(key.asymmetricKeyType!=='ed25519')throw new Error();trustedKeys[id]=key;
  }
  if(!record(input.platformSigners)||!Array.isArray(input.platformSigners[platform])||!input.platformSigners[platform].length)throw new Error();
  const signerSha256=[...new Set(input.platformSigners[platform])];
  if(signerSha256.some(value=>typeof value!=='string'||!sha256Pattern.test(value)))throw new Error();
  for(const name of ['installRoot','userDataRoot','stateRoot','backupConfig'])if(!absolutePath(input[name]))throw new Error();
  if(inside(input.installRoot,input.userDataRoot)||inside(input.userDataRoot,input.installRoot))throw new Error();
  if(!inside(input.installRoot,input.stateRoot)||resolve(input.installRoot)===resolve(input.stateRoot))throw new Error();
  if(profile==='desktop-electron'){
   const expectedStateRoot=resolve(input.installRoot,'.jot-state'),configuredStateRoot=resolve(input.stateRoot);
   if((platform==='win32'?expectedStateRoot.toLocaleLowerCase('en-US')!==configuredStateRoot.toLocaleLowerCase('en-US'):
    expectedStateRoot!==configuredStateRoot))throw new Error();
  }
  return Object.freeze({
   enabled:true,product:input.product,channel:input.channel,origin:origin.origin,pathPrefix:input.pathPrefix,
   platform,arch,profile,minimumSequence:input.minimumSequence,
   trustedKeys:Object.freeze(trustedKeys),allowedSignerSha256:Object.freeze(signerSha256),
   installRoot:resolve(input.installRoot),userDataRoot:resolve(input.userDataRoot),stateRoot:resolve(input.stateRoot),backupConfig:resolve(input.backupConfig)
  });
 }catch{return disabled('desktop_update_host_policy_invalid');}
}

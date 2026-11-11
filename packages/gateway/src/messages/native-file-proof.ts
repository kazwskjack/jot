import {createHmac,timingSafeEqual} from 'node:crypto';

export type NativeFileProofSource={conversationId:string;runId:string;activityId:string;resultSha:string;membersSha:string;
 memberIndex:number;path:string;openSha:string;sha256:string;size:number;asOfSeq?:string};
export type NativeFileProofPdf={sha256:string;size:number;pageCount:number};

/** The server constructs the source only after original member and complete opened-byte verification. */
export function signNativeFileProof(key:string,owner:string,source:NativeFileProofSource,pdf?:NativeFileProofPdf):string{
 if(typeof key!=='string'||key.length<16)throw Error('native_file_reference_unproven');
 const binding=[pdf?'jot-native-office-pdf/v1':'jot-native-file-source/v1',owner,
  source.conversationId,source.runId,source.activityId,source.resultSha,source.membersSha,source.memberIndex,
  source.path,source.openSha,source.sha256,source.size,source.asOfSeq??null,
  ...(pdf?[pdf.sha256,pdf.size,pdf.pageCount]:[])];
 return createHmac('sha256',key).update(JSON.stringify(binding)).digest('base64url');
}

/** Check a caller's receipt against the freshly verified source and optional retained PDF tuple. */
export function assertNativeFileProof(key:string|undefined,owner:string,source:NativeFileProofSource,proof:string,pdf?:NativeFileProofPdf){
 if(typeof key!=='string'||typeof proof!=='string'||proof.length!==43||!/^[A-Za-z0-9_-]{43}$/.test(proof))throw Error('native_file_reference_unproven');
 const expected=signNativeFileProof(key,owner,source,pdf);
 if(!timingSafeEqual(Buffer.from(proof,'ascii'),Buffer.from(expected,'ascii')))throw Error('native_file_reference_unproven');
}

/** The shared reference codec must validate this structure before owner-bound admission. */
export function assertNativeReferenceProof(key:string|undefined,owner:string,value:Record<string,unknown>){
 if(value.native_source===undefined)return;
 const native=value.native_source as {membersSha:string;memberIndex:number;openSha:string;proof:string;asOfSeq?:string};
 const file=value.file as {path:string;sha256:string;size:number};
 const source:NativeFileProofSource={conversationId:value.conversationId as string,runId:value.runId as string,
  activityId:value.activityId as string,resultSha:value.resultSha as string,membersSha:native.membersSha,
  memberIndex:native.memberIndex,path:file.path,openSha:native.openSha,sha256:file.sha256,size:file.size,
  ...(native.asOfSeq!==undefined?{asOfSeq:native.asOfSeq}:{})};
 assertNativeFileProof(key,owner,source,native.proof);
 if(value.print_view!==undefined){
  const pdf=value.print_view as NativeFileProofPdf&{proof:string};
  assertNativeFileProof(key,owner,source,pdf.proof,pdf);
 }
}

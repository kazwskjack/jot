import type {HostAdminClient} from './types';
type Request=<T=unknown>(path:string,method?:string,body?:unknown,key?:string,signal?:AbortSignal)=>Promise<T>;
type BootstrapRequest=(action:'challenge'|'redeem',body?:Record<string,string>,signal?:AbortSignal)=>Promise<unknown>;
export function createHostAdminClient(request:Request,bootstrapRequest?:BootstrapRequest):HostAdminClient;

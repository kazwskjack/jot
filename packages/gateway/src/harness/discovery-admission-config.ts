/** Discovery admission is harness-internal and explicitly opt-in. */
export function parseDiscoveryAdmissionEnabled(value:string|undefined):boolean{
 if(value===undefined||value==='false')return false;
 if(value==='true')return true;
 throw Error('discovery_admission_config_invalid');
}

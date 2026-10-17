const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** Trusted original Worker fence; validation cannot acquire or renew a lease. */
export function normalizeHostExecutionLease(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['owner','generation'].includes(key))
  ||typeof value.owner!=='string'||!ID.test(value.owner)||!Number.isSafeInteger(value.generation)||value.generation<1)throw new Error('workbench_binding_invalid');
 return Object.freeze({owner:value.owner,generation:value.generation});
}

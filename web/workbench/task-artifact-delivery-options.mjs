const failureReasons={
 notification_not_selected:'notification-not-selected',
 binding_version_unavailable:'binding-version-unavailable',
 unverified:'unverified',
 file_unsupported:'file-unsupported',
 completed_disabled:'completed-disabled',
};

export function taskArtifactDeliveryAvailability(target,draft){
 if(!target||typeof target.channel_binding_id!=='string'||!target.channel_binding_id.trim())return {available:false,reason:'file-unsupported'};
 if(!Number.isSafeInteger(target.version)||target.version<1)return {available:false,reason:failureReasons.binding_version_unavailable};
 if(!draft.channel_binding_ids?.includes(target.channel_binding_id))return {available:false,reason:failureReasons.notification_not_selected};
 if(target.status!=='verified')return {available:false,reason:failureReasons.unverified};
 if(target.channel!=='wecom')return {available:false,reason:failureReasons.file_unsupported};
 if(!draft.events?.includes('completed'))return {available:false,reason:failureReasons.completed_disabled};
 return {available:true,reason:null};
}

export function reconcileTaskArtifactDeliverySelection(selection,targets,draft){
 if(!Array.isArray(selection)||!Array.isArray(targets))return [];
 const seen=new Set(),reconciled=[];
 for(const choice of selection){
  if(!choice||typeof choice.channel_binding_id!=='string'||!Number.isSafeInteger(choice.binding_version)||choice.binding_version<1||seen.has(choice.channel_binding_id))continue;
  const target=targets.find(item=>item?.channel_binding_id===choice.channel_binding_id);
  if(!target||target.version!==choice.binding_version||!taskArtifactDeliveryAvailability(target,draft).available)continue;
  seen.add(choice.channel_binding_id);reconciled.push({channel_binding_id:choice.channel_binding_id,binding_version:choice.binding_version});
 }
 return reconciled;
}

export function updateTaskArtifactDeliverySelection(selection,targets,draft,bindingId,checked){
 const next=reconcileTaskArtifactDeliverySelection(selection,targets,draft).filter(choice=>choice.channel_binding_id!==bindingId);
 if(!checked)return next;
 const target=targets.find(item=>item?.channel_binding_id===bindingId);
 if(!target||!Number.isSafeInteger(target.version)||target.version<1||!taskArtifactDeliveryAvailability(target,draft).available)return next;
 next.push({channel_binding_id:target.channel_binding_id,binding_version:target.version});
 return next;
}

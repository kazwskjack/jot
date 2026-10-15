export function memoryRestoreReason(memory,version,currentVersion,now=Date.now()){
 if(!memory||memory.version!==currentVersion)return '当前记忆已更新，请重新加载后再恢复。';
 if(memory.status!=='active')return '这条记忆已删除或被替代，不能恢复。';
 if(memory.expires_at&&(!Number.isFinite(Date.parse(memory.expires_at))||Date.parse(memory.expires_at)<=now))return '当前记忆已过期，不能恢复。';
 if(!version||!Number.isSafeInteger(version.version)||version.version<1||version.version>=memory.version)return '请选择当前版本之前的历史版本。';
 if(version.status!=='active')return '此历史版本已删除或被替代，不能恢复。';
 if(version.expires_at&&(!Number.isFinite(Date.parse(version.expires_at))||Date.parse(version.expires_at)<=now))return '此历史版本已过期，不能恢复。';
 return '';
}
export function memoryRestoreInput(memory,version,currentVersion){
 const reason=memoryRestoreReason(memory,version,currentVersion);if(reason)throw new Error(reason);
 return {expected_version:memory.version,source_version:version.version};
}

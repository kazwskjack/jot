function validOwnerKey(ownerKey){return typeof ownerKey==='string'&&/^[a-f0-9]{64}$/.test(ownerKey);}

export function initializeBrowserProfileState(db){
  db.exec("CREATE TABLE IF NOT EXISTS browser_profile_generations(owner_key TEXT PRIMARY KEY,generation INTEGER NOT NULL CHECK(generation>=1),status TEXT NOT NULL CHECK(status IN ('active','revoked')),revoked_generation INTEGER,CHECK((status='active' AND revoked_generation IS NULL) OR (status='revoked' AND revoked_generation=generation-1)))");
}

export function browserProfileGeneration(db,ownerKey,profileExists){
  if(!validOwnerKey(ownerKey)||typeof profileExists!=='boolean')throw Error('browser_profile_generation_invalid');
  db.exec('BEGIN IMMEDIATE');
  try{
    let state=db.prepare('SELECT generation,status FROM browser_profile_generations WHERE owner_key=?').get(ownerKey);
    if(!state){if(profileExists)throw Error('browser_profile_generation_unknown');db.prepare("INSERT INTO browser_profile_generations(owner_key,generation,status) VALUES(?,1,'active')").run(ownerKey);state={generation:1,status:'active'};}
    else if(state.status!=='active')throw Error('browser_profile_revoked');
    else if(!profileExists)throw Error('browser_profile_generation_unknown');
    db.exec('COMMIT');return state.generation;
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}

export function assertBrowserProfileGeneration(db,ownerKey,generation){
  if(!validOwnerKey(ownerKey)||!Number.isSafeInteger(generation)||generation<1)throw Error('browser_profile_generation_invalid');
  const state=db.prepare('SELECT generation,status FROM browser_profile_generations WHERE owner_key=?').get(ownerKey);
  if(!state)throw Error('browser_profile_generation_unknown');
  if(state.status!=='active')throw Error('browser_profile_revoked');
  if(state.generation!==generation)throw Error('browser_profile_generation_conflict');
  return true;
}

export function revokeBrowserProfileGeneration(db,ownerKey,expectedGeneration,onRevoked){
  if(!validOwnerKey(ownerKey)||!Number.isSafeInteger(expectedGeneration)||expectedGeneration<1||expectedGeneration===Number.MAX_SAFE_INTEGER)throw Error('browser_profile_generation_invalid');
  if(onRevoked!==undefined&&typeof onRevoked!=='function')throw Error('browser_profile_generation_invalid');
  db.exec('BEGIN IMMEDIATE');
  try{
    const state=db.prepare('SELECT generation,status FROM browser_profile_generations WHERE owner_key=?').get(ownerKey);
    if(!state)throw Error('browser_profile_generation_unknown');
    if(state.status!=='active'||state.generation!==expectedGeneration)throw Error('browser_profile_generation_conflict');
    const changed=db.prepare("UPDATE browser_profile_generations SET generation=generation+1,status='revoked',revoked_generation=? WHERE owner_key=? AND generation=? AND status='active'").run(expectedGeneration,ownerKey,expectedGeneration);
    if(!changed.changes)throw Error('browser_profile_generation_conflict');
    const result={generation:expectedGeneration+1,status:'revoked'};onRevoked?.(result);db.exec('COMMIT');return result;
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}

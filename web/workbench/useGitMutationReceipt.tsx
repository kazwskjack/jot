import {useMemo} from 'react';import {taskDraftScope} from '../jot/client';import {GitCommandDraftStore} from './git-command-draft.mjs';import {useMutationReceipt} from './useMutationReceipt';
/** Optional persistence for the same receipt engine; never a native-I/O queue. */
export function useGitMutationReceipt(project:string){
 const scope=taskDraftScope(),store=useMemo(()=>new GitCommandDraftStore(()=>window.localStorage,scope,project),[scope,project]);return useMutationReceipt(store);
}

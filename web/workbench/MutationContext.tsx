import {createContext} from 'react';

export const MutationPending=createContext<(pending:boolean)=>void>(()=>{});
export const MutationPendingState=createContext(false);

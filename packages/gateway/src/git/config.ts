import type {GitRepositoryBinding} from './service.ts';
/** Operator-only reference configuration. Values never enter public metadata. */
export function gitConfiguration(env:NodeJS.ProcessEnv){
 let repositories:unknown=[];try{if(env.GENERAL_AGENT_GIT_REPOSITORIES?.trim())repositories=JSON.parse(env.GENERAL_AGENT_GIT_REPOSITORIES);}catch{throw Error('git_configuration_invalid');}
 if(!Array.isArray(repositories))throw Error('git_configuration_invalid');
 const executable=env.GENERAL_AGENT_GIT_EXECUTABLE?.trim();
 return{gitRepositories:repositories as GitRepositoryBinding[],...(executable?{gitExecutable:executable}:{})};
}

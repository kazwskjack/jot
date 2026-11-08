import {isAbsolute,join,relative,resolve,sep} from 'node:path';

function containsPath(parent,child){
 const rel=relative(resolve(parent),resolve(child));
 return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));
}

export function resolveDesktopPaths({appDataPath,appDirectory,projectRoot}={}){
 for(const [name,value] of Object.entries({appDataPath,appDirectory,projectRoot}))if(typeof value!=='string'||!isAbsolute(value))throw new Error('desktop_path_invalid:'+name);
 const app=resolve(appDirectory),userDataPath=join(resolve(appDataPath),'Jot');
 if(containsPath(app,userDataPath))throw new Error('desktop_profile_nested_in_app');
 return Object.freeze({
  appDirectory:app,
  userDataPath,
  databasePath:join(userDataPath,'jot.db'),
  filesPath:join(userDataPath,'files'),
  publicRoot:join(resolve(projectRoot),'dist'),
  preloadPath:join(app,'preload.cjs')
 });
}

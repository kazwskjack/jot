import {createHash} from 'node:crypto';
import {isBuiltin} from 'node:module';
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from 'typescript';

const adapterPath='packages/session-adapter';
const privateName=/(?:^\.env(?:\.|$)|\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|log)$)/i;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const portable=path=>path.split(sep).join('/');
function inside(root,path){
 const value=relative(root,path);
 return value!==''&&value!=='..'&&!value.startsWith('..'+sep)&&!isAbsolute(value);
}
function sourceFile(root,path){
 if(!inside(root,path)||privateName.test(path.split(sep).at(-1)))throw Error('adapter_package_source_forbidden');
 let current=path;
 while(current!==root){
  if(lstatSync(current).isSymbolicLink())throw Error('adapter_package_source_symlink');
  current=dirname(current);
 }
 if(!lstatSync(path).isFile())throw Error('adapter_package_source_not_file');
 return readFileSync(path);
}
function references(source){
 const result=[];
 function visit(node){
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)){
   result.push({value:node.moduleSpecifier.text,asset:false});
  }
  if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&ts.isStringLiteral(node.arguments[0])){
   result.push({value:node.arguments[0].text,asset:false});
  }
  if(ts.isNewExpression(node)&&node.expression.getText(source)==='URL'&&node.arguments?.length===2
   &&ts.isStringLiteral(node.arguments[0])&&node.arguments[1].getText(source)==='import.meta.url'){
   result.push({value:node.arguments[0].text,asset:true});
  }
  ts.forEachChild(node,visit);
 }
 visit(source);return result;
}
function dependency(root,file,name){
 let current=dirname(file);
 while(current===root||inside(root,current)){
  const manifest=join(current,'package.json');
  if(existsSync(manifest)){
   const value=JSON.parse(sourceFile(root,manifest));
   for(const kind of ['dependencies','optionalDependencies','peerDependencies']){
    if(value[kind]?.[name])return {kind,version:value[kind][name]};
   }
  }
  if(current===root)break;
  current=dirname(current);
 }
 throw Error('adapter_package_dependency_undeclared:'+name);
}

/** Stage source modules at their original relative locations and retain every
 * existing adapter entry path. The source checkout is never rewritten. */
export function stageAdapterPackage({sourceRoot,outputRoot}){
 const root=resolve(sourceRoot),output=resolve(outputRoot);
 if(!isAbsolute(sourceRoot)||!isAbsolute(outputRoot)||lstatSync(root).isSymbolicLink()
  ||output===root||inside(output,root))throw Error('adapter_package_paths_invalid');
 const adapter=join(root,adapterPath),manifest=JSON.parse(sourceFile(root,join(adapter,'package.json')));
 const entries=manifest.files;
 if(!Array.isArray(entries)||entries.some(file=>typeof file!=='string'||!file||file.split(/[\\/]/).some(part=>!part||part==='.'||part==='..')||isAbsolute(file)))throw Error('adapter_package_files_invalid');
 const publicFiles=[...entries];
 if(existsSync(join(adapter,'README.md')))publicFiles.push('README.md');
 const pending=publicFiles.map(file=>join(adapter,file)),files=new Map(),externals=new Map();
 for(const name of ['LICENSE','NOTICE'])if(existsSync(join(root,name)))pending.push(join(root,name));
 while(pending.length){
  const file=pending.pop();if(files.has(file))continue;
  const bytes=sourceFile(root,file);files.set(file,bytes);
  let scope=dirname(file);
  while(scope===root||inside(root,scope)){
   const boundary=join(scope,'package.json');
   if(boundary!==file&&existsSync(boundary))pending.push(boundary);
   if(scope===root)break;
   scope=dirname(scope);
  }
  if(!/\.(?:mjs|js)$/.test(file))continue;
  const source=ts.createSourceFile(file,bytes.toString('utf8'),ts.ScriptTarget.Latest,true);
  if(source.parseDiagnostics.length)throw Error('adapter_package_source_syntax');
  for(const ref of references(source)){
   if(ref.value.startsWith('.')){
    const target=fileURLToPath(new URL(ref.value,pathToFileURL(file)));
    pending.push(target);
   }else if(!ref.asset&&!isBuiltin(ref.value)){
    const name=ref.value.startsWith('@')?ref.value.split('/').slice(0,2).join('/'):ref.value.split('/')[0];
    const declared=dependency(root,file,name),prior=externals.get(name);
    if(prior&&prior.version!==declared.version)throw Error('adapter_package_dependency_conflict:'+name);
    externals.set(name,declared);
   }
  }
 }
 // Exclusive creation leaves an existing package or a concurrent builder intact.
 mkdirSync(output);
 const records=[];
 for(const [file,bytes] of [...files].sort(([a],[b])=>a.localeCompare(b))){
  const path=portable(relative(root,file)),target=join(output,'runtime',path);
  mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes,{flag:'wx'});
  records.push({path,sha256:hash(bytes)});
 }
 for(const file of publicFiles){
  const bytes=files.get(join(adapter,file)),target=join(output,file);
  mkdirSync(dirname(target),{recursive:true});
  if(file.endsWith('.js')){
   const original=ts.createSourceFile(file,bytes.toString('utf8'),ts.ScriptTarget.Latest,true);
   const hasDefault=original.statements.some(node=>ts.isExportAssignment(node)&&!node.isExportEquals||node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.DefaultKeyword)
    ||ts.isExportDeclaration(node)&&node.exportClause&&ts.isNamedExports(node.exportClause)&&node.exportClause.elements.some(value=>value.name.text==='default'));
   const destination='./runtime/'+adapterPath+'/'+file;
   writeFileSync(target,`export * from ${JSON.stringify(destination)};\n`+(hasDefault?`export {default} from ${JSON.stringify(destination)};\n`:''),{flag:'wx'});
  }else writeFileSync(target,bytes,{flag:'wx'});
 }
 for(const name of ['LICENSE','NOTICE'])if(files.has(join(root,name)))writeFileSync(join(output,name),files.get(join(root,name)),{flag:'wx'});
 for(const [name,{kind,version}] of externals){
  if(manifest.peerDependencies?.[name])continue;
  const field=kind==='optionalDependencies'?'optionalDependencies':'dependencies';
  manifest[field]={...manifest[field],[name]:version};
 }
 manifest.files=[...publicFiles,...['LICENSE','NOTICE'].filter(name=>files.has(join(root,name))),'runtime','runtime-source-manifest.json'];
 writeFileSync(join(output,'package.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 writeFileSync(join(output,'runtime-source-manifest.json'),JSON.stringify({protocol:1,files:records},null,2)+'\n',{flag:'wx'});
 return output;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const sourceRoot=fileURLToPath(new URL('../../..',import.meta.url)),outputRoot=process.argv[2];
 if(!outputRoot)throw Error('adapter_package_output_required');
 process.stdout.write(stageAdapterPackage({sourceRoot,outputRoot})+'\n');
}

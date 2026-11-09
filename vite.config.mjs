import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {readdirSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('./web/',import.meta.url)),plugins:[react(),{name:'jot-pdfjs-assets',generateBundle(){
 const root=dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
 for(const name of readdirSync(root).filter(name=>name==='LICENSE'||name==='NOTICE'))this.emitFile({type:'asset',fileName:`assets/pdfjs/6.1.200/${name}`,source:readFileSync(join(root,name))});
 for(const directory of ['cmaps','standard_fonts','wasm']){
  for(const entry of readdirSync(join(root,directory),{withFileTypes:true})){
   if(entry.isFile())this.emitFile({type:'asset',fileName:`assets/pdfjs/6.1.200/${directory}/${entry.name}`,source:readFileSync(join(root,directory,entry.name))});
  }
 }
}}],base:'./',build:{outDir:'../dist',emptyOutDir:true,rolldownOptions:{input:{main:fileURLToPath(new URL('./web/index.html',import.meta.url)),workbench:fileURLToPath(new URL('./web/workbench.html',import.meta.url))}}}});

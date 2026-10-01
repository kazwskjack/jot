import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('./web/',import.meta.url)),plugins:[react()],base:'./',build:{outDir:'../dist',emptyOutDir:true}});

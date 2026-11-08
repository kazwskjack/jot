import assert from 'node:assert/strict';
import test from 'node:test';
import Module,{createRequire} from 'node:module';
import {readdir,readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const projectRequire=createRequire(import.meta.url);
const React=projectRequire('react');
const {renderToStaticMarkup}=projectRequire('react-dom/server');
const {build}=projectRequire('esbuild');
const nodeModules=dirname(dirname(projectRequire.resolve('react')));
const bundlePath=join(projectRoot,'web/jot/__twemoji_markdown_test__.cjs');
const bundle=await build({
 stdin:{contents:"export {default} from './web/jot/TwemojiMarkdown.tsx';",resolveDir:projectRoot,loader:'tsx'},
 bundle:true,write:false,platform:'node',format:'cjs',outfile:bundlePath,
 external:['react','react/jsx-runtime'],nodePaths:[nodeModules],logLevel:'silent',
});
const bundledModule=new Module(bundlePath);
bundledModule.filename=bundlePath;
bundledModule.paths=[nodeModules,...Module._nodeModulePaths(projectRoot)];
bundledModule._compile(bundle.outputFiles[0].text,bundlePath);
const TwemojiMarkdown=bundledModule.exports.default;
const render=value=>renderToStaticMarkup(React.createElement(TwemojiMarkdown,{children:value}));

test('inline emoji sequences keep selectable Unicode text and render local decorative Twemoji SVGs',()=>{
 const html=render('Hi 😊, ❤️, 👩🏽‍💻, 🇭🇰. Unknown: \u{10FFFF}');
 for(const emoji of ['😊','❤️','👩🏽‍💻','🇭🇰']){
  assert.ok(html.includes(`<span class="jot-twemoji-source">${emoji}</span>`),emoji);
  assert.match(html,new RegExp(`<img src="\\.\\/twemoji\\/svg\\/[^\"]+\\.svg" alt="${emoji}" class="jot-twemoji-image" aria-hidden="true"`));
 }
 assert.match(html,/src="\.\/twemoji\/svg\/1f60a\.svg"/);
 assert.match(html,/src="\.\/twemoji\/svg\/2764\.svg"/);
 assert.match(html,/src="\.\/twemoji\/svg\/1f469-1f3fd-200d-1f4bb\.svg"/);
 assert.match(html,/src="\.\/twemoji\/svg\/1f1ed-1f1f0\.svg"/);
 assert.ok(html.includes('\u{10FFFF}'));
});

test('emoji text and decorative image occupy one atomic inline box',async()=>{
 const html=render('left😊right');
 assert.equal(html,'<p>left<span class="jot-twemoji"><span class="jot-twemoji-source">😊</span><img src="./twemoji/svg/1f60a.svg" alt="😊" class="jot-twemoji-image" aria-hidden="true" draggable="false" loading="lazy" decoding="async"/></span>right</p>');
 const css=await readFile(join(projectRoot,'web/style.css'),'utf8');
 assert.match(css,/\.jot-twemoji\{[^}]*display:inline-block[^}]*position:relative[^}]*width:1em/);
 assert.match(css,/\.jot-twemoji-image\{[^}]*position:absolute[^}]*inset:0[^}]*pointer-events:none[^}]*user-select:none/);
});

test('Markdown links, image URLs, inline code and fenced code keep their original content',()=>{
 const html=render('[Open](https://example.test/?emoji=smile) ![picture](https://example.test/p.png?size=1) `😊`\n\n```text\n😊\n```');
 assert.match(html,/href="https:\/\/example\.test\/\?emoji=smile"/);
 assert.match(html,/src="https:\/\/example\.test\/p\.png\?size=1"/);
 assert.match(html,/<code>😊<\/code>/);
 assert.match(html,/<pre><code class="language-text">😊\n<\/code><\/pre>/);
 assert.doesNotMatch(html,/<(?:code|pre)[^>]*>[^]*?<img/);
});

test('standalone Work/Chat and the DSH-backed RoleConversation use the shared renderer',async()=>{
 const standalone=await readFile(join(projectRoot,'web/main.tsx'),'utf8');
 const role=await readFile(join(projectRoot,'web/jot/RoleConversation.tsx'),'utf8');
 const mount=await readFile(join(projectRoot,'web/workbench-entry.tsx'),'utf8');
 assert.match(standalone,/import TwemojiMarkdown from '\.\/jot\/TwemojiMarkdown'/);
 assert.equal((standalone.match(/<TwemojiMarkdown>/g)||[]).length,2);
 assert.match(role,/import TwemojiMarkdown from '\.\/TwemojiMarkdown'/);
 assert.match(role,/<TwemojiMarkdown key=\{block\.block_id\}>\{block\.text\}<\/TwemojiMarkdown>/);
 assert.match(mount,/<RoleConversation ordinary=/);
});

test('the local Twemoji bundle contains all 4,009 v17.0.3 SVG files and sizes them inline',async()=>{
 const names=await readdir(join(projectRoot,'web/public/twemoji/svg'));
 assert.equal(names.filter(name=>name.endsWith('.svg')).length,4009);
 for(const name of ['1f60a.svg','2764.svg','1f469-1f3fd-200d-1f4bb.svg','1f1ed-1f1f0.svg'])assert.ok(names.includes(name),name);
 const css=await readFile(join(projectRoot,'web/style.css'),'utf8');
 assert.match(css,/\.jot-twemoji\{[^}]*display:inline-block[^}]*position:relative[^}]*width:1em[^}]*height:1em/);
 assert.match(css,/\.jot-twemoji-source\{[^}]*width:1em[^}]*height:1em[^}]*color:transparent[^}]*user-select:text/);
 assert.match(css,/\.jot-twemoji-image\{[^}]*position:absolute[^}]*inset:0[^}]*width:100%[^}]*height:100%[^}]*user-select:none/);
});

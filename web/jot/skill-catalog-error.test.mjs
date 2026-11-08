import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

let compiled;
const outputRoot = await mkdtemp(join(process.cwd(), '.test-tmp', 'm1604-error-ui-'));
test.after(() => rm(outputRoot, { recursive: true, force: true }));
async function ui() {
  if (!compiled) {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const outfile = join(outputRoot, 'harness.cjs');
    await build({
      stdin: { contents: `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {SkillCatalogView,skillResourceErrorMessage} from './web/jot/SkillCatalogPanel.tsx';export {skillResourceErrorMessage};export const render=error=>renderToStaticMarkup(<SkillCatalogView value={{complete:true,items:[{name:'notes',description:'Notes',source:'user-dsh',provider:'filesystem',invocation:{userInvocable:true,modelInvocable:true}}],viewScope:{workspace_id:'workspace',project_id:'project',agent_id:'role'}}} paths={{notes:'references/help.md'}} resources={{notes:{error}}} onPathChange={()=>{}} onReadResource={()=>{}} onUseSkill={()=>{}}/>);`, resolveDir: root, loader: 'tsx' },
      bundle: true, write: true, outfile, platform: 'node', format: 'cjs', jsx: 'automatic',
    });
    compiled = createRequire(import.meta.url)(outfile);
  }
  return compiled;
}

test('selected-resource service errors render their supplied diagnosis instead of blaming the path', async () => {
  const m = await ui();
  assert.equal(m.skillResourceErrorMessage(new Error('SKILL_CATALOG_NOT_FOUND')), '找不到该技能或相对路径，请检查输入后重试。');
  assert.equal(m.skillResourceErrorMessage(new Error('SKILL_CATALOG_INPUT_INVALID')), '技能资源路径或响应无效，请检查相对路径格式。');
  assert.equal(m.skillResourceErrorMessage(new Error('SKILL_CATALOG_CHANGED')), '技能目录或会话权限已变化，请刷新目录后重试。');
  assert.equal(m.skillResourceErrorMessage(new Error('SKILL_RESOURCE_TOO_LARGE')), '所选资源超过可读取大小限制。');
  assert.equal(m.skillResourceErrorMessage(new Error('SKILL_CATALOG_UNAVAILABLE')), '技能资源服务或网络暂时不可用，请稍后重试。');
  assert.equal(m.skillResourceErrorMessage(new TypeError('Failed to fetch')), '技能资源服务或网络暂时不可用，请稍后重试。');
  assert.equal(m.skillResourceErrorMessage(new Error('unknown')), '技能资源读取失败，请重试；如果仍失败，请刷新技能目录。');
  const html = m.render(m.skillResourceErrorMessage(new Error('SKILL_CATALOG_UNAVAILABLE')));
  assert.match(html, /技能资源服务或网络暂时不可用，请稍后重试/);
  assert.doesNotMatch(html, /检查相对路径/);
});

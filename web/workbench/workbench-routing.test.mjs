import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('./Workbench.tsx',import.meta.url),'utf8');

test('lazy workbench panels remount when the selected view changes',()=>{
 for(const loader of ['loadGit','loadAgents','loadTasks','loadTeams','loadSharedWorkspace'])
  assert.match(source,new RegExp(`<RetryablePanel key=\\{view\\} load=\\{${loader}\\}`),`${loader} must not inherit the previous view loader`);
});

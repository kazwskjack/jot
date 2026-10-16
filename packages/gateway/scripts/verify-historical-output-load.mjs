// Explicit opt-in synthetic load measurement. No production endpoints or model calls.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const result=spawnSync(process.execPath,['--test','--test-name-pattern=large output publication measurement','test/harness/ordinary-final-publication.test.mjs'],{
 cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,JOT_HISTORICAL_OUTPUT_LOAD:'true'},stdio:'inherit',windowsHide:true,
});
if(result.error){console.error('Synthetic output measurement could not start.');process.exitCode=1;}
else process.exitCode=result.status??1;

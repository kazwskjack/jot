import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {patchDshPreSetupSource} from '../dsh-pre-setup-patch.js';

const preparationModule = await import('../scripts/prepare-dsh-pre-setup.mjs').catch(() => undefined);
const prepareDshPreSetupRuntime = preparationModule?.prepareDshPreSetupRuntime;

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const testTempRoot = resolve(workspaceRoot, '.test-tmp');
const scriptPath = fileURLToPath(new URL('../scripts/prepare-dsh-pre-setup.mjs', import.meta.url));
const runtimeModules = process.env.JOT_DSH_RUNTIME_MODULES;
const sourcePackage = runtimeModules ? join(runtimeModules, 'dsh-agent-loop') : undefined;

function createTestRoot(t) {
  mkdirSync(testTempRoot, {recursive: true});
  const root = mkdtempSync(join(testTempRoot, 'prepare-dsh-pre-setup-'));
  const canonicalBase = resolve(testTempRoot);
  const canonicalRoot = resolve(root);
  const relativeRoot = relative(canonicalBase, canonicalRoot);
  const baseInfo = lstatSync(canonicalBase);
  const rootInfo = lstatSync(canonicalRoot);
  assert.ok(baseInfo.isDirectory() && !baseInfo.isSymbolicLink());
  assert.ok(relativeRoot && !isAbsolute(relativeRoot) && relativeRoot !== '..' && !relativeRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
  assert.equal(dirname(canonicalRoot), canonicalBase);
  assert.ok(basename(canonicalRoot).startsWith('prepare-dsh-pre-setup-'));
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
  t.after(() => {
    const cleanupRoot = resolve(root);
    const cleanupRelative = relative(canonicalBase, cleanupRoot);
    const cleanupInfo = lstatSync(cleanupRoot);
    assert.ok(cleanupRelative && !isAbsolute(cleanupRelative) && cleanupRelative !== '..' && !cleanupRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
    assert.equal(dirname(cleanupRoot), canonicalBase);
    assert.ok(basename(cleanupRoot).startsWith('prepare-dsh-pre-setup-'));
    assert.ok(cleanupInfo.isDirectory() && !cleanupInfo.isSymbolicLink());
    rmSync(cleanupRoot, {recursive: true, force: false});
  });
  return root;
}

function listFiles(root, relativeRoot = '') {
  const output = [];
  for (const entry of readdirSync(join(root, relativeRoot), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`unexpected symlink in test fixture: ${rel}`);
    if (entry.isDirectory()) output.push(...listFiles(root, rel));
    else if (entry.isFile()) output.push(rel);
    else throw new Error(`unexpected non-file in test fixture: ${rel}`);
  }
  return output;
}

function hashTree(root) {
  const hash = createHash('sha256');
  for (const rel of listFiles(root)) hash.update(rel.replaceAll('\\', '/')).update('\0').update(readFileSync(join(root, rel))).update('\0');
  return hash.digest('hex');
}

function copySdkFixture(destination) {
  mkdirSync(destination);
  cpSync(join(sourcePackage, 'lib'), join(destination, 'lib'), {recursive: true});
  for (const name of readdirSync(sourcePackage)) {
    if (name === 'package.json' || name === 'LICENSE' || /^README(?:[.-].*)?$/i.test(name)) {
      const sourcePath = join(sourcePackage, name);
      assert.ok(lstatSync(sourcePath).isFile(), `expected fixture file: ${name}`);
      copyFileSync(sourcePath, join(destination, name));
    }
  }
}

function assertCode(action, expectedCode) {
  assert.throws(action, error => error instanceof Error && error.message === expectedCode);
}

function requirePreparationFunction() {
  assert.equal(typeof prepareDshPreSetupRuntime, 'function', 'prepareDshPreSetupRuntime must be exported');
}

test('prepares a fully patched package in a new directory without modifying the installed source', {skip: !sourcePackage}, t => {
  requirePreparationFunction();
  const root = createTestRoot(t);
  const outputParent = join(root, 'output');
  const outputPackage = join(outputParent, 'dsh-agent-loop');
  mkdirSync(outputParent);
  const sourceHash = hashTree(sourcePackage);
  const sourceManifest = JSON.parse(readFileSync(join(sourcePackage, 'package.json'), 'utf8'));
  const sourceRuntime = readFileSync(join(sourcePackage, 'lib/index.js'), 'utf8');
  const sourceDeclarations = readFileSync(join(sourcePackage, 'lib/types/index.d.ts'), 'utf8');
  const patch = patchDshPreSetupSource({
    version: sourceManifest.version,
    runtimeSource: sourceRuntime,
    declarationSource: sourceDeclarations,
  });

  const result = prepareDshPreSetupRuntime(sourcePackage, outputPackage);

  assert.deepEqual(result, {protocol: 2, upstreamVersion: '0.2.0-rc.2'});
  assert.equal(hashTree(sourcePackage), sourceHash);
  const outputManifest = JSON.parse(readFileSync(join(outputPackage, 'package.json'), 'utf8'));
  assert.equal(outputManifest.name, '@deepseek-ai/dsh-agent-loop');
  assert.equal(outputManifest.version, '0.2.0-rc.2');
  assert.deepEqual(outputManifest.jotCompatibilityPatch, {protocol: 2, upstreamVersion: '0.2.0-rc.2'});
  assert.equal(readFileSync(join(outputPackage, 'lib/index.js'), 'utf8'), patch.runtimeSource);
  assert.equal(readFileSync(join(outputPackage, 'lib/types/index.d.ts'), 'utf8'), patch.declarationSource);

  const expectedFiles = listFiles(sourcePackage).filter(name => name === 'package.json' || name === 'LICENSE' || name.startsWith('README') || name.startsWith(`lib${process.platform === 'win32' ? '\\' : '/'}`)).sort();
  assert.deepEqual(listFiles(outputPackage).sort(), expectedFiles);
});

test('refuses to overwrite any existing output package', {skip: !sourcePackage}, t => {
  requirePreparationFunction();
  const root = createTestRoot(t);
  const outputPackage = join(root, 'existing');
  mkdirSync(outputPackage);
  writeFileSync(join(outputPackage, 'sentinel.txt'), 'preserve');

  assertCode(() => prepareDshPreSetupRuntime(sourcePackage, outputPackage), 'dsh_pre_setup_output_exists');
  assert.equal(readFileSync(join(outputPackage, 'sentinel.txt'), 'utf8'), 'preserve');
});

test('rejects output paths nested in the source package before writing', {skip: !sourcePackage}, t => {
  requirePreparationFunction();
  const root = createTestRoot(t);
  const outputPackage = join(sourcePackage, `.jot-pre-setup-test-${process.pid}`);

  assertCode(() => prepareDshPreSetupRuntime(sourcePackage, outputPackage), 'dsh_pre_setup_path_overlap');
  assert.equal(existsSync(outputPackage), false);
});

test('rejects a path that only overlaps the source after resolving a directory symlink', {skip: !sourcePackage}, t => {
  requirePreparationFunction();
  const root = createTestRoot(t);
  const alias = join(root, 'source-alias');
  try {
    symlinkSync(sourcePackage, alias, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error?.code)) return t.skip('directory symlink creation is unavailable');
    throw error;
  }
  const outputPackage = join(alias, 'prepared');

  assertCode(() => prepareDshPreSetupRuntime(sourcePackage, outputPackage), 'dsh_pre_setup_path_overlap');
  assert.equal(existsSync(outputPackage), false);
});

test('rejects unsupported package versions and modified upstream files before creating output', {skip: !sourcePackage}, t => {
  requirePreparationFunction();
  const root = createTestRoot(t);
  const badVersion = join(root, 'bad-version');
  const badHash = join(root, 'bad-hash');
  const versionOutput = join(root, 'bad-version-output');
  const hashOutput = join(root, 'bad-hash-output');
  copySdkFixture(badVersion);
  copySdkFixture(badHash);

  const manifestPath = join(badVersion, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = '0.2.0-rc.3';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(badHash, 'lib/index.js'), `${readFileSync(join(badHash, 'lib/index.js'), 'utf8')}\n// changed fixture\n`);

  assertCode(() => prepareDshPreSetupRuntime(badVersion, versionOutput), 'dsh_pre_setup_package_version');
  assertCode(() => prepareDshPreSetupRuntime(badHash, hashOutput), 'dsh_pre_setup_patch_source_changed');
  assert.equal(existsSync(versionOutput), false);
  assert.equal(existsSync(hashOutput), false);
});

test('CLI requires exactly two explicit paths and prints only fixed usage text otherwise', () => {
  assert.equal(existsSync(scriptPath), true, 'prepare-dsh-pre-setup.mjs must exist');
  for (const args of [[], ['source'], ['source', 'output', 'extra']]) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], {cwd: workspaceRoot, encoding: 'utf8'});
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Usage: node prepare-dsh-pre-setup.mjs <source-package> <output-package>\n');
  }
});

test('rejects secondary runtime and manifest drift even when patch anchors match', {skip: !sourcePackage}, t => {
 const root=createTestRoot(t);
 for(const name of ['secondary','manifest']){
  const source=join(root,name),output=join(root,name+'-out');copySdkFixture(source);
  const path=join(source,name==='secondary'?'lib/invariant.js':'package.json');
  if(name==='secondary')writeFileSync(path,readFileSync(path,'utf8')+'\n// drift\n');
  else{const manifest=JSON.parse(readFileSync(path,'utf8'));manifest.main='lib/invariant.js';writeFileSync(path,JSON.stringify(manifest));}
  assertCode(()=>prepareDshPreSetupRuntime(source,output),'dsh_pre_setup_package_integrity');assert.equal(existsSync(output),false);
 }
});

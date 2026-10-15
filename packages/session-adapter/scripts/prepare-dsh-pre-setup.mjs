import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {patchDshPreSetupSource} from '../dsh-pre-setup-patch.js';

const packageName = '@deepseek-ai/dsh-agent-loop';
const supportedVersion = '0.2.0-rc.2';
const stagingPrefix = '.jot-dsh-pre-setup-';

function fail(code) {
  throw new Error(code);
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    fail('dsh_pre_setup_path_unavailable');
  }
}

function canonicalSourcePath(sourcePackage) {
  if (typeof sourcePackage !== 'string' || !sourcePackage.trim()) fail('dsh_pre_setup_source_path');
  let canonical;
  try {
    canonical = realpathSync(resolve(sourcePackage));
    if (!statSync(canonical).isDirectory()) fail('dsh_pre_setup_source_path');
  } catch (error) {
    if (error?.message?.startsWith('dsh_pre_setup_')) throw error;
    fail('dsh_pre_setup_source_path');
  }
  return canonical;
}

function canonicalNewOutputPath(outputPackage) {
  if (typeof outputPackage !== 'string' || !outputPackage.trim()) fail('dsh_pre_setup_output_path');
  const output = resolve(outputPackage);
  if (lstatIfPresent(output)) fail('dsh_pre_setup_output_exists');

  const outputParent = dirname(output);
  let parentInfo;
  let canonicalParent;
  try {
    parentInfo = statSync(outputParent);
    canonicalParent = realpathSync(outputParent);
  } catch {
    fail('dsh_pre_setup_output_parent');
  }
  if (!parentInfo.isDirectory()) fail('dsh_pre_setup_output_parent');
  return join(canonicalParent, basename(output));
}

function readRegularFile(path, code) {
  let details;
  try {
    details = lstatSync(path);
  } catch {
    fail(code);
  }
  if (!details.isFile() || details.isSymbolicLink()) fail(code);
  try {
    return readFileSync(path);
  } catch {
    fail(code);
  }
}

function readLibFiles(packageRoot) {
  const libRoot = join(packageRoot, 'lib');
  let libInfo;
  try {
    libInfo = lstatSync(libRoot);
  } catch {
    fail('dsh_pre_setup_package_lib');
  }
  if (!libInfo.isDirectory() || libInfo.isSymbolicLink()) fail('dsh_pre_setup_package_lib');

  const files = new Map();
  function visit(directory, relativeDirectory) {
    let entries;
    try {
      entries = readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      fail('dsh_pre_setup_package_lib');
    }
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) fail('dsh_pre_setup_package_symlink');
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isFile()) files.set(relativePath, readRegularFile(absolutePath, 'dsh_pre_setup_package_lib'));
      else fail('dsh_pre_setup_package_lib');
    }
  }
  visit(libRoot, 'lib');
  return files;
}

function collectPackageFiles(packageRoot) {
  const manifestBytes = readRegularFile(join(packageRoot, 'package.json'), 'dsh_pre_setup_package_manifest');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('dsh_pre_setup_package_manifest');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('dsh_pre_setup_package_manifest');
  if (manifest.name !== packageName) fail('dsh_pre_setup_package_name');
  if (manifest.version !== supportedVersion) fail('dsh_pre_setup_package_version');

  const files = readLibFiles(packageRoot);
  const runtimePath = join('lib', 'index.js');
  const declarationsPath = join('lib', 'types', 'index.d.ts');
  const runtimeSource = files.get(runtimePath)?.toString('utf8');
  const declarationSource = files.get(declarationsPath)?.toString('utf8');
  if (typeof runtimeSource !== 'string' || typeof declarationSource !== 'string') fail('dsh_pre_setup_package_patch_files');

  let patch;
  try {
    patch = patchDshPreSetupSource({version: manifest.version, runtimeSource, declarationSource});
  } catch (error) {
    if (error instanceof Error && /^dsh_pre_setup_[a-z0-9_]+$/.test(error.message)) throw error;
    fail('dsh_pre_setup_patch_failed');
  }
  files.set(runtimePath, Buffer.from(patch.runtimeSource, 'utf8'));
  files.set(declarationsPath, Buffer.from(patch.declarationSource, 'utf8'));

  files.set('package.json', Buffer.from(`${JSON.stringify({
    ...manifest,
    jotCompatibilityPatch: {protocol: 2, upstreamVersion: manifest.version},
  }, null, 2)}\n`, 'utf8'));
  files.set('LICENSE', readRegularFile(join(packageRoot, 'LICENSE'), 'dsh_pre_setup_package_license'));

  let entries;
  try {
    entries = readdirSync(packageRoot, {withFileTypes: true});
  } catch {
    fail('dsh_pre_setup_source_path');
  }
  for (const entry of entries) {
    if (!/^README(?:[.-].*)?$/i.test(entry.name)) continue;
    if (entry.isSymbolicLink()) fail('dsh_pre_setup_package_symlink');
    if (entry.isFile()) files.set(entry.name, readRegularFile(join(packageRoot, entry.name), 'dsh_pre_setup_package_readme'));
  }
  // Verify every byte copied from the reviewed installed package, including
  // secondary entry points, declarations, source maps, manifest and license.
  const upstream = new Map(files);
  upstream.set(runtimePath, Buffer.from(runtimeSource));
  upstream.set(declarationsPath, Buffer.from(declarationSource));
  upstream.set('package.json', manifestBytes);
  const actual = Object.fromEntries([...upstream].map(([path, bytes]) =>
    [path.replaceAll('\\', '/'), createHash('sha256').update(bytes).digest('hex')]).sort(([a],[b]) => a.localeCompare(b)));
  const expected = JSON.parse(readFileSync(new URL('../runtime-patches/dsh-agent-loop-rc2-sha256.json', import.meta.url), 'utf8'));
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort())
    || Object.entries(actual).some(([path, hash]) => expected[path] !== hash)) fail('dsh_pre_setup_package_integrity');
  return files;
}

function cleanupStagingDirectory(stagingDirectory, expectedParent) {
  try {
    const canonicalStage = realpathSync(stagingDirectory);
    const canonicalParent = realpathSync(expectedParent);
    const details = lstatSync(canonicalStage);
    if (dirname(canonicalStage) !== canonicalParent || !basename(canonicalStage).startsWith(stagingPrefix) || !details.isDirectory() || details.isSymbolicLink()) return;
    rmSync(canonicalStage, {recursive: true, force: false});
  } catch {
    // A failed cleanup is safer to leave for inspection than to broaden the deletion target.
  }
}

function writePreparedPackage(files, outputPackage) {
  const outputParent = dirname(outputPackage);
  const expectedParent = realpathSync(outputParent);
  let stagingDirectory;
  try {
    stagingDirectory = mkdtempSync(join(expectedParent, stagingPrefix));
    for (const [relativePath, contents] of files) {
      const target = join(stagingDirectory, relativePath);
      mkdirSync(dirname(target), {recursive: true});
      writeFileSync(target, contents, {flag: 'wx'});
    }

    if (lstatIfPresent(outputPackage)) fail('dsh_pre_setup_output_exists');
    if (realpathSync(outputParent) !== expectedParent) fail('dsh_pre_setup_output_parent_changed');
    renameSync(stagingDirectory, outputPackage);
    stagingDirectory = undefined;
  } catch (error) {
    if (stagingDirectory) cleanupStagingDirectory(stagingDirectory, expectedParent);
    if (error instanceof Error && /^dsh_pre_setup_[a-z0-9_]+$/.test(error.message)) throw error;
    fail('dsh_pre_setup_write_failed');
  }
}

/** Copy the exact supported DSH package into a new, isolated compatibility package. */
export function prepareDshPreSetupRuntime(sourcePackage, outputPackage) {
  const canonicalSource = canonicalSourcePath(sourcePackage);
  const canonicalOutput = canonicalNewOutputPath(outputPackage);
  if (pathsOverlap(canonicalSource, canonicalOutput)) fail('dsh_pre_setup_path_overlap');

  // Read, validate, and patch the complete permitted file set before creating anything.
  const files = collectPackageFiles(canonicalSource);
  writePreparedPackage(files, canonicalOutput);
  return Object.freeze({protocol: 2, upstreamVersion: supportedVersion});
}

function cli() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write('Usage: node prepare-dsh-pre-setup.mjs <source-package> <output-package>\n');
    process.exitCode = 2;
    return;
  }
  try {
    prepareDshPreSetupRuntime(args[0], args[1]);
    process.stdout.write('Prepared DSH rc.2 compatibility package (protocol 2).\n');
  } catch (error) {
    const code = error instanceof Error && /^dsh_pre_setup_[a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'dsh_pre_setup_failed';
    process.stderr.write(`Unable to prepare DSH compatibility package (${code}).\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli();

// Optional compatibility delta for separately installed MIT-licensed DSH.
// Copyright (c) 2026 DeepSeek. See runtime-patches/DSH-MIT-LICENSE.txt.
import {createHash} from 'node:crypto';

const runtimeSha = '8d64d2e8a5310b442ae66bc0daf7d6957ec095dbe43cabd9eb208f7370e381ed';
const declarationSha = 'b59b1a56faaac67c7caa0bceb1ddb9e64c065a526cafb1e7a37ef1a770a99ce6';
const original = '\t\treturn await spillStore.saveText(save);';
const replacement = [
  '\t\tconst saved = await spillStore.saveText(save);',
  '\t\t// Jot optional host-only source capture after the original save succeeds.',
  '\t\ttry {',
  '\t\t\tconst observer = ctx.get("jotNativeSearchSourceObserver", false);',
  '\t\t\tif (observer?.protocol === 1) await observer.capture(exec, save, saved);',
  '\t\t} catch {',
  '\t\t\tctx.logger.warn("tool-fs-search: Jot source capture unavailable");',
  '\t\t}',
  '\t\treturn saved;',
].join('\n');
const sha = source => createHash('sha256').update(source).digest('hex');

/** Transform only the reviewed native producer, preserving its spill semantics. */
export function patchDshNativeSearchSource({version, runtimeSource, declarationSource} = {}) {
  if (version !== '0.2.1-rc.2' || typeof runtimeSource !== 'string' || typeof declarationSource !== 'string')
    throw Error('dsh_pre_setup_search_version');
  const patched = runtimeSource.includes(replacement);
  const source = patched ? runtimeSource.replace(replacement, original) : runtimeSource;
  if (sha(source) !== runtimeSha || sha(declarationSource) !== declarationSha)
    throw Error('dsh_pre_setup_search_source_changed');
  if (source.split(original).length !== 2) throw Error('dsh_pre_setup_search_anchor');
  return Object.freeze({changed: !patched, protocol: 1, runtimeSource: patched ? runtimeSource : source.replace(original, replacement), declarationSource});
}

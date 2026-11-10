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
const memberHelper = "async function jotCaptureNativeSearchMembers(ctx, exec, value, content) {\n\tif (exec.agent === void 0) return;\n\ttry {\n\t\tconst observer = ctx.get(\"jotNativeSearchSourceObserver\", false);\n\t\tif (observer?.protocol === 1 && typeof observer.captureMembers === \"function\") await observer.captureMembers(exec, value, content);\n\t} catch {\n\t\tctx.logger.warn(\"tool-fs-search: Jot member capture unavailable\");\n\t}\n}\n";
const helperAnchor = "async function trySaveFormattedResult(ctx, exec, suggestedName, content) {";
const memberDeltas = [
  ["\tconst workdir = exec.agent === void 0 ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal);",
   "\tconst workdir = exec.agent === void 0 ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal);\n\ttry {\n\t\tconst observer = ctx.get(\"jotNativeSearchSourceObserver\", false);\n\t\tif (observer?.protocol === 1 && typeof observer.observeRun === \"function\") observer.observeRun(exec, workdir);\n\t} catch {\n\t\tctx.logger.warn(\"tool-fs-search: Jot run capture unavailable\");\n\t}"],
  ["\t\tif (paths.length <= caps.maxResults) return decision;",
   "\t\tif (paths.length <= caps.maxResults) {\n\t\t\tawait jotCaptureNativeSearchMembers(ctx, exec, value, [{ type: \"text\", text: renderGlobPaths(paths, caps, value.root) }]);\n\t\t\treturn decision;\n\t\t}"],
  ["\t\tif (matches.length <= caps.maxMatches) return decision;",
   "\t\tif (matches.length <= caps.maxMatches) {\n\t\t\tawait jotCaptureNativeSearchMembers(ctx, exec, value, [{ type: \"text\", text: formatRetainedGrep(retainGrepMatches(matches, caps.maxMatches, caps.maxLineBytes)) }]);\n\t\t\treturn decision;\n\t\t}"],
  ["\t\tconst spillRef = await trySaveFormattedResult(ctx, exec, \"glob-results.txt\", paths.join(\"\\n\"));",
   "\t\tconst spillRef = await trySaveFormattedResult(ctx, exec, \"glob-results.txt\", paths.join(\"\\n\"));\n\t\tawait jotCaptureNativeSearchMembers(ctx, exec, value, [{ type: \"text\", text: renderGlobPaths(paths, caps, value.root, spillRef) }]);"],
  ["\t\tconst spillRef = await trySaveFormattedResult(ctx, exec, \"grep-results.txt\", `Found ${matches.length} ${matchNoun(matches.length)}\\n\\n${formatGrepMatches(previewedAll)}`);",
   "\t\tconst spillRef = await trySaveFormattedResult(ctx, exec, \"grep-results.txt\", `Found ${matches.length} ${matchNoun(matches.length)}\\n\\n${formatGrepMatches(previewedAll)}`);\n\t\tawait jotCaptureNativeSearchMembers(ctx, exec, value, [{ type: \"text\", text: formatRetainedGrep(retainGrepMatches(matches, caps.maxMatches, caps.maxLineBytes), spillRef) }]);"],
 ];
const sha = source => createHash('sha256').update(source).digest('hex');
function once(source,before,after) {
  if (source.split(before).length !== 2) throw Error('dsh_pre_setup_search_anchor');
  return source.replace(before,after);
}

/** Upgrade the reviewed original or complete legacy delta to the complete current delta. */
export function patchDshNativeSearchSource({version, runtimeSource, declarationSource} = {}) {
  if (version !== '0.2.1-rc.2' || typeof runtimeSource !== 'string' || typeof declarationSource !== 'string')
    throw Error('dsh_pre_setup_search_version');
  const saved = runtimeSource.includes(replacement), members = runtimeSource.includes(memberHelper);
  let source = runtimeSource;
  if (members) {
    source = once(source,memberHelper+helperAnchor,helperAnchor);
    for (const [before,after] of memberDeltas) source = once(source,after,before);
  }
  if (saved) source = once(source,replacement,original);
  if (sha(source) !== runtimeSha || sha(declarationSource) !== declarationSha)
    throw Error('dsh_pre_setup_search_source_changed');
  if (saved && members) return Object.freeze({changed:false,protocol:1,nativeSearchMembersProtocol:1,runtimeSource,declarationSource});
  source = once(source,original,replacement);
  source = once(source,helperAnchor,memberHelper+helperAnchor);
  for (const [before,after] of memberDeltas) source = once(source,before,after);
  return Object.freeze({changed:true,protocol:1,nativeSearchMembersProtocol:1,runtimeSource:source,declarationSource});
}

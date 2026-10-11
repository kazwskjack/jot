# Publication review

Run `npm run test:public` before staging. This checks the source tree and the review tools themselves; it does not scan the Git history automatically.

`node scripts/verify-git-public.mjs .` separately inspects every commit reachable from local Git refs, commit author/committer metadata and messages, and every indexed blob. It includes files deleted from the latest tree and has no dependency/runtime exclusions. The check is read-only and does not stage, rewrite or push anything. Findings include file names, object hashes and rule names, never matched credentials.

For a deployment-specific review, call the exported `scanGitPublic(root, {privateIdentities})` with a private list of domains, branding, machine addresses and local paths. Keep that list and its reports outside the publishable repository. Do not add private identity values to public test fixtures or documentation.

Binary, submodule, symlink, oversized and unresolved-index findings require separate inspection. A Word template needs its ZIP entries, extracted XML text, metadata, external relationships and any embedded media checked against the same private policy. A clean text scan alone cannot clear it. Historical review also cannot clear unstaged or untracked files: inspect the worktree, stage only reviewed artifacts, and rerun against the exact index and final commit before pushing.

Review tools use heuristics and cannot prove the absence of all arbitrary secrets or private business content. Inspect the complete diff, deployment defaults, generated artifacts, dependency attribution, runtime exclusion rules and final branch contents. Record the exact reviewed commit and binary hashes. Dangling objects and reflogs are outside this reachable-history check; they are not part of a normal branch push. Do not publish private audit reports, application databases, notification archives, cookies, logs, screenshots, provider credentials or actual user conversations.

# Proactive fact verification and direct answers

Chat instructions now apply evidence checks to every subject and answer type.
When a fact essential to an answer is uncertain, potentially outdated or not
supported by available evidence, the assistant should search proactively rather
than wait for an explicit request. Certain stable knowledge and transformations
of supplied material do not need unnecessary searches.

The answer should deliver the requested conclusion first when supported, followed
by the relevant explanation and sources. It should not substitute boilerplate,
instructions for finding the answer, or an offer to search for actual retrieval.
Unsupported earlier assistant messages do not become verified sources. Residual
uncertainty must remain explicit and concise; directness never permits guessing.

The existing read-only tools, one parallel search group and one parallel reading
group remain unchanged. This is prompt guidance, not a deterministic semantic
classifier or an execution guarantee. No keyword interception is introduced.

The four preset composition and tool-boundary tests passed. These tests verify
mounting and restrictions, not live provider answer quality. Real model behavior
must be assessed separately; no universal search compliance is claimed.

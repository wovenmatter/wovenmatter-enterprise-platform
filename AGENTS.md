# Repository Guidance

Agent and runtime features follow the WovenMatter-first policy. Build and prove
the behavior in WovenMatter, then port it here with the source PR or commit,
Enterprise-specific adaptations, deterministic tests, and a parity matrix. Record and justify Enterprise-specific differences in the parity matrix; preserve
the proven behavior instead of substituting a narrower implementation.

Keep provider credentials, private transcripts, deployment state and evidence
out of Git. Use deterministic fixtures for native/runtime tests and preserve
Enterprise authorization boundaries when adapting WovenMatter code.

Use the macagent131 GitHub account through SSH and existing authenticated CLI
sessions. Never use the GitHub connector or operate account login or
authorization UI. Keep implementation and deployment work on the configured
server when the user requests server execution; the Mac can inspect references.

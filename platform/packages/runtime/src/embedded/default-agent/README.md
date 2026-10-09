# Embedded WovenMatter Default Agent Runtime

This directory contains an Enterprise copy of the WovenMatter default-agent
runtime module graph from [WovenMatter](https://github.com/wovenmatter/wovenmatter) at merged main
`5542b83ab2e11cc3c24037552883e2c6814bd596`.

The files are copied first, then adapted through narrow Enterprise boundary
modules so review can compare behavior against the WovenMatter source. Preserve
durable Harness execution, native JSONL ownership, subagent lifecycle, native
context/compaction, journal/archive, checklist and SDK management semantics.

Do not replace these modules with a smaller custom transport. Enterprise
adaptations belong in explicit adapter files and in small, reviewable patches
to the copied modules with parity notes.

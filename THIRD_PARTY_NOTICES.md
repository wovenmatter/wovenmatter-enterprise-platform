# Third-party notices

The root MIT license covers Woven Matter's original application code. It does not relicense dependencies, native executables, operating-system packages, provider services, or trademarks. Preserve upstream copyright, license and NOTICE files when distributing source, browser bundles or images.

## Locked npm dependencies

[The npm inventory](third-party/npm-inventory.tsv) records all 471 registry package occurrences (466 distinct package/version pairs) in the root lockfile, including development packages and optional platform variants. Versions, archive URLs and declared licenses come from those lockfiles; archive integrity hashes remain in the lockfiles. A declared license is metadata, not proof that a particular distribution contains every required notice.

[Collected npm notices](third-party/npm-NOTICES.txt) preserve the license/notice files supplied by the installed Linux x64 packages. This is a supplemental collection: some packages omit a top-level license, and optional packages for other architectures were not installed. [The coverage list](third-party/notice-coverage.tsv) identifies these omissions. Keep the original package contents and their embedded notices as well. Reassess the exact contents of each release image and platform variant before redistribution. This source repository does not vendor node_modules or native binaries.

| Direct dependency or tool                                      | Pinned version         | License or terms                                              |
| -------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------- |
| Fastify, @fastify/multipart, @fastify/static                   | 5.12.5, 10.1.2, 10.1.5 | MIT                                                           |
| Nodemailer                                                     | 10.0.12                | MIT-0                                                         |
| React, React DOM                                               | 19.3.0                 | MIT                                                           |
| React Router DOM                                               | 7.18.4                 | MIT                                                           |
| react-markdown, remark-gfm                                     | 10.1.0, 4.0.1          | MIT                                                           |
| Lucide React                                                   | 0.468.0                | ISC; its license also preserves Feather/MIT attribution       |
| @earendil-works/pi-coding-agent                                | 0.86.1                 | MIT; [upstream license](third-party/Pi-LICENSE.txt)           |
| @anthropic-ai/claude-agent-sdk and its native packages         | 0.3.278                | Anthropic terms; not MIT and not an Apache license grant      |
| Playwright                                                     | 1.63.0                 | Apache-2.0; browser distributions have additional notices     |
| TypeScript                                                     | 7.0.2                  | Apache-2.0                                                    |
| Vite, @vitejs/plugin-react                                     | 8.3.1, 6.1.1           | MIT; Vite's license file includes bundled third-party notices |
| tsx                                                            | 4.23.15                | MIT                                                           |
| @types/node, @types/nodemailer, @types/react, @types/react-dom | See lockfiles          | MIT                                                           |

Transitive metadata includes Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, BlueOak-1.0.0, Unlicense, 0BSD, MIT-0 and MPL-2.0 as well as MIT and Anthropic-specific terms. Lightning CSS 1.33.0 and its platform binaries declare MPL-2.0. Its [license](third-party/LightningCSS-LICENSE.txt) and [corresponding upstream source](https://github.com/parcel-bundler/lightningcss/tree/v1.33.0) must remain available when applicable to the artifact being distributed. Do not remove file-level notices or treat build dependencies as automatically irrelevant: bundled browser assets can include build-tool dependencies.

The Claude SDK package states that use is subject to [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance). Those agreements address hosted products and credential use separately from code attribution. In particular, the current policy does not permit third-party applications to route requests through users' Claude Free/Pro/Max subscriptions. The baseline's proxy integration does not establish permission for that use. Operators must establish permitted authentication, service use and redistribution before enabling it; a UI acknowledgment does not grant those rights.

## Native executables and inference service

- Codex CLI 0.158.0: Apache-2.0. Preserve [LICENSE](third-party/Codex-LICENSE.txt) and [NOTICE](third-party/Codex-NOTICE.txt), including its Ratatui attribution. These files were obtained from the [pinned release source](https://github.com/openai/codex/tree/rust-v0.158.0). The binary's other bundled components may require additional notices.
- CLIProxyAPI at `acdace936fa7df2905500c7f5e0a97d683138dea`: MIT, with its authors' original [license](third-party/CLIProxyAPI-LICENSE.txt). The inference Dockerfile retains that license. The [Enterprise remote-sign-in patch](platform/deploy/inference-patch/README.md) adapts the pinned provider helpers and adds original management code; it does not change the upstream revision or license. Its Go module dependencies and any bundled code retain their own terms; inventory the built executable before image redistribution.
- Grok Build 1.0.41: the runtime Dockerfile downloads a checksum-pinned Linux amd64 executable. A release-specific license/notice set for that exact binary has not been verified. Do not infer redistribution rights from a download URL or a newer source repository's license. Resolve the exact binary's provenance and notices before distributing a runner image.

Provider endpoints and subscription integrations remain subject to each provider's agreements, independently of an executable's open-source license.

## Document tools and container packages

The Python pins are pypdf 6.16.1 (BSD-3-Clause), python-docx 1.2.0 (MIT), openpyxl 3.1.5 (MIT), lxml 6.1.0 (BSD-3-Clause), et-xmlfile 2.0.0 (MIT), and typing-extensions 4.15.0 (PSF-2.0), based on their versioned PyPI release metadata. Binary wheels can bundle other libraries (notably lxml's XML/XSLT libraries); retain their license files and assess the actual selected wheel.

Images also contain Node.js, Debian packages and libraries, and, depending on the image, Docker CLI, Python, Git, Poppler, ripgrep, curl, unzip, bubblewrap and AppArmor utilities. These have separate licenses, including GPL/LGPL components; Poppler and Git are not MIT-only packages. Preserve the images' `/usr/share/doc/*/copyright` files, package metadata and source/license obligations. Mutable base-image tags and apt resolution mean this source inventory is not a complete image SBOM or image-distribution clearance.

Bubblewrap is LGPL-2.0-or-later; AppArmor userspace components include GPL-2.0-or-later and LGPL-2.1-or-later code. The Debian image retains their package copyright/license files and executable provenance. The local mandatory syscall helper is original MIT code. Removing the obsolete runtime web-app toolkit does not remove preserved notices for shared browser/build dependencies.

The application icons are existing WovenMatter brand artwork, not third-party icon-library replacements. Third-party names and retained author identifiers in these notices are attribution, not application operator identities.

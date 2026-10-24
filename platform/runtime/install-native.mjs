// Materialize only platform binaries already verified by npm's lockfile integrity.
// No package lifecycle scripts, network downloads, authentication, or user home writes.
import { readFile, writeFile, copyFile, chmod, mkdir, unlink, symlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
const root = resolve(process.argv[2] ?? 'node_modules')
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Native image requires Linux amd64')
const openCode = join(root, '@opencode/cli/bin/opencode.exe')
await mkdir(join(root, '@opencode/cli/bin'), {recursive: true})
await copyFile(join(root, '@opencode/cli-linux-x64-baseline/bin/opencode'), openCode)
await chmod(openCode, 0o755)
const grok = join(root, '@xai-official/grok/bin/grok-native')
await writeFile(grok, brotliDecompressSync(await readFile(join(root, '@xai-official/grok-linux-x64/bin/grok.br'))), {mode: 0o755})
await unlink(join(root, '.bin/grok')).catch(error => {if(error.code !== 'ENOENT') throw error})
await symlink('../@xai-official/grok/bin/grok-native', join(root, '.bin/grok'))

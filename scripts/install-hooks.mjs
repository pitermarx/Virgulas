/**
 * Installs a pre-push Git hook that runs bump-sw-caches.mjs before every push.
 * If sw.js or the hashes file is modified, the push is aborted so you can
 * commit the version bump first.
 *
 * Requires Git Bash (or any POSIX shell) — works on macOS, Linux, and Windows
 * with Git for Windows.
 *
 * Usage: npm run sw:hooks
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stat } from 'node:fs/promises'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const HOOKS_DIR = join(ROOT, '.git', 'hooks')
const HOOK_PATH = join(HOOKS_DIR, 'pre-push')

const HOOK = `#!/bin/sh
# Installed by scripts/install-hooks.mjs
# Bumps sw.js cache versions when vendor/fonts/app files have changed.

node scripts/bump-sw-caches.mjs || exit 1

if ! git diff HEAD --quiet source/sw.js scripts/.sw-cache-hashes.json 2>/dev/null; then
  echo ""
  echo "sw.js cache versions were bumped. Commit the changes before pushing:"
  echo "  git add source/sw.js scripts/.sw-cache-hashes.json"
  echo "  git commit -m 'chore: bump sw cache versions'"
  echo ""
  exit 1
fi
`

async function main() {
    try {
        await stat(join(ROOT, '.git'))
    } catch {
        console.error('No .git directory found. Run this from the repository root.')
        process.exit(1)
    }

    await mkdir(HOOKS_DIR, { recursive: true })
    await writeFile(HOOK_PATH, HOOK, { mode: 0o755 })
    console.log(`pre-push hook installed at ${HOOK_PATH}`)
    console.log('The hook runs bump-sw-caches.mjs before every push.')
}

main().catch((err) => { console.error(err); process.exit(1) })

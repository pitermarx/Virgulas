/**
 * Installs Git hooks that enforce repository policies:
 * - pre-push: runs bump-sw-caches.mjs before every push
 * - commit-msg: validates Conventional Commits headers
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
const PRE_PUSH_HOOK_PATH = join(HOOKS_DIR, 'pre-push')
const COMMIT_MSG_HOOK_PATH = join(HOOKS_DIR, 'commit-msg')

const PRE_PUSH_HOOK = `#!/bin/sh
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

const COMMIT_MSG_HOOK = `#!/bin/sh
# Installed by scripts/install-hooks.mjs
# Enforces Conventional Commits headers.

node scripts/check-conventional-commits.mjs --message-file "$1" || exit 1
`

async function main() {
    try {
        await stat(join(ROOT, '.git'))
    } catch {
        console.error('No .git directory found. Run this from the repository root.')
        process.exit(1)
    }

    await mkdir(HOOKS_DIR, { recursive: true })
    await writeFile(PRE_PUSH_HOOK_PATH, PRE_PUSH_HOOK, { mode: 0o755 })
    await writeFile(COMMIT_MSG_HOOK_PATH, COMMIT_MSG_HOOK, { mode: 0o755 })
    console.log(`pre-push hook installed at ${PRE_PUSH_HOOK_PATH}`)
    console.log(`commit-msg hook installed at ${COMMIT_MSG_HOOK_PATH}`)
    console.log('Installed hooks: pre-push (sw cache bump), commit-msg (Conventional Commits).')
}

main().catch((err) => { console.error(err); process.exit(1) })

import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const files = [
  ['node_modules/preact/dist/preact.module.js', 'source/vendor/preact.module.js'],
  ['node_modules/preact/hooks/dist/hooks.module.js', 'source/vendor/hooks.module.js'],
  ['node_modules/htm/dist/htm.module.js', 'source/vendor/htm.module.js'],
  ['node_modules/htm/preact/index.module.js', 'source/vendor/htm-preact.module.js'],
  ['node_modules/@preact/signals-core/dist/signals-core.module.js', 'source/vendor/signals-core.module.js'],
  ['node_modules/@preact/signals/dist/signals.module.js', 'source/vendor/signals.module.js'],
  ['node_modules/@supabase/supabase-js/dist/umd/supabase.js', 'source/vendor/supabase.js']
]

async function main() {
  for (const [from, to] of files) {
    const sourcePath = path.resolve(from)
    const targetPath = path.resolve(to)
    await mkdir(path.dirname(targetPath), { recursive: true })
    await copyFile(sourcePath, targetPath)
    console.log(`synced ${from} -> ${to}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

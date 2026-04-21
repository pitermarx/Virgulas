/**
 * Hashes each service worker cache group and increments the version constant
 * in source/sw.js when files in that group have changed since the last run.
 *
 * Stored hashes live in scripts/.sw-cache-hashes.json (committed to the repo).
 *
 * Groups mirror the *_SHELL arrays in source/sw.js — update both together
 * when adding or removing files from a pre-cached shell.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const SW_PATH = join(ROOT, 'source', 'sw.js')
const HASHES_PATH = join(__dirname, '.sw-cache-hashes.json')

const GROUPS = {
    VENDOR_CACHE: [
        join(ROOT, 'source', 'vendor'),
    ],
    FONTS_CACHE: [
        join(ROOT, 'source', 'fonts'),
        join(ROOT, 'source', 'media'),
    ],
    APP_CACHE: [
        join(ROOT, 'source', 'index.html'),
        join(ROOT, 'source', 'site.webmanifest'),
        join(ROOT, 'source', 'css'),
        join(ROOT, 'source', 'js'),
    ],
}

async function exists(p) {
    try { await stat(p); return true } catch { return false }
}

async function collectFiles(p) {
    const s = await stat(p)
    if (s.isFile()) return [p]
    const entries = (await readdir(p)).sort()
    const results = []
    for (const entry of entries) {
        results.push(...(await collectFiles(join(p, entry))))
    }
    return results
}

async function hashGroup(paths) {
    const hash = createHash('sha256')
    const files = []
    for (const p of paths) {
        if (await exists(p)) {
            files.push(...(await collectFiles(p)))
        }
    }
    for (const file of files.sort()) {
        hash.update(relative(ROOT, file).replace(/\\/g, '/'))
        hash.update(await readFile(file))
    }
    return hash.digest('hex').slice(0, 16)
}

async function main() {
    const stored = (await exists(HASHES_PATH))
        ? JSON.parse(await readFile(HASHES_PATH, 'utf8'))
        : {}

    const current = {}
    for (const [key, paths] of Object.entries(GROUPS)) {
        current[key] = await hashGroup(paths)
    }

    let sw = await readFile(SW_PATH, 'utf8')
    const bumped = []

    for (const key of Object.keys(GROUPS)) {
        if (current[key] === stored[key]) continue
        const before = sw
        sw = sw.replace(
            new RegExp(`(const ${key} = 'virgulas-[^-]+-v)(\\d+)'`),
            (_, prefix, n) => {
                const next = parseInt(n, 10) + 1
                console.log(`  ${key}: v${n} → v${next}`)
                return `${prefix}${next}'`
            }
        )
        if (sw !== before) bumped.push(key)
    }

    if (bumped.length > 0) {
        await writeFile(SW_PATH, sw, 'utf8')
        console.log(`Bumped ${bumped.length} cache(s): ${bumped.join(', ')}`)
    } else {
        console.log('sw cache versions up to date — nothing bumped.')
    }

    await writeFile(HASHES_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8')
}

main().catch((err) => { console.error(err); process.exit(1) })

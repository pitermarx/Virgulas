// Build-time service worker cache hashing.
//
// `scripts/bump-sw-caches.mjs` hashes each cache group and bumps the version
// constant in `source/sw.js` when a group's content changed. The hash must
// describe the committed content, not how Git checked the tree out, so text
// files are normalised to LF before hashing: `core.autocrlf` and
// `.gitattributes` eol rules otherwise give the same commit different hashes on
// Windows and Linux, which bumps the cache on every CI run.

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

async function exists(p: string): Promise<boolean> {
    try { await stat(p); return true } catch { return false }
}

/** Every file under `p`, in sorted directory order. */
export async function collectFiles(p: string): Promise<string[]> {
    const s = await stat(p)
    if (s.isFile()) return [p]
    const entries = (await readdir(p)).sort()
    const results: string[] = []
    for (const entry of entries) {
        results.push(...(await collectFiles(join(p, entry))))
    }
    return results
}

/**
 * Normalises line endings so a CRLF checkout hashes like an LF one. Binary
 * assets (fonts, icons) contain NUL bytes and are hashed byte for byte: Git
 * does not apply eol conversion to them, and rewriting their bytes would hide
 * real changes.
 */
function normalizeEol(bytes: Buffer): Buffer {
    if (bytes.includes(0)) return bytes
    return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

/**
 * Hashes a group of files under `root`: the root-relative path (forward
 * slashes on every platform) followed by the file's normalised content.
 */
export async function hashGroup(root: string, paths: readonly string[]): Promise<string> {
    const hash = createHash('sha256')
    const files: string[] = []
    for (const p of paths) {
        if (await exists(p)) {
            files.push(...(await collectFiles(p)))
        }
    }
    for (const file of files.sort()) {
        hash.update(relative(root, file).replace(/\\/g, '/'))
        hash.update(normalizeEol(await readFile(file)))
    }
    return hash.digest('hex').slice(0, 16)
}

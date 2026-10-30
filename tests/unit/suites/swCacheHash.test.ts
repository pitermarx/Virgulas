import { describe, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual } from '../testing.js'
import { hashGroup } from '../../../scripts/sw-cache.js'

async function withFixture(fn: (root: string, file: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sw-cache-'))
    try {
        const file = path.join(root, 'source', 'index.html')
        await mkdir(path.dirname(file), { recursive: true })
        await fn(root, file)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe('service worker cache hash — hashGroup', () => {

    it('hashes an LF and a CRLF checkout of the same fixture alike', async () => {
        await withFixture(async (root, file) => {
            await writeFile(file, '<!doctype html>\n<p>one</p>\n<p>two</p>\n', 'utf8')
            const lf = await hashGroup(root, [file])

            await writeFile(file, '<!doctype html>\r\n<p>one</p>\r\n<p>two</p>\r\n', 'utf8')
            const crlf = await hashGroup(root, [file])

            assertEqual(crlf, lf, 'CRLF checkout hashes like an LF one')
        })
    })

    it('still changes when the content changes', async () => {
        await withFixture(async (root, file) => {
            await writeFile(file, '<p>one</p>\n', 'utf8')
            const before = await hashGroup(root, [file])

            await writeFile(file, '<p>two</p>\n', 'utf8')
            const after = await hashGroup(root, [file])

            assert(before !== after, 'different content should hash differently')
        })
    })
})

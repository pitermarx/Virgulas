import { readFile, writeFile } from 'node:fs/promises'

function parseArgs(argv) {
    const args = { index: '', json: '', version: '' }
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === '--index') {
            args.index = argv[i + 1] || ''
            i += 1
            continue
        }
        if (arg === '--json') {
            args.json = argv[i + 1] || ''
            i += 1
            continue
        }
        if (arg === '--version') {
            args.version = argv[i + 1] || ''
            i += 1
            continue
        }
    }
    return args
}

async function main() {
    const { index, json, version } = parseArgs(process.argv)
    if (!index || !version) {
        throw new Error('Usage: node scripts/stamp-app-version.mjs --index <path> --version <semver> [--json <path>]')
    }

    const html = await readFile(index, 'utf8')
    const metaRe = /<meta\s+name="app-version"\s+content="[^"]*"\s*\/?>/
    if (!metaRe.test(html)) {
        throw new Error(`Missing app-version meta tag in ${index}`)
    }

    const nextMeta = `<meta name="app-version" content="${version}">`
    const stamped = html.replace(metaRe, nextMeta)
    await writeFile(index, stamped, 'utf8')

    if (json) {
        const payload = {
            version,
            sha: process.env.GITHUB_SHA || '',
            generatedAt: new Date().toISOString(),
        }
        await writeFile(json, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    }

    console.log(`Stamped app version ${version} in ${index}`)
}

main().catch((error) => {
    console.error(error?.message || error)
    process.exit(1)
})

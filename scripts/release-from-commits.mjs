import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const PACKAGE_JSON_PATH = join(ROOT, 'package.json')
const SEMVER_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/
const HEADER_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s+(?<summary>.+)$/
const PATCH_TYPES = new Set(['fix', 'perf', 'refactor', 'revert'])

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: ROOT,
        encoding: 'utf8',
        ...options,
    })
    if (result.status !== 0) {
        const stderr = result.stderr?.trim() || 'unknown error'
        throw new Error(`${command} ${args.join(' ')} failed: ${stderr}`)
    }
    return result.stdout
}

function resolveNotesPath() {
    const baseDir = process.env.RUNNER_TEMP || process.env.TEMP || process.env.TMPDIR || tmpdir()
    return join(baseDir, 'virgulas-release-notes.md')
}

function toOutput(key, value) {
    const outputPath = process.env.GITHUB_OUTPUT
    if (!outputPath) return
    const line = `${key}=${String(value ?? '').replace(/\r?\n/g, ' ')}`
    requireWriteQueue.push(line)
}

const requireWriteQueue = []

async function flushOutputs() {
    const outputPath = process.env.GITHUB_OUTPUT
    if (!outputPath || requireWriteQueue.length === 0) return
    const payload = requireWriteQueue.join('\n') + '\n'
    await writeFile(outputPath, payload, { encoding: 'utf8', flag: 'a' })
}

function parseVersion(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
    if (!match) {
        throw new Error(`Invalid semver version: ${version}`)
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    }
}

function formatVersion(v) {
    return `${v.major}.${v.minor}.${v.patch}`
}

function bumpVersion(baseVersion, bumpType) {
    const parsed = parseVersion(baseVersion)
    if (bumpType === 'major') {
        return formatVersion({ major: parsed.major + 1, minor: 0, patch: 0 })
    }
    if (bumpType === 'minor') {
        return formatVersion({ major: parsed.major, minor: parsed.minor + 1, patch: 0 })
    }
    return formatVersion({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + 1 })
}

function latestSemverTag() {
    const tagsRaw = run('git', ['tag', '--list', 'v*', '--sort=-v:refname'])
    const tags = tagsRaw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    for (const tag of tags) {
        if (SEMVER_TAG_RE.test(tag)) {
            return tag
        }
    }
    return ''
}

function getCommits(range) {
    const format = '%H%x1f%s%x1f%b%x1e'
    const args = ['log', `--format=${format}`]
    if (range) args.push(range)

    const output = run('git', args)
    const records = output.split('\x1e').map((r) => r.trim()).filter(Boolean)
    return records.map((record) => {
        const [sha = '', subject = '', body = ''] = record.split('\x1f')
        return {
            sha,
            subject: subject.trim(),
            body: body.trim(),
        }
    })
}

function classify(commits) {
    let bumpType = ''
    const releasable = []

    for (const commit of commits) {
        if (/^Merge\b/.test(commit.subject)) continue

        const header = HEADER_RE.exec(commit.subject)
        if (!header?.groups) continue

        const type = header.groups.type
        const isBreaking = Boolean(header.groups.breaking) || /BREAKING CHANGE:/i.test(commit.body)
        let currentType = ''

        if (isBreaking) {
            currentType = 'major'
        } else if (type === 'feat') {
            currentType = 'minor'
        } else if (PATCH_TYPES.has(type)) {
            currentType = 'patch'
        }

        if (!currentType) continue

        releasable.push({
            ...commit,
            type,
            breaking: isBreaking,
            summary: header.groups.summary,
            bump: currentType,
        })

        if (currentType === 'major') {
            bumpType = 'major'
            continue
        }
        if (currentType === 'minor' && bumpType !== 'major') {
            bumpType = 'minor'
            continue
        }
        if (currentType === 'patch' && !bumpType) {
            bumpType = 'patch'
        }
    }

    return { bumpType, releasable }
}

function buildNotes(version, releasable, range) {
    const sections = {
        major: [],
        feat: [],
        patch: [],
    }

    for (const commit of releasable) {
        const shortSha = commit.sha.slice(0, 7)
        const bullet = `- ${commit.subject} (${shortSha})`
        if (commit.breaking) {
            sections.major.push(bullet)
            continue
        }
        if (commit.type === 'feat') {
            sections.feat.push(bullet)
            continue
        }
        sections.patch.push(bullet)
    }

    const lines = [`## v${version}`, '', `Range: ${range || 'HEAD'}`, '']

    if (sections.major.length) {
        lines.push('### Breaking Changes', ...sections.major, '')
    }
    if (sections.feat.length) {
        lines.push('### Features', ...sections.feat, '')
    }
    if (sections.patch.length) {
        lines.push('### Fixes and Refactors', ...sections.patch, '')
    }

    if (!sections.major.length && !sections.feat.length && !sections.patch.length) {
        lines.push('- No releasable changes detected.')
    }

    return lines.join('\n').trim() + '\n'
}

function tagExists(tag) {
    const result = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
        cwd: ROOT,
        encoding: 'utf8',
    })
    return result.status === 0
}

async function main() {
    const notesPath = resolveNotesPath()
    const pkg = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf8'))
    const packageVersion = pkg.version
    const latestTag = latestSemverTag()
    const currentVersion = latestTag ? latestTag.replace(/^v/, '') : packageVersion
    const range = latestTag ? `${latestTag}..HEAD` : 'HEAD'
    const commits = getCommits(range)
    const { bumpType, releasable } = classify(commits)

    if (!bumpType) {
        console.log(`No releasable commits found in ${range}.`)
        toOutput('release_needed', 'false')
        toOutput('release_created', 'false')
        toOutput('bump_type', 'none')
        toOutput('previous_version', currentVersion)
        toOutput('resolved_version', currentVersion)
        toOutput('release_tag', '')
        toOutput('notes_file', notesPath)
        await flushOutputs()
        return
    }

    const nextVersion = bumpVersion(currentVersion, bumpType)
    const releaseTag = `v${nextVersion}`
    const notes = buildNotes(nextVersion, releasable, range)
    await writeFile(notesPath, notes, 'utf8')

    const exists = tagExists(releaseTag)
    console.log(`Release bump: ${bumpType}`)
    console.log(`Previous version: ${currentVersion}`)
    console.log(`Next version: ${nextVersion}`)
    if (exists) {
        console.log(`Tag ${releaseTag} already exists.`)
    }

    toOutput('release_needed', exists ? 'false' : 'true')
    toOutput('release_created', 'false')
    toOutput('bump_type', bumpType)
    toOutput('previous_version', currentVersion)
    toOutput('resolved_version', nextVersion)
    toOutput('release_tag', releaseTag)
    toOutput('notes_file', notesPath)
    await flushOutputs()
}

main().catch(async (error) => {
    const notesPath = resolveNotesPath()
    console.error(error?.message || error)
    toOutput('release_needed', 'false')
    toOutput('release_created', 'false')
    toOutput('bump_type', 'error')
    toOutput('previous_version', '')
    toOutput('resolved_version', '')
    toOutput('release_tag', '')
    toOutput('notes_file', notesPath)
    await flushOutputs()
    process.exit(1)
})

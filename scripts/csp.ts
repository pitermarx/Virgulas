// Build-time Content-Security-Policy helpers.
//
// The source shell ships a development-friendly `connect-src` (localhost plus the
// `*.supabase.co` wildcard). Production builds call `tightenConnectSrc` to drop
// the local sources and pin the concrete hosted Supabase origin, so the deployed
// artifact cannot talk to a different project. Kept in TypeScript so the build
// step and its unit tests share one implementation.

const LOCAL_CONNECT_SOURCES = new Set(['http://127.0.0.1:*', 'http://localhost:*'])
const WILDCARD_SUPABASE_SOURCE = 'https://*.supabase.co'

export interface SupabaseOriginSources {
    /** `--supabase-url` value from the CLI. */
    cliUrl?: string
    /** `SUPABASE_URL` environment variable. */
    envUrl?: string
    /** `SUPABASE_PROJECT` environment variable (project ref or full URL). */
    envProject?: string
    /** Fallback read from `source/js/sync.ts` DEFAULT_CONFIG. */
    appUrl?: string
}

function toSupabaseUrl(project: string): string {
    return /^https?:\/\//i.test(project) ? project : `https://${project}.supabase.co`
}

/** Normalises a Supabase URL or project ref to `https://<ref>.supabase.co`. */
export function resolveSupabaseOrigin(sources: SupabaseOriginSources = {}): string {
    const candidate = sources.cliUrl
        || sources.envUrl
        || (sources.envProject ? toSupabaseUrl(sources.envProject) : '')
        || sources.appUrl
        || ''
    if (!candidate) return ''
    try {
        return new URL(candidate).origin
    } catch {
        return ''
    }
}

/** Reads the hosted default URL from the `DEFAULT_CONFIG` literal in source/js/sync.ts. */
export function extractDefaultSupabaseUrl(syncSource: string): string {
    const match = /DEFAULT_CONFIG\s*=\s*\{[^}]*?url:\s*['"]([^'"]+)['"]/s.exec(syncSource)
    return match ? match[1] : ''
}

/**
 * Removes the local-development sources and the `*.supabase.co` wildcard from the
 * CSP `connect-src` directive and pins the concrete Supabase origin.
 *
 * Only the `Content-Security-Policy` meta tag's `content` attribute is touched, so
 * the word "connect-src" in surrounding comments is ignored.
 *
 * Throws instead of silently keeping the permissive policy, so a production build
 * can never ship localhost or a wildcard by accident.
 */
export function tightenConnectSrc(html: string, supabaseOrigin: string): string {
    if (!supabaseOrigin) {
        throw new Error('Missing Supabase origin for the production CSP')
    }

    const host = new URL(supabaseOrigin).hostname
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        throw new Error(`Refusing to pin a local Supabase origin (${supabaseOrigin}) into a production CSP; use --local for a development build`)
    }

    const metaRe = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i
    const metaMatch = metaRe.exec(html)
    if (!metaMatch) {
        throw new Error('CSP meta tag not found in the built index.html')
    }

    const [full, prefix, content, suffix] = metaMatch
    let found = false
    const tightened = content.replace(/connect-src([^;]*)/i, (_match, sources: string) => {
        found = true
        const kept = sources
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .filter((source) => !LOCAL_CONNECT_SOURCES.has(source) && source !== WILDCARD_SUPABASE_SOURCE)
        if (!kept.includes(supabaseOrigin)) kept.push(supabaseOrigin)
        return `connect-src ${kept.join(' ')}`
    })

    if (!found) {
        throw new Error('CSP connect-src directive not found in the built index.html')
    }

    return html.replace(full, prefix + tightened + suffix)
}

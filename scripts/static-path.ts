import path from 'node:path'

/**
 * Resolves a URL pathname to a file under `rootDir`, or `null` when the path
 * escapes the root.
 *
 * The caller decodes the pathname first (`decodeURIComponent`), which can
 * reintroduce `..` segments after the URL parser has already normalised them, so
 * this must compare a fully resolved path against `rootDir` — a plain
 * `startsWith(rootDir)` string check also lets a sibling such as `dist-secret`
 * through. NUL bytes are rejected outright.
 */
export function resolveStaticPath(rootDir: string, pathname: string): string | null {
    if (pathname.includes('\0')) return null

    const resolvedRoot = path.resolve(rootDir)
    const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`
    const filePath = path.resolve(resolvedRoot, `.${normalized}`)

    if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) {
        return null
    }

    return filePath
}

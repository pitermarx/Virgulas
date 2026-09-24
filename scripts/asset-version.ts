// Version the bundled entry assets (`js/app.js`, `js/app.css`) with a `?v=`
// query stamped at build time.
//
// Why this exists
// ---------------
// The bundle used to live at a stable URL across releases. That is unsafe for a
// service-worker-cached app: the worker serves navigations from the network but
// subresources from cache (`stale-while-revalidate`), so one load can pair a
// freshly fetched `index.html` with a previously cached `js/app.js`. When v2
// changed `js/app.js` from an import-map-dependent module graph to a single
// bundled file, that window turned into a hard failure — the new HTML had no
// import map, while the cached script still contained a bare `htm/preact`
// specifier, and the app refused to boot with:
//
//   "The specifier "htm/preact" was a bare specifier, but was not remapped to
//    anything."
//
// Keying the asset URL on the release version makes the HTML/asset pair atomic.
// It also fixes the transition case for users who still have the *old* worker
// installed: cache lookups match on the full URL, so a request for
// `js/app.js?v=2.0.1` misses an entry stored as `js/app.js`, falls through to
// the network, and receives a script that matches the HTML that asked for it.
//
// The version is applied to `index.html` and to the `APP_SHELL` entries in
// `sw.js`, so the service worker precaches exactly the URLs the page requests.

/** `href="js/app.css"` / `src="js/app.js"` in the shell markup. */
const HTML_ASSET = /(href|src)="(js\/app\.(?:css|js))(?:\?[^"]*)?"/g

/** `'./js/app.css'` / `'./js/app.js'` entries inside the sw.js APP_SHELL. */
const SHELL_ASSET = /'\.\/(js\/app\.(?:css|js))(?:\?[^']*)?'/g

/**
 * Rewrite the bundled asset references in the shell markup so each carries
 * `?v=<version>`. Re-stamping an already stamped document replaces the existing
 * query rather than appending a second one.
 */
export function stampAssetVersion(html: string, version: string): string {
    return html.replace(HTML_ASSET, (_match, attribute: string, asset: string) => `${attribute}="${asset}?v=${version}"`)
}

/**
 * Apply the same version query to the APP_SHELL entries in the service worker,
 * so the precache keys match the URLs the page actually requests.
 */
export function stampShellVersion(swSource: string, version: string): string {
    return swSource.replace(SHELL_ASSET, (_match, asset: string) => `'./${asset}?v=${version}'`)
}

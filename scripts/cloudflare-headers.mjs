#!/usr/bin/env bun
// Apply the response headers GitHub Pages cannot set, at the Cloudflare edge.
//
// Virgulas is published from GitHub Pages, which ignores `_headers` and offers no
// way to send response headers. The site is already fronted by Cloudflare (the CI
// cache purge uses the same token), so this script turns on "Always Use HTTPS" and
// installs a single response-header transform rule that carries the security
// headers the required tier of https://specification.website expects:
//
//   - HSTS, X-Content-Type-Options, frame-ancestors, X-Frame-Options,
//     Referrer-Policy, Permissions-Policy, COOP, CORP
//   - a `Link` header advertising /llms.txt and /sitemap.xml
//
// The entrypoint ruleset is PUT (not append), so running the script repeatedly is
// idempotent. It exits 0 with a notice when the Cloudflare secrets are absent, so
// local runs and forks do not fail.
//
// Usage: CLOUDFLARE_ZONE_ID=... CLOUDFLARE_API_TOKEN=... bun scripts/cloudflare-headers.mjs
//
// Required token permissions:
//   - Zone → Zone Settings → Edit   (Always Use HTTPS)
//   - Zone → Transform Rules → Edit (the response-header ruleset; the API name is
//     `Zone Transform Rules Write`)
// "Config Rules" is a different product (Configuration Rules) and does not grant
// access to the Rulesets API — a token with only that will get
// `403: request is not authorized` on the entrypoint PUT below.

const zoneId = process.env.CLOUDFLARE_ZONE_ID
const token = process.env.CLOUDFLARE_API_TOKEN

if (!zoneId || !token) {
    console.log('Cloudflare secrets (CLOUDFLARE_ZONE_ID / CLOUDFLARE_API_TOKEN) not set; skipping edge headers.')
    process.exit(0)
}

const api = 'https://api.cloudflare.com/client/v4'
const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
}

async function call(method, path, body) {
    const response = await fetch(`${api}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.success === false) {
        const detail = payload.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || response.statusText
        throw new Error(`${method} ${path} failed (${response.status}): ${detail}`)
    }
    return payload.result
}

// 1. Redirect plain HTTP to HTTPS.
const setting = await call('PATCH', `/zones/${zoneId}/settings/always_use_https`, { value: 'on' })
console.log(`always_use_https = ${setting.value}`)

// 2. Security headers, set on every response.
//
// COEP (require-corp) is deliberately omitted: it would block the cross-origin
// Umami analytics script, which does not send Cross-Origin-Resource-Policy.
const SECURITY_HEADERS = {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    "Content-Security-Policy": "frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin'
}

const ruleset = {
    description: 'Virgulas security and discovery headers',
    rules: [
        {
            action: 'rewrite',
            description: 'Security headers + llms.txt/sitemap discovery',
            enabled: true,
            expression: 'true',
            action_parameters: {
                headers: {
                    ...Object.fromEntries(
                        Object.entries(SECURITY_HEADERS).map(([name, value]) => [name, { operation: 'set', value }])
                    ),
                    // Agent readiness: advertise machine-readable resources in the
                    // response, for clients that never parse the HTML <head>.
                    Link: {
                        operation: 'set',
                        value: '</llms.txt>; rel="llms-txt", </sitemap.xml>; rel="sitemap"'
                    }
                }
            }
        }
    ]
}

await call('PUT', `/zones/${zoneId}/rulesets/phases/http_response_headers_transform/entrypoint`, ruleset)
console.log(`Applied ${Object.keys(SECURITY_HEADERS).length} security headers + Link discovery header.`)

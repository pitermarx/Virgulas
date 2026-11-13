# Load a VMD document from the query string

- **Priority:** P3 (SPEC ROADMAP feature)
- **Type:** feature
- **Spec impact:** SPEC ROADMAP; touches the capture fast path and the CSP

## Description

Accept a URL to a `.vmd` file, or base64 text, so a document can be opened by link. The note suggests using it for a "Pricing" page: a VMD document with links to sign up.

## Security considerations (this is a new inbound channel)

- **Same class as the settled capture rule:** a link that loads content must never write into the user's own document or queue. Open it read-only, in Memory mode, with a visible "Opened from link" banner and an explicit "Save a copy" action.
- **Fetching a URL:** the production CSP restricts `connect-src` to the pinned Supabase origin and the analytics host, so a cross-origin `fetch` of an arbitrary `.vmd` URL is blocked. Options: same-origin paths only (`/pricing.vmd` shipped with the site, which also covers the Pricing page idea), or an allow-list of hosts, or the base64 form which needs no fetch. Do not loosen `connect-src` to `https:`.
- **Size and parse limits:** `?doc=` base64 is bounded by URL length (browsers and CDNs cap at a few KB to ~64 KB); apply a maximum decoded size, and cap node count and nesting depth (the parser is recursive).
- **Content:** the text renders as markdown with the sanitizer in place, but images in the loaded document are remote loads (sec-08), so require the click-to-load behaviour there.
- **Analytics:** the tracker already excludes search and hash (`data-exclude-search` / `data-exclude-hash`, set in the sec-02 work), so a document in the query string never reaches it. The hash (`#doc=`) still has the advantage of never reaching servers and logs.

## Suggested approach

Ship the Pricing page as a static `source/pricing.vmd` opened with `?open=pricing` (same-origin, no fetch policy change), render it read-only in Memory mode, and add the base64 hash form later with the limits above.

## Tests

Unit tests for the decoder limits; Playwright: the loaded document is read-only, is not saved to Local storage, and a hostile image does not load until opted in.

<!-- roadmap -->
## Roadmap position

- **Phase:** [9 — Features](README.md#phase-9)
- **Size:** M · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** [sec-08](sec-08-remote-image-tracking.md)
- **Unblocks:** [growth-01](growth-01-publicity-and-monetisation.md)
- **Its decision changes how these are built:** —
- **Shaped by:** [sec-08](sec-08-remote-image-tracking.md)
- **Related:** —

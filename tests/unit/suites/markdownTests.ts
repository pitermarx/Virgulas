import {
    renderBlockMarkdown,
    renderInlineMarkdown,
    SANITIZE_OPTIONS
} from '../../../source/js/markdown.js'
import {
    assert,
    cloneSections,
    createAsyncSectionHarness,
    streamCompletedSections,
    summaryFromSections
} from '../testing.js'

// ─── harness ──────────────────────────────────────────────────────────────────

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

export function summary() {
    return summaryFromSections(sections)
}

export async function streamMarkdownTests(onProgress: any) {
    return streamCompletedSections(cloneSections(sections), onProgress, 10)
}

// ─── tests ────────────────────────────────────────────────────────────────────

section("renderInlineMarkdown — due date decoration")

await test("trailing due:yyyy-MM-dd is wrapped in a due-date span for task text", () => {
    const html = renderInlineMarkdown("Buy milk due:2026-08-05", { decorateMeta: true })
    assert(html.includes('class="due-date"'), "should contain due-date span")
    assert(html.includes('due:2026-08-05'), "should contain the due token text")
})

await test("due token in the middle is not decorated", () => {
    const html = renderInlineMarkdown("Buy due:2026-08-05 milk", { decorateMeta: true })
    assert(!html.includes('due-date'), "middle due should not be decorated")
})

await test("invalid due format is not decorated", () => {
    const html = renderInlineMarkdown("Task due:tomorrow", { decorateMeta: true })
    assert(!html.includes('due-date'), "invalid due should not be decorated")
})

await test("due inside code span is not decorated", () => {
    const html = renderInlineMarkdown("Task `due:2026-08-05`", { decorateMeta: true })
    assert(!html.includes('due-date'), "due in code should not be decorated")
})

await test("unregistered metadata is not decorated", () => {
    const html = renderInlineMarkdown("Task priority:low", { decorateMeta: true })
    assert(!html.includes('due-date'), "priority should not be decorated")
})

await test("due with trailing characters is not decorated", () => {
    const html = renderInlineMarkdown("Task due:2026-08-05x", { decorateMeta: true })
    assert(!html.includes('due-date'), "due with trailing chars should not be decorated")
})

await test("due with trailing whitespace is decorated", () => {
    const html = renderInlineMarkdown("Buy milk due:2026-08-05 ", { decorateMeta: true })
    assert(html.includes('class="due-date"'), "trailing whitespace should still decorate")
})

await test("due tokens are not decorated unless requested for task text", () => {
    const html = renderInlineMarkdown("Buy milk due:2026-08-05")
    assert(!html.includes('due-date'), "plain text should not have a due-date chip")
})

await test("invalid calendar dates are not decorated", () => {
    const html = renderInlineMarkdown("Task due:2026-02-30", { decorateMeta: true })
    assert(!html.includes('due-date'), "invalid calendar date should not have a due-date chip")
})

section("renderInlineMarkdown — recurrence decoration")

await test("trailing rec:1m is wrapped in a rec-badge span", () => {
    const html = renderInlineMarkdown("Pay bill rec:1m", { decorateMeta: true })
    assert(html.includes('class="rec-badge"'), "should contain rec-badge span")
    assert(html.includes('rec:1m'), "should contain the rec token text")
})

await test("due and rec together are both decorated", () => {
    const html = renderInlineMarkdown("Pay bill due:2026-08-05 rec:1m", { decorateMeta: true })
    assert(html.includes('class="due-date"'), "should contain due-date span")
    assert(html.includes('class="rec-badge"'), "should contain rec-badge span")
})

await test("rec before due is also decorated (order independent)", () => {
    const html = renderInlineMarkdown("Pay bill rec:1m due:2026-08-05", { decorateMeta: true })
    assert(html.includes('class="due-date"'), "should contain due-date span")
    assert(html.includes('class="rec-badge"'), "should contain rec-badge span")
})

await test("invalid rec unit is not decorated", () => {
    const html = renderInlineMarkdown("Task rec:1x", { decorateMeta: true })
    assert(!html.includes('rec-badge'), "invalid rec unit should not be decorated")
})

await test("rec tokens are not decorated unless requested for task text", () => {
    const html = renderInlineMarkdown("Pay bill rec:1m")
    assert(!html.includes('rec-badge'), "plain text should not have a rec-badge chip")
})
section("renderInlineMarkdown — links and tokens")

await test("javascript link schemes never reach the output", () => {
    const html = renderInlineMarkdown("[click](javascript:alert(1))")
    assert(!html.includes('javascript:'), "no javascript scheme")
    assert(html.includes('click'), "link text preserved")
})

await test("unsafe images fall back to escaped alt text", () => {
    const html = renderInlineMarkdown("![alt](javascript:alert(1))")
    assert(!html.includes('<img'), "no image element")
    assert(html.includes('alt'), "alt text kept")
})

await test("hash tags and mentions become search tokens", () => {
    const html = renderInlineMarkdown("See #project and @alice")
    assert(html.includes('search-token-tag'), "hashtag token")
    assert(html.includes('search-token-mention'), "mention token")
    assert(html.includes('data-search-token="#project"'), "token payload")
})

await test("inline code is not decorated as a search token", () => {
    const html = renderInlineMarkdown("Use `#notatag` literally")
    assert(!html.includes('search-token-tag'), "code span not decorated")
})

// happy-dom's DOMPurify mangles block-level tags (it drops <h1>/<h2>/<ol>/<table>
// and leaves <input> in place), so the rendered block structure and the security
// guarantees of the allow-list are asserted in Chromium instead — see
// tests/description-markdown.spec.ts. The unit tests below only cover the parts
// happy-dom handles faithfully.
section("renderBlockMarkdown — block document rendering")

await test("fenced code content survives without a language class", () => {
    const html = renderBlockMarkdown("```js\nconst x = 1\n```\n")
    assert(html.includes('const x = 1'), "code content survives")
    assert(!html.includes('language-'), "language class dropped")
    assert(!html.includes('class='), "no class attribute")
})

await test("inline formatting still works inside block markdown", () => {
    const html = renderBlockMarkdown("Body **bold** and `code` and [link](https://example.com).")
    assert(html.includes('<strong>bold</strong>'), "bold")
    assert(html.includes('href="https://example.com"'), "link")
})

await test("search tokens are decorated inside block markdown", () => {
    const html = renderBlockMarkdown("## Notes\n\nSee #project and @alice.")
    assert(html.includes('search-token-tag'), "hashtag decorated")
    assert(html.includes('search-token-mention'), "mention decorated")
})

await test("search tokens inside fenced code are left alone", () => {
    const html = renderBlockMarkdown("```\n#notatag @notamention\n```\n")
    assert(!html.includes('search-token-tag'), "code fence not decorated")
    assert(html.includes('#notatag'), "raw token text preserved")
})

await test("block markdown images are hardened like inline images", () => {
    const html = renderBlockMarkdown("![alt](https://example.com/pic.png)")
    assert(html.includes('<img'), "image renders")
    assert(html.includes('referrerpolicy="no-referrer"'), "no referrer")
    assert(html.includes('loading="lazy"'), "lazy loading")
    assert(!html.includes('javascript:'), "no javascript scheme")
})

section("renderInlineMarkdown — sanitizer hardening")

await test("the HTML profile is never merged into the allow-list", () => {
    assert(!('USE_PROFILES' in SANITIZE_OPTIONS), "USE_PROFILES would widen ALLOWED_TAGS/ALLOWED_ATTR")
    assert(Array.isArray(SANITIZE_OPTIONS.ALLOWED_TAGS), "explicit tag allow-list required")
    assert(Array.isArray(SANITIZE_OPTIONS.ALLOWED_ATTR), "explicit attribute allow-list required")
})

await test("script tags never reach the output", () => {
    const html = renderInlineMarkdown('<script>alert(1)</script>')
    assert(!/script/i.test(html), "no script element")
})

await test("raw HTML cannot inject layout classes, ids, or inline styles", () => {
    const html = renderInlineMarkdown('<div class="modal-overlay" id="app" style="position:fixed">x</div>')
    assert(!html.includes('class='), "no class attribute")
    assert(!html.includes('id='), "no id attribute")
    assert(!html.includes('style='), "no style attribute")
})

await test("raw HTML media elements are stripped", () => {
    const video = renderInlineMarkdown('<video src="https://evil.example/v.mp4" autoplay></video>')
    const audio = renderInlineMarkdown('<audio src="https://evil.example/a.mp3" autoplay></audio>')
    assert(!/<video/i.test(video), "no video element")
    assert(!/<audio/i.test(audio), "no audio element")
})

await test("image markup never carries event handlers", () => {
    const html = renderInlineMarkdown('<img src="https://evil.example/p.png" onerror="alert(1)" alt="A">')
    assert(!html.includes('onerror'), "no event handler")
    assert(!html.includes('javascript:'), "no javascript scheme")
})

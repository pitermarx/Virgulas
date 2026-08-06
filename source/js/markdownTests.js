import { renderInlineMarkdown } from './markdown.js'
import {
    assert,
    cloneSections,
    createAsyncSectionHarness,
    streamCompletedSections,
    summaryFromSections
} from './testing.js'

// ─── harness ──────────────────────────────────────────────────────────────────

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

export function summary() {
    return summaryFromSections(sections)
}

export async function streamMarkdownTests(onProgress) {
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
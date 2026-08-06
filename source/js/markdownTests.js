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
    const html = renderInlineMarkdown("Buy milk due:2026-08-05", { decorateDueDate: true })
    assert(html.includes('class="due-date"'), "should contain due-date span")
    assert(html.includes('due:2026-08-05'), "should contain the due token text")
})

await test("due token in the middle is not decorated", () => {
    const html = renderInlineMarkdown("Buy due:2026-08-05 milk", { decorateDueDate: true })
    assert(!html.includes('due-date'), "middle due should not be decorated")
})

await test("invalid due format is not decorated", () => {
    const html = renderInlineMarkdown("Task due:tomorrow", { decorateDueDate: true })
    assert(!html.includes('due-date'), "invalid due should not be decorated")
})

await test("due inside code span is not decorated", () => {
    const html = renderInlineMarkdown("Task `due:2026-08-05`", { decorateDueDate: true })
    assert(!html.includes('due-date'), "due in code should not be decorated")
})

await test("unregistered metadata is not decorated", () => {
    const html = renderInlineMarkdown("Task priority:low", { decorateDueDate: true })
    assert(!html.includes('due-date'), "priority should not be decorated")
})

await test("due with trailing characters is not decorated", () => {
    const html = renderInlineMarkdown("Task due:2026-08-05x", { decorateDueDate: true })
    assert(!html.includes('due-date'), "due with trailing chars should not be decorated")
})

await test("due with trailing whitespace is decorated", () => {
    const html = renderInlineMarkdown("Buy milk due:2026-08-05 ", { decorateDueDate: true })
    assert(html.includes('class="due-date"'), "trailing whitespace should still decorate")
})

await test("due tokens are not decorated unless requested for task text", () => {
    const html = renderInlineMarkdown("Buy milk due:2026-08-05")
    assert(!html.includes('due-date'), "plain text should not have a due-date chip")
})

await test("invalid calendar dates are not decorated", () => {
    const html = renderInlineMarkdown("Task due:2026-02-30", { decorateDueDate: true })
    assert(!html.includes('due-date'), "invalid calendar date should not have a due-date chip")
})
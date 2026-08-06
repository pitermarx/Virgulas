import { parseMeta, formatMeta, isOverdue, formatDueDate } from './meta.js'
import {
    assert,
    assertEqual,
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

export async function streamMetaTests(onProgress) {
    return streamCompletedSections(cloneSections(sections), onProgress, 10)
}

// ─── tests ────────────────────────────────────────────────────────────────────

section("parseMeta")

await test("extracts due:yyyy-MM-dd from end of text", () => {
    const { meta, text } = parseMeta("Buy milk due:2026-08-05")
    assertEqual(meta.due, '2026-08-05', "due should be extracted")
    assertEqual(text, 'Buy milk', "residual text should have token stripped")
})

await test("metadata in the middle is not extracted (trailing token stops scan)", () => {
    const { meta, text } = parseMeta("Buy due:2026-08-05 milk")
    assertEqual(Object.keys(meta).length, 0, "due in middle should not be extracted")
    assertEqual(text, 'Buy due:2026-08-05 milk', "text should be unchanged")
})

await test("text without metadata returns empty meta and unchanged text", () => {
    const { meta, text } = parseMeta("Just a note")
    assertEqual(Object.keys(meta).length, 0, "meta should be empty")
    assertEqual(text, 'Just a note', "text should be unchanged")
})

await test("empty text returns empty meta and empty text", () => {
    const { meta, text } = parseMeta("")
    assertEqual(Object.keys(meta).length, 0, "meta should be empty")
    assertEqual(text, '', "text should be empty")
})

await test("rejects invalid date format (due:tomorrow)", () => {
    const { meta, text } = parseMeta("Task due:tomorrow")
    assertEqual(Object.keys(meta).length, 0, "invalid due should not be extracted")
    assertEqual(text, 'Task due:tomorrow', "text should be unchanged")
})

await test("rejects invalid date format (due:2026/08/05)", () => {
    const { meta, text } = parseMeta("Task due:2026/08/05")
    assertEqual(Object.keys(meta).length, 0, "invalid due should not be extracted")
    assertEqual(text, 'Task due:2026/08/05', "text should be unchanged")
})

await test("rejects invalid date format (due:2026-8-5)", () => {
    const { meta, text } = parseMeta("Task due:2026-8-5")
    assertEqual(Object.keys(meta).length, 0, "invalid due should not be extracted")
    assertEqual(text, 'Task due:2026-8-5', "text should be unchanged")
})

await test("rejects invalid calendar dates", () => {
    const { meta, text } = parseMeta("Task due:2026-02-30")
    assertEqual(Object.keys(meta).length, 0, "invalid calendar date should not be extracted")
    assertEqual(text, 'Task due:2026-02-30', "text should be unchanged")
})

await test("first match wins — last on line wins", () => {
    const { meta, text } = parseMeta("Task due:2026-08-05 due:2026-08-06")
    assertEqual(meta.due, '2026-08-06', "last due on line should win")
    assertEqual(text, 'Task', "all extracted tokens removed from text")
})

await test("stops at non-matching token after due", () => {
    const { meta, text } = parseMeta("Task due:2026-08-05 priority:high")
    assertEqual(Object.keys(meta).length, 0, "unregistered property stops scan before due")
    assertEqual(text, 'Task due:2026-08-05 priority:high', "text should be unchanged")
})

await test("stops at tag after due", () => {
    const { meta, text } = parseMeta("Task due:2026-08-05 #todo")
    assertEqual(Object.keys(meta).length, 0, "tag stops scan before due")
    assertEqual(text, 'Task due:2026-08-05 #todo', "text should be unchanged")
})

await test("stops at mention after due", () => {
    const { meta, text } = parseMeta("Task due:2026-08-05 @alice")
    assertEqual(Object.keys(meta).length, 0, "mention stops scan before due")
    assertEqual(text, 'Task due:2026-08-05 @alice', "text should be unchanged")
})

await test("unregistered property is not extracted", () => {
    const { meta, text } = parseMeta("Task priority:low")
    assertEqual(Object.keys(meta).length, 0, "unregistered property should not be extracted")
    assertEqual(text, 'Task priority:low', "text should be unchanged")
})

await test("due not at token boundary is not extracted", () => {
    const { meta, text } = parseMeta("Task due:2026-08-05x")
    assertEqual(Object.keys(meta).length, 0, "due with trailing chars should not be extracted")
    assertEqual(text, 'Task due:2026-08-05x', "text should be unchanged")
})

await test("multiple due tokens all extracted, last wins", () => {
    const { meta, text } = parseMeta("Task due:2026-08-05 due:2026-08-06 due:2026-08-07")
    assertEqual(meta.due, '2026-08-07', "last due should win")
    assertEqual(text, 'Task', "all due tokens removed")
})

section("formatMeta")

await test("formatMeta appends due to text", () => {
    const result = formatMeta("Buy milk", { due: '2026-08-05' })
    assertEqual(result, "Buy milk due:2026-08-05", "due should be appended")
})

await test("formatMeta with empty meta returns text unchanged", () => {
    const result = formatMeta("Buy milk", {})
    assertEqual(result, "Buy milk", "text should be unchanged")
})

await test("formatMeta round-trips with parseMeta", () => {
    const original = "Buy milk due:2026-08-05"
    const { meta, text } = parseMeta(original)
    assertEqual(formatMeta(text, meta), original, "round-trip should reproduce original")
})

section("isOverdue")

await test("past date is overdue", () => {
    assert(isOverdue('2026-08-04', new Date('2026-08-05T12:00:00')), "yesterday should be overdue")
})

await test("today is not overdue", () => {
    assert(!isOverdue('2026-08-05', new Date('2026-08-05T12:00:00')), "today should not be overdue")
})

await test("future date is not overdue", () => {
    assert(!isOverdue('2026-08-06', new Date('2026-08-05T12:00:00')), "tomorrow should not be overdue")
})

await test("invalid date is not overdue", () => {
    assert(!isOverdue('not-a-date', new Date('2026-08-05T12:00:00')), "invalid date should not be overdue")
})

section("formatDueDate")

await test("formats yyyy-MM-dd to human-readable", () => {
    assertEqual(formatDueDate('2026-08-05', new Date('2026-08-05T12:00:00')), 'Aug 5', "should format to short date")
})

await test("formats with year when not current year", () => {
    assertEqual(formatDueDate('2025-12-31', new Date('2026-08-05T12:00:00')), 'Dec 31, 2025', "should include year when different")
})
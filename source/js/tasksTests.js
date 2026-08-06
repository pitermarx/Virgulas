import outline from './outline.js'
import { groupedTasks, hasOverdueTasks } from './tasks.js'
import {
    assert,
    assertEqual,
    cloneSections,
    createAsyncSectionHarness,
    streamCompletedSections,
    summaryFromSections
} from './testing.js'

// ─── harness ──────────────────────────────────────────────────────────────────

const harness = createAsyncSectionHarness({
    beforeEach: () => outline.reset()
})
export const sections = harness.sections
const section = harness.section
const test = harness.test

export function summary() {
    return summaryFromSections(sections)
}

export async function streamTasksTests(onProgress) {
    return streamCompletedSections(cloneSections(sections), onProgress, 10)
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function node(id, text, overrides = {}) {
    return {
        id,
        parentId: 'root',
        text,
        description: '',
        children: [],
        open: true,
        lastModified: 0,
        ...overrides
    }
}

// deserialize bumps structureVersion, so groupedTasks re-evaluates immediately
function setupDoc(...nodes) {
    outline.deserialize(JSON.stringify({
        modelVersion: 'v1',
        dataVersion: 0,
        nodes: [
            { id: 'root', parentId: null, text: '', description: '', children: nodes.map(n => n.id), open: true, lastModified: 0 },
            ...nodes
        ]
    }))
}

function daysFromNow(days) {
    const d = new Date()
    d.setDate(d.getDate() + days)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

// ─── tests ────────────────────────────────────────────────────────────────────

section("groupedTasks — due metadata")

await test("task with due:... has due field and stripped text", () => {
    const due = daysFromNow(3)
    setupDoc(node('t1', `Buy milk due:${due}`, { done: false }))
    const pending = groupedTasks.value.pending
    assertEqual(pending.length, 1, "one pending task")
    assertEqual(pending[0].text, 'Buy milk', "due token stripped from text")
    assertEqual(pending[0].due, due, "due field set")
})

await test("task without due has no due field", () => {
    setupDoc(node('t1', 'Buy milk', { done: false }))
    const pending = groupedTasks.value.pending
    assertEqual(pending[0].due, undefined, "no due field")
    assertEqual(pending[0].text, 'Buy milk', "text unchanged")
})

await test("overdue pending tasks sort before non-overdue", () => {
    const overdue = daysFromNow(-1)
    const future = daysFromNow(3)
    setupDoc(
        node('t1', `Future task due:${future}`, { done: false }),
        node('t2', `Overdue task due:${overdue}`, { done: false })
    )
    const pending = groupedTasks.value.pending
    assertEqual(pending[0].id, 't2', "overdue task first")
    assertEqual(pending[1].id, 't1', "future task second")
})

await test("overdue tasks sort by due date ascending (most overdue first)", () => {
    const older = daysFromNow(-5)
    const newer = daysFromNow(-1)
    setupDoc(
        node('t1', `Newer overdue due:${newer}`, { done: false }),
        node('t2', `Older overdue due:${older}`, { done: false })
    )
    const pending = groupedTasks.value.pending
    assertEqual(pending[0].id, 't2', "older overdue first")
    assertEqual(pending[1].id, 't1', "newer overdue second")
})

await test("non-overdue dated tasks sort by due date ascending", () => {
    const later = daysFromNow(5)
    const sooner = daysFromNow(1)
    setupDoc(
        node('t1', `Later due:${later}`, { done: false }),
        node('t2', `Sooner due:${sooner}`, { done: false })
    )
    const pending = groupedTasks.value.pending
    assertEqual(pending[0].id, 't2', "sooner due first")
    assertEqual(pending[1].id, 't1', "later due second")
})

await test("tasks without due come after dated tasks", () => {
    const future = daysFromNow(3)
    setupDoc(
        node('t1', 'No due date', { done: false }),
        node('t2', `Dated due:${future}`, { done: false })
    )
    const pending = groupedTasks.value.pending
    assertEqual(pending[0].id, 't2', "dated task first")
    assertEqual(pending[1].id, 't1', "undated task second")
})

section("hasOverdueTasks")

await test("true when an overdue pending task exists", () => {
    setupDoc(node('t1', `Overdue due:${daysFromNow(-1)}`, { done: false }))
    assert(hasOverdueTasks.value, "should be true with overdue pending task")
})

await test("false when only future-dated pending tasks exist", () => {
    setupDoc(node('t1', `Future due:${daysFromNow(3)}`, { done: false }))
    assert(!hasOverdueTasks.value, "should be false with only future tasks")
})

await test("false when only undated pending tasks exist", () => {
    setupDoc(node('t1', 'No due', { done: false }))
    assert(!hasOverdueTasks.value, "should be false with undated tasks")
})

await test("false when overdue task is done", () => {
    setupDoc(node('t1', `Overdue done due:${daysFromNow(-1)}`, { done: true }))
    assert(!hasOverdueTasks.value, "done overdue task should not count")
})
import outline from './outline.js'
// Side-effect imports: force suites that also mutate the shared outline
// singleton (zoom, children) to fully settle before this module's own tests
// run, since concurrently-evaluating ES modules would otherwise interleave.
import './outlineTests.js'
import './shortcutsTests.js'
import { groupedTasks, hasOverdueTasks, pendingTaskCount } from './tasks.js'
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

await test("task with a future due:... is scheduled, with due field and stripped text", () => {
    const due = daysFromNow(3)
    setupDoc(node('t1', `Buy milk due:${due}`, { done: false }))
    const scheduled = groupedTasks.value.scheduled
    assertEqual(scheduled.length, 1, "one scheduled task")
    assertEqual(scheduled[0].text, 'Buy milk', "due token stripped from text")
    assertEqual(scheduled[0].due, due, "due field set")
})

await test("task without due has no due field", () => {
    setupDoc(node('t1', 'Buy milk', { done: false }))
    const pending = groupedTasks.value.pending
    assertEqual(pending[0].due, undefined, "no due field")
    assertEqual(pending[0].text, 'Buy milk', "text unchanged")
})

await test("overdue pending tasks sort before undated pending tasks", () => {
    const overdue = daysFromNow(-1)
    setupDoc(
        node('t1', 'No due date', { done: false }),
        node('t2', `Overdue task due:${overdue}`, { done: false })
    )
    const pending = groupedTasks.value.pending
    assertEqual(pending[0].id, 't2', "overdue task first")
    assertEqual(pending[1].id, 't1', "undated task second")
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

await test("non-overdue dated (scheduled) tasks sort by due date ascending", () => {
    const later = daysFromNow(5)
    const sooner = daysFromNow(1)
    setupDoc(
        node('t1', `Later due:${later}`, { done: false }),
        node('t2', `Sooner due:${sooner}`, { done: false })
    )
    const scheduled = groupedTasks.value.scheduled
    assertEqual(scheduled[0].id, 't2', "sooner due first")
    assertEqual(scheduled[1].id, 't1', "later due second")
})

await test("undated pending tasks and future scheduled tasks are kept in separate groups", () => {
    const future = daysFromNow(3)
    setupDoc(
        node('t1', 'No due date', { done: false }),
        node('t2', `Dated due:${future}`, { done: false })
    )
    assertEqual(groupedTasks.value.pending.map(i => i.id).join(','), 't1', "undated task stays pending")
    assertEqual(groupedTasks.value.scheduled.map(i => i.id).join(','), 't2', "future dated task is scheduled")
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

section("groupedTasks — pending/scheduled split")

await test("task with no due date is pending", () => {
    setupDoc(node('t1', 'No due date', { done: false }))
    assertEqual(groupedTasks.value.pending.length, 1, "goes to pending")
    assertEqual(groupedTasks.value.scheduled.length, 0, "not scheduled")
})

await test("task due today is pending, not scheduled", () => {
    setupDoc(node('t1', `Due today due:${daysFromNow(0)}`, { done: false }))
    assertEqual(groupedTasks.value.pending.length, 1, "goes to pending")
    assertEqual(groupedTasks.value.scheduled.length, 0, "not scheduled")
})

await test("overdue task is pending, not scheduled", () => {
    setupDoc(node('t1', `Overdue due:${daysFromNow(-2)}`, { done: false }))
    assertEqual(groupedTasks.value.pending.length, 1, "goes to pending")
    assertEqual(groupedTasks.value.scheduled.length, 0, "not scheduled")
})

await test("task with a future due date is scheduled, not pending", () => {
    setupDoc(node('t1', `Future due:${daysFromNow(10)}`, { done: false }))
    assertEqual(groupedTasks.value.pending.length, 0, "not pending")
    assertEqual(groupedTasks.value.scheduled.length, 1, "goes to scheduled")
})

await test("scheduled tasks sort by due date ascending", () => {
    setupDoc(
        node('t1', `Later due:${daysFromNow(30)}`, { done: false }),
        node('t2', `Sooner due:${daysFromNow(10)}`, { done: false })
    )
    const scheduled = groupedTasks.value.scheduled
    assertEqual(scheduled[0].id, 't2', "sooner scheduled task first")
    assertEqual(scheduled[1].id, 't1', "later scheduled task second")
})

await test("done task never appears in scheduled even with a future due date", () => {
    setupDoc(node('t1', `Future due:${daysFromNow(10)}`, { done: true }))
    assertEqual(groupedTasks.value.scheduled.length, 0, "done tasks go to done, not scheduled")
    assertEqual(groupedTasks.value.done.length, 1, "goes to done")
})

await test("pendingTaskCount includes both pending and scheduled", () => {
    setupDoc(
        node('t1', 'No due', { done: false }),
        node('t2', `Future due:${daysFromNow(10)}`, { done: false })
    )
    assertEqual(pendingTaskCount.value, 2, "counts pending + scheduled")
})

await test("scheduled item carries rec metadata", () => {
    setupDoc(node('t1', `Pay bill due:${daysFromNow(10)} rec:1m`, { done: false }))
    assertEqual(groupedTasks.value.scheduled[0].rec, '1m', "rec should be exposed on the item")
})

section("groupedTasks — zoom scoping")

await test("tasks outside the zoomed subtree are excluded", () => {
    outline.deserialize(JSON.stringify({
        modelVersion: 'v1',
        dataVersion: 0,
        nodes: [
            { id: 'root', parentId: null, text: '', description: '', children: ['a', 'b'], open: true, lastModified: 0 },
            { id: 'a', parentId: 'root', text: 'Section A', description: '', children: ['ta'], open: true, lastModified: 0 },
            { id: 'ta', parentId: 'a', text: 'Task in A', description: '', children: [], open: true, lastModified: 0, done: false },
            { id: 'b', parentId: 'root', text: 'Section B', description: '', children: ['tb'], open: true, lastModified: 0 },
            { id: 'tb', parentId: 'b', text: 'Task in B', description: '', children: [], open: true, lastModified: 0, done: false }
        ]
    }))
    assertEqual(groupedTasks.value.pending.length, 2, "both tasks visible at root zoom")
    outline.zoomIn('a')
    assertEqual(groupedTasks.value.pending.length, 1, "only task in zoomed subtree A is visible")
    assertEqual(groupedTasks.value.pending[0].id, 'ta', "task in A remains")
})

await test("the zoomed node itself is included if it is a task", () => {
    outline.deserialize(JSON.stringify({
        modelVersion: 'v1',
        dataVersion: 0,
        nodes: [
            { id: 'root', parentId: null, text: '', description: '', children: ['ta'], open: true, lastModified: 0 },
            { id: 'ta', parentId: 'root', text: 'Task itself', description: '', children: [], open: true, lastModified: 0, done: false }
        ]
    }))
    outline.zoomIn('ta')
    assertEqual(groupedTasks.value.pending.length, 1, "zoomed task node itself is included")
})
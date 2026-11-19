import { describe, it, beforeEach } from 'bun:test'
// perf-08: the size-limit budget guard. Timings are machine-dependent, so the
// suite is skipped under CI and acts as a local guardrail: it fails when a
// change makes one of the document-scale operations an order of magnitude
// slower than the recorded baseline (20k nodes, Bun, 2026-11):
//   build ~170 ms, serialize ~18-45 ms, getAllTasks ~4 ms.
import outline from '../../../source/js/outline.js'
import { taskStats } from '../../../source/js/tasks.js'

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
const NODES = 20_000

beforeEach(() => {
    outline.reset()
    // A huge fixture never needs the debounce to fire (~11 days, within
    // setTimeout's 32-bit range).
    outline.dirtyDebounceTimeout = 1_000_000_000
})

describe('document-scale budgets (perf-08)', () => {

    it('builds a 20k-node document in the hundreds of milliseconds, not seconds', () => {
        const start = performance.now()
        for (let i = 0; i < NODES; i++) {
            outline.addChild('root', { id: `n${i}`, text: `Task ${i} due:2030-01-01` })
        }
        const elapsed = performance.now() - start
        if (env.CI) return
        console.log(`[perf-08] build 20k: ${elapsed.toFixed(1)}ms (budget 2000ms)`)
        if (elapsed > 2000) throw new Error(`build 20k nodes took ${elapsed.toFixed(1)}ms (budget 2000ms)`)
    })

    it('serializes the 20k-node document in well under half a second', () => {
        for (let i = 0; i < NODES; i++) {
            outline.addChild('root', { id: `n${i}`, text: `Task ${i} due:2030-01-01` })
        }
        const start = performance.now()
        const json = outline.serialize()
        const elapsed = performance.now() - start
        if (env.CI) return
        console.log(`[perf-08] serialize 20k: ${elapsed.toFixed(1)}ms, ${json.length} bytes (budget 500ms)`)
        if (elapsed > 500) throw new Error(`serialize 20k nodes took ${elapsed.toFixed(1)}ms (budget 500ms)`)
    })

    it('collects task stats over 20k task nodes in the tens of milliseconds', () => {
        for (let i = 0; i < NODES; i++) {
            outline.addChild('root', { id: `n${i}`, text: `Task ${i} due:2030-01-01`, done: false })
        }
        const start = performance.now()
        const stats = taskStats.value
        const elapsed = performance.now() - start
        if (env.CI) return
        console.log(`[perf-08] taskStats 20k: ${elapsed.toFixed(1)}ms, open=${stats.open} (budget 200ms)`)
        if (stats.open !== NODES) throw new Error(`expected ${NODES} open tasks, got ${stats.open}`)
        if (elapsed > 200) throw new Error(`taskStats over 20k nodes took ${elapsed.toFixed(1)}ms (budget 200ms)`)
    })
})

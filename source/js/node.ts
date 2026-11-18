import { signal, createModel } from '@preact/signals'
import { parseMeta, advanceDueDate } from './meta.js'
import { log } from './utils.js'

// The per-node signal model. A node is
// { id, parentId, text, description, children[], open, done: boolean|null, lastModified }
// where every mutable field is a signal so the view updates field by field
// without replacing the document. This module owns nothing shared: the node map,
// zoom and document versions live in outline.ts, which composes nodes into a
// document.
// done: null = plain node (not a task), false = unchecked task, true = completed task

export type DoneState = boolean | null

export interface NodeInput {
    id?: string
    parentId?: string | null
    text?: string
    description?: string
    children?: string[]
    open?: boolean
    done?: DoneState
    lastModified?: number
}

export interface NodeUpdate {
    text?: string
    description?: string
    parentId?: string | null
    open?: boolean
    done?: DoneState
}

function nodeFactory(model: NodeInput = {}) {
    const id = model.id
    if (!id) {
        throw new Error('Node must have an id')
    }
    let parentId: string | null = model.parentId ?? null
    const text = signal(model.text || '')
    const description = signal(model.description || '')
    const children = signal<string[]>(model.children || [])
    const open = signal(model.open === undefined ? true : !!model.open)
    const done = signal<DoneState>(model.done !== undefined ? model.done : null)
    let lastModified = model.lastModified || 0

    // A pending task with rec:<n><y|m|w|d> and due:<date> advances its due date
    // instead of becoming done. Returns true if it advanced (and thus handled the transition).
    function tryAdvanceRecurrence() {
        const raw = text.peek()
        const { meta } = parseMeta(raw)
        if (!meta.due || !meta.rec) return false
        const nextDue = advanceDueDate(meta.due, meta.rec)
        if (!nextDue) return false
        // Replace only the due value in place, preserving token order/spacing.
        text.value = raw.replace(`due:${meta.due}`, `due:${nextDue}`)
        lastModified = Date.now()
        return true
    }

    return {
        get id() {
            return id
        },
        get parentId() {
            return parentId
        },
        get text() {
            return text
        },
        get description() {
            return description
        },
        get children() {
            return children
        },
        get open() {
            return open
        },
        get done() {
            return done
        },
        get lastModified() {
            return lastModified
        },
        get value() {
            return {
                id,
                parentId,
                text: text.value,
                description: description.value,
                children: children.value,
                open: open.value,
                done: done.value,
                lastModified
            }
        },
        peek() {
            return {
                id,
                parentId,
                text: text.peek(),
                description: description.peek(),
                children: children.peek(),
                open: open.peek(),
                done: done.peek(),
                lastModified
            }
        },
        toggleOpen() {
            open.value = !open.peek()
            lastModified = Date.now()
        },
        toggleDone() {
            const current = done.peek()
            if (current === null) { done.value = false }
            else if (current === false) {
                if (!tryAdvanceRecurrence()) done.value = true
            }
            else { done.value = null }  // cycle back to plain node
            lastModified = Date.now()
        },
        removeTaskMark() {
            done.value = null
            lastModified = Date.now()
        },
        checkboxToggleDone() {
            const current = done.peek()
            if (current === false && tryAdvanceRecurrence()) return
            // null → false (guard, promotes plain node), false → true, true → false. Never null.
            done.value = current === null ? false : !current
            lastModified = Date.now()
        },
        update(update: NodeUpdate) {
            let changed = false
            if (update.text !== undefined && update.text !== text.peek()) { text.value = update.text; changed = true }
            if (update.description !== undefined && update.description !== description.peek()) { description.value = update.description; changed = true }
            if (update.parentId !== undefined) parentId = update.parentId
            if (update.open !== undefined) open.value = !!update.open
            if (update.done !== undefined && update.done !== done.peek()) { done.value = update.done; changed = true }
            if (changed) lastModified = Date.now()
        },
        removeChild(childId: string) {
            children.value = children.peek().filter(id => id !== childId)
            lastModified = Date.now()
        },
        addChild(childId: string, index = -1) {
            const peek = children.peek()
            if (index < 0 || index >= peek.length) {
                children.value = [...peek, childId]
            } else {
                children.value = [...peek.slice(0, index), childId, ...peek.slice(index)]
            }
            lastModified = Date.now()
        },
        move(childId: string, direction: 'up' | 'down' = 'up') {
            const peek = children.peek()
            const index = peek.indexOf(childId)
            if (index === -1) {
                log('Child not found, cannot move')
                return
            }
            if (direction === 'up' && index > 0) {
                const newChildren = [...peek]
                const temp = newChildren[index - 1]
                newChildren[index - 1] = newChildren[index]
                newChildren[index] = temp
                children.value = newChildren
                lastModified = Date.now()
            } else if (direction === 'down' && index < peek.length - 1) {
                const newChildren = [...peek]
                const temp = newChildren[index + 1]
                newChildren[index + 1] = newChildren[index]
                newChildren[index] = temp
                children.value = newChildren
                lastModified = Date.now()
            } else {
                log('Cannot move child in that direction')
                return
            }
        },
        getChild(currentChildId: string, direction: 'next' | 'prev' = 'next'): string | null | undefined {
            const peek = children.peek()
            const index = peek.indexOf(currentChildId)
            if (index === -1) {
                log('Child not found, cannot get sibling')
                return null
            }
            if (direction === 'prev') {
                if (index <= 0) {
                    return null
                }
                return peek[index - 1]

            }
            else if (direction === 'next') {
                if (index === peek.length - 1) {
                    return null
                }
                return peek[index + 1]
            }
        },
    }
}

type NodeModelShape = ReturnType<typeof nodeFactory>
export type Node = NodeModelShape & { [Symbol.dispose](): void }
const NodeModel = createModel(nodeFactory as unknown as (...args: any[]) => any) as unknown as new (model?: NodeInput) => Node
export { NodeModel }

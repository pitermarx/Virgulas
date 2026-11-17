// The blocking sync-conflict dialog.

import { html } from 'htm/preact'
import { pendingConflicts, pendingMergedDoc, pendingConflictResolutions, resolveConflicts, type ConflictResolution } from '../js/syncEngine.js'

export function ConflictModal() {
    const conflicts = pendingConflicts.value
    if (conflicts.length === 0) return null

    function choose(nodeId: string, field: string, side: 'local' | 'remote') {
        const m = new Map(pendingConflictResolutions.peek())
        m.set(`${nodeId}::${field}`, side)
        pendingConflictResolutions.value = m
    }

    function useAll(side: 'local' | 'remote') {
        const m = new Map()
        for (const c of conflicts) {
            m.set(`${c.nodeId}::${c.field}`, side)
        }
        pendingConflictResolutions.value = m
    }

    function allResolved() {
        const m = pendingConflictResolutions.value
        return conflicts.every(c => m.has(`${c.nodeId}::${c.field}`))
    }

    async function apply() {
        if (!allResolved()) return
        const m = pendingConflictResolutions.peek()
        const resList = conflicts
            .map(c => ({
                nodeId: c.nodeId,
                field: c.field,
                chosenSide: m.get(`${c.nodeId}::${c.field}`)
            }))
            .filter((r): r is ConflictResolution => r.chosenSide !== undefined)
        await resolveConflicts(resList)
    }

    function renderValue(field: string, value: any) {
        if (field === 'children') {
            const doc = pendingMergedDoc.peek()
            const nodeMap = doc ? new Map(doc.nodes.map(n => [n.id, n])) : new Map()
            const ids = Array.isArray(value) ? value : []
            return html`<ul class="conflict-children-list">
                ${ids.map(id => html`<li>${nodeMap.get(id)?.text || id}</li>`)}
            </ul>`
        }
        if (field === 'done') {
            return html`<div class="conflict-scalar">${value === true ? 'Done' : 'Pending'}</div>`
        }
        if (field === 'parentId') {
            const doc = pendingMergedDoc.peek()
            const parent = doc?.nodes.find(n => n.id === value)
            return html`<div class="conflict-scalar">${value ? (parent?.text || value) : 'Top level'}</div>`
        }
        return html`<textarea class="conflict-value-textarea" readonly rows="4">${value}</textarea>`
    }

    const fieldLabels: Record<string, string> = {
        text: 'Text',
        description: 'Description',
        children: 'Children',
        done: 'Task state',
        parentId: 'Parent'
    }

    return html`<div class="modal-overlay conflict-overlay">
        <div class="modal-dialog conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
            <div class="modal-header">
                <h2 id="conflict-title" class="modal-title">Sync conflicts (${conflicts.length})</h2>
            </div>
            <div class="conflict-body">
                ${conflicts.map(c => {
        const key = `${c.nodeId}::${c.field}`
        const chosen = pendingConflictResolutions.value.get(key)
        return html`<div class="conflict-item">
                        <div class="conflict-node-label">
                            <strong>${c.nodeText || '(no text)'}</strong>
                            <span class="conflict-field-label">${fieldLabels[c.field] || c.field}</span>
                        </div>
                        <div class="conflict-sides">
                            <div class=${'conflict-side' + (chosen === 'local' ? ' conflict-side-chosen' : '')}>
                                <div class="conflict-side-header">Local</div>
                                ${renderValue(c.field, c.localValue)}
                                <button class="btn btn-secondary conflict-keep-btn"
                                    onClick=${() => choose(c.nodeId, c.field, 'local')}>
                                    Keep local
                                </button>
                            </div>
                            <div class=${'conflict-side' + (chosen === 'remote' ? ' conflict-side-chosen' : '')}>
                                <div class="conflict-side-header">Remote</div>
                                ${renderValue(c.field, c.remoteValue)}
                                <button class="btn btn-secondary conflict-keep-btn"
                                    onClick=${() => choose(c.nodeId, c.field, 'remote')}>
                                    Keep remote
                                </button>
                            </div>
                        </div>
                    </div>`
    })}
            </div>
            <div class="conflict-footer">
                <button class="btn btn-secondary" onClick=${() => useAll('local')}>Use all local</button>
                <button class="btn btn-secondary" onClick=${() => useAll('remote')}>Use all remote</button>
                <button class="btn btn-primary" disabled=${!allResolved()} onClick=${apply}>Apply</button>
            </div>
        </div>
    </div>`
}

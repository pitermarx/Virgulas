// Document codecs — the serialization boundary of the storage seam
// (docs/storage-interface.md §4.6, rollout PR 1).
//
// A codec converts between an OutlineDoc value (the plain node-tree document
// the rest of the app handles) and its text representation. Serialization is
// owned by exactly these two implementations:
//
//   - jsonCodec: the Local/Remote/Memory at-rest format emitted by
//     outline.serialize() and loaded by outline.deserialize()
//   - vmdCodec: the File-mode/export format emitted by outline.getVMD('root')
//     and parsed by outline.setRootVMD()
//
// All future format versioning and migrations live in this module and nowhere
// else. Everything above this seam (stores, orchestration, UI) handles only
// the OutlineDoc model — serialized text never crosses it.
//
// Note (review finding 4 of the storage-interface rollout): the design doc
// specifies that parse failures throw StoreError('invalid-document'), but the
// StoreError taxonomy arrives with the contracts module (PR 2a). Until then
// these codecs throw the same typed errors the app already surfaces —
// CorruptDocumentError and UnsupportedVersionError — so the mapping in PR 2a
// is a pure re-wrap with the original error preserved as `cause`.

import { CorruptDocumentError, MODEL_VERSION } from './outline.js'
import { UnsupportedVersionError } from './crypto2.js'

/** A serialized document node — the shape outline.serialize() emits. */
export interface OutlineNode {
    id: string
    parentId?: string | null
    text?: string
    description?: string
    children?: string[]
    open?: boolean
    done?: boolean | null
    lastModified?: number
    [key: string]: any
}

/**
 * A whole document value: the node list (always including the 'root' node)
 * plus any document-level metadata (modelVersion, dataVersion, …).
 */
export interface OutlineDoc {
    nodes: OutlineNode[]
    [key: string]: any
}

export interface DocCodec {
    serialize(doc: OutlineDoc): string
    /** Validates; throws CorruptDocumentError / UnsupportedVersionError. */
    parse(text: string): OutlineDoc
}

// ── jsonCodec ────────────────────────────────────────────────────────────────

/**
 * Mirrors the throwing validation of outline.deserialize() (bad JSON, missing
 * model version, version mismatch, invalid node list, invalid node entries,
 * missing root node) without touching the live outline. The deeper
 * sanitisation deserialize performs when loading a document into the model
 * (dropping orphan nodes, pruning invalid children) is model behaviour and
 * stays there; the codec validates shape only.
 */
function parseJsonDoc(text: string): OutlineDoc {
    let obj: any
    try {
        obj = JSON.parse(text)
    } catch {
        throw new CorruptDocumentError('The document is not valid JSON.')
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new CorruptDocumentError()
    }
    if (typeof obj.modelVersion !== 'string') {
        throw new CorruptDocumentError('The document has no model version.')
    }
    if (obj.modelVersion !== MODEL_VERSION) {
        throw new UnsupportedVersionError(`This document uses unsupported model version ${obj.modelVersion}. Reload the app to get the latest version.`)
    }
    if (!Array.isArray(obj.nodes)) {
        throw new CorruptDocumentError('The document has an invalid node list.')
    }
    for (const nodeData of obj.nodes) {
        if (!nodeData || typeof nodeData !== 'object' || Array.isArray(nodeData)
            || typeof nodeData.id !== 'string' || !nodeData.id
            || (nodeData.children !== undefined && !Array.isArray(nodeData.children))) {
            throw new CorruptDocumentError('The document contains an invalid node.')
        }
    }
    if (!obj.nodes.some((node: OutlineNode) => node.id === 'root')) {
        throw new CorruptDocumentError('The document is missing its root node.')
    }
    return obj
}

export const jsonCodec: DocCodec = {
    serialize(doc) {
        return JSON.stringify(doc)
    },
    parse: parseJsonDoc
}

// ── vmdCodec ─────────────────────────────────────────────────────────────────

// Pure mirror of outline.getVMD()'s writer. The root node itself is never
// rendered (it carries no text); its children start at indent level 0.
function nodeToVmd(node: OutlineNode, level: number, byId: Map<string, OutlineNode>): string {
    let result = ''
    const children = node.children || []
    // undefined open means open (outline.serialize() omits `open` when true)
    const open = node.open === undefined ? true : !!node.open
    const indent = '  '.repeat(level)
    const bullet = (children.length > 0 && !open) ? '+' : '-'
    let vmdText = node.text || ''
    if (node.done !== null && node.done !== undefined) {
        vmdText = `${node.done ? '[x]' : '[ ]'} ${vmdText}`
    }
    result += `${indent}${bullet} ${vmdText}\n`

    if (node.description) {
        const descIndent = '  '.repeat(level + 1)
        for (const line of node.description.split('\n')) {
            result += `${descIndent}${line}\n`
        }
    }

    for (const childId of children) {
        const child = byId.get(childId)
        if (child) result += nodeToVmd(child, level + 1, byId)
    }
    return result
}

/** Split a `[x]` / `[ ]` checkbox prefix off a node line (outline.parseNodeLine). */
function parseNodeLine(rawNodeText: string): { text: string; done: boolean | null } {
    let nodeText = rawNodeText.trim()
    let done: boolean | null = null
    const cbMatch = nodeText.match(/^\[([ xX])\]\s*(.*)/)
    if (cbMatch) {
        done = cbMatch[1].toLowerCase() === 'x'
        nodeText = cbMatch[2].trim()
    }
    return { text: nodeText, done }
}

/**
 * Positional node ID, identical to outline.vmdNodeId(): VMD carries no node
 * IDs, so a node's path in the tree is its stable identity across re-parses
 * (URL hashes referencing a node survive a reload). A child extends its
 * parent's ID instead of re-prefixing it (`v_root_0_0`, not `v_v_root_0_0`).
 */
function vmdNodeId(parentId: string, siblingIndex: number): string {
    return parentId.startsWith('v_') ? `${parentId}_${siblingIndex}` : `v_${parentId}_${siblingIndex}`
}

/**
 * Pure mirror of outline.setRootVMD()'s parser (the File/import path — note
 * outline.setVMD, the per-node editor path, uses a different escape prefix
 * and is deliberately NOT mirrored here). Builds a fresh node tree under an
 * implicit 'root'; throws CorruptDocumentError when a description line has no
 * preceding node bullet.
 */
function parseVmdDoc(text: string): OutlineDoc {
    const root: OutlineNode = { id: 'root', children: [] }
    const nodes: OutlineNode[] = [root]
    const stack: { node: OutlineNode; indentLen: number }[] = [{ node: root, indentLen: -1 }]

    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue

        const match = line.match(/^(\s*)([-+])\s?(.*)$/)
        if (match) {
            const [, indentStr, bullet, rawNodeText] = match
            const indentLen = indentStr.length
            const parsed = parseNodeLine(rawNodeText)

            // Pop stack until we find the right parent level
            while (stack.length > 1 && stack[stack.length - 1].indentLen >= indentLen) {
                stack.pop()
            }

            const parentEntry = stack[stack.length - 1]
            const siblings = parentEntry.node.children!
            const node: OutlineNode = {
                id: vmdNodeId(parentEntry.node.id, siblings.length),
                parentId: parentEntry.node.id,
                text: parsed.text,
                done: parsed.done,
                open: bullet === '-',
                children: []
            }
            siblings.push(node.id)
            nodes.push(node)
            stack.push({ node, indentLen })
            continue
        }

        // Description lines must belong to a previously parsed node.
        if (stack.length === 1) {
            throw new CorruptDocumentError('Invalid VMD: each description line must belong to a node.')
        }

        const lastNode = stack[stack.length - 1].node
        let trimmed = line.trim()
        if (trimmed.startsWith('\\-') || trimmed.startsWith('\\+') || trimmed.startsWith('\\\\')) {
            // remove the escape character so description lines can look like bullets
            trimmed = trimmed.substring(1)
        }
        if (trimmed) {
            lastNode.description = lastNode.description ? `${lastNode.description}\n${trimmed}` : trimmed
        }
    }

    return { nodes }
}

export const vmdCodec: DocCodec = {
    serialize(doc) {
        const byId = new Map(doc.nodes.map(node => [node.id, node]))
        const root = byId.get('root')
        if (!root) throw new CorruptDocumentError('The document is missing its root node.')
        let result = ''
        for (const childId of root.children || []) {
            const child = byId.get(childId)
            if (child) result += nodeToVmd(child, 0, byId)
        }
        return result
    },
    parse: parseVmdDoc
}

// Document codecs — the serialization boundary of the storage seam
// (docs/storage-interface.md §4.6, rollout PR 1).
//
// A codec converts between an OutlineDoc value (the plain node-tree document
// the rest of the app handles) and its text representation. Serialization is
// owned by exactly these two implementations:
//
//   - jsonCodec: the Local/Remote/Memory at-rest format emitted by
//     outline.serialize() and loaded by outline.deserialize()
//   - vmdCodec: the File-mode/export format. The VMD parser/writer is the
//     single implementation; outline.getVMD() and outline.setRootVMD()
//     delegate to it (outline.setVMD keeps its per-node editor escape path).
//
// All future format versioning and migrations live in this module and nowhere
// else. Everything above this seam (stores, orchestration, UI) handles only
// the OutlineDoc model — serialized text never crosses it.
//
// codecStore() lifts a StringStore into a DocStore: read → parse,
// write → serialize, token passthrough.

import { CorruptDocumentError, MODEL_VERSION } from './model.js'
import { UnsupportedVersionError } from './crypto2.js'
import { StoreError, type DocStore, type StringStore } from './storage.js'

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
    /** Validates; throws StoreError('invalid-document' | 'unsupported-runtime'),
     * with the underlying typed error preserved as `cause`. */
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
    try {
        return validateJsonDoc(JSON.parse(text))
    } catch (error) {
        if (error instanceof StoreError) throw error
        throw new StoreError('invalid-document', 'The document is not valid JSON.', new CorruptDocumentError('The document is not valid JSON.'))
    }
}

function validateJsonDoc(obj: any): OutlineDoc {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new StoreError('invalid-document', 'The document is not a valid document object.', new CorruptDocumentError())
    }
    if (typeof obj.modelVersion !== 'string') {
        throw new StoreError('invalid-document', 'The document has no model version.', new CorruptDocumentError('The document has no model version.'))
    }
    if (obj.modelVersion !== MODEL_VERSION) {
        throw new StoreError('unsupported-runtime', `This document uses unsupported model version ${obj.modelVersion}. Reload the app to get the latest version.`,
            new UnsupportedVersionError(`This document uses unsupported model version ${obj.modelVersion}. Reload the app to get the latest version.`))
    }
    if (!Array.isArray(obj.nodes)) {
        throw new StoreError('invalid-document', 'The document has an invalid node list.', new CorruptDocumentError('The document has an invalid node list.'))
    }
    for (const nodeData of obj.nodes) {
        if (!nodeData || typeof nodeData !== 'object' || Array.isArray(nodeData)
            || typeof nodeData.id !== 'string' || !nodeData.id
            || (nodeData.children !== undefined && !Array.isArray(nodeData.children))) {
            throw new StoreError('invalid-document', 'The document contains an invalid node.', new CorruptDocumentError('The document contains an invalid node.'))
        }
    }
    if (!obj.nodes.some((node: OutlineNode) => node.id === 'root')) {
        throw new StoreError('invalid-document', 'The document is missing its root node.', new CorruptDocumentError('The document is missing its root node.'))
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

/** A node as the VMD writer reads it: the subset shared by serialized
 * OutlineNodes and the live outline model's snapshots. */
export interface VmdNodeSource {
    text?: string
    description?: string
    done?: boolean | null
    open?: boolean
    children?: string[]
}

/**
 * Renders one node subtree as VMD. `level` is the node's own indent; a
 * negative level marks a container root (the document root or a zoom root)
 * that is not rendered itself, so its children start at level 0. A missing
 * node renders as ''. Shared by vmdCodec and outline.getVMD(), so the File /
 * export format and the live editor cannot drift apart.
 */
export function writeVmd(
    nodeId: string,
    lookup: (id: string) => VmdNodeSource | undefined,
    level = -1
): string {
    const node = lookup(nodeId)
    if (!node) return ''
    const children = node.children || []
    let result = ''
    if (level >= 0) {
        const indent = '  '.repeat(level)
        // undefined open means open (outline.serialize() omits `open` when true)
        const open = node.open === undefined ? true : !!node.open
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
    }

    for (const childId of children) {
        result += writeVmd(childId, lookup, level + 1)
    }
    return result
}

/** Split a `[x]` / `[ ]` checkbox prefix off a node line. */
export function parseVmdNodeLine(rawNodeText: string): { text: string; done: boolean | null } {
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
 * Positional node ID: VMD carries no node IDs, so a node's path in the tree is
 * its stable identity across re-parses (URL hashes referencing a node survive
 * a reload). A child extends its parent's ID instead of re-prefixing it
 * (`v_root_0_0`, not `v_v_root_0_0`).
 */
export function vmdNodeId(parentId: string, siblingIndex: number): string {
    return parentId.startsWith('v_') ? `${parentId}_${siblingIndex}` : `v_${parentId}_${siblingIndex}`
}

/**
 * The pure VMD parser (the File/import/root path). Builds a fresh node tree
 * under an implicit 'root'; throws StoreError('invalid-document') when a
 * description line has no preceding node bullet. outline.setRootVMD() replays
 * this tree onto its zoom root, so both import paths share one parser.
 *
 * Note: outline.setVMD, the per-node editor path, uses a different backtick
 * escape and is deliberately NOT shared.
 */
export function parseVmdTree(text: string): OutlineDoc {
    const root: OutlineNode = { id: 'root', children: [] }
    const nodes: OutlineNode[] = [root]
    const stack: { node: OutlineNode; indentLen: number }[] = [{ node: root, indentLen: -1 }]

    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue

        const match = line.match(/^(\s*)([-+])\s?(.*)$/)
        if (match) {
            const [, indentStr, bullet, rawNodeText] = match
            const indentLen = indentStr.length
            const parsed = parseVmdNodeLine(rawNodeText)

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
            throw new StoreError('invalid-document', 'Invalid VMD: each description line must belong to a node.',
                new CorruptDocumentError('Invalid VMD: each description line must belong to a node.'))
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
        if (!byId.has('root')) throw new StoreError('invalid-document', 'The document is missing its root node.',
            new CorruptDocumentError('The document is missing its root node.'))
        return writeVmd('root', id => byId.get(id))
    },
    parse: parseVmdTree
}

// ── codecStore — lift a StringStore into a DocStore (§4.6) ─────────────────

/** Lifts a StringStore into a DocStore: read → parse, write → serialize,
 * clear/exists/head and the lock lifecycle pass through untouched; unlock's
 * UnlockResult is returned as-is so the orchestration never needs the inner
 * store. */
export function codecStore(codec: DocCodec, inner: StringStore): DocStore {
    return {
        async read() {
            const text = await inner.read()
            return text === null ? null : codec.parse(text)
        },
        write(doc) {
            return inner.write(codec.serialize(doc))
        },
        clear() {
            return inner.clear()
        },
        exists() {
            return inner.exists()
        },
        async head() {
            return inner.head?.() ?? null
        },
        async unlock(passphrase) {
            return inner.unlock?.(passphrase)
        },
        async lock() {
            await inner.lock?.()
        },
        capabilities: inner.capabilities
    }
}

import { encrypt, decrypt } from './crypto2.js'
import { log } from './utils.js'

const LOCAL_BASE_KEY = 'vmd_sync_base_enc'

function getLocalBase() {
    const v = localStorage.getItem(LOCAL_BASE_KEY)
    if (!v) return null
    const idx = v.indexOf('|')
    if (idx === -1) return null
    return { salt: v.substring(0, idx), data: v.substring(idx + 1) }
}

function saveLocalBase(data, salt) {
    localStorage.setItem(LOCAL_BASE_KEY, salt + '|' + data)
}

function readConfig() {
    try {
        const raw = localStorage.getItem('supabaseconfig')
        if (!raw) return null
        const parsed = JSON.parse(raw)
        const url = parsed.url || parsed.supabaseUrl
        const key = parsed.key || parsed.supabaseAnonKey
        if (!url || !key) return null
        return { url, key }
    } catch { return null }
}

// Flatten a nested OutlineDoc tree to { [id]: flatNode }
function flattenDoc(doc) {
    const flatMap = {}
    function visit(node, parentId) {
        flatMap[node.id] = {
            id: node.id,
            text: node.text || '',
            description: node.description || '',
            collapsed: !!node.collapsed,
            updated_at: node.updated_at,
            open: node.open !== undefined ? node.open : (node.collapsed ? false : true),
            parentId,
            children: (node.children || []).map(c => c.id)
        }
        for (const child of node.children || []) {
            visit(child, node.id)
        }
    }
    visit(doc, null)
    return flatMap
}

// Build a nested OutlineDoc tree from a flat map
function buildTree(flatMap, nodeId) {
    const node = flatMap[nodeId]
    if (!node) return null
    const children = (node.children || [])
        .filter(cid => flatMap[cid])
        .map(cid => buildTree(flatMap, cid))
        .filter(Boolean)
    const result = { id: node.id, text: node.text, children }
    if (node.description) result.description = node.description
    if (node.updated_at) result.updated_at = node.updated_at
    if (node.collapsed) result.collapsed = node.collapsed
    return result
}

// 3-way merge: base, local, server → { mergedFlatMap, hasConflicts, conflicts }
function threeWayMerge(base, local, server) {
    const baseMap = base ? flattenDoc(base) : {}
    const localMap = flattenDoc(local)
    const serverMap = flattenDoc(server)

    const allIds = new Set([...Object.keys(localMap), ...Object.keys(serverMap)])
    const mergedFlatMap = {}
    const conflicts = []
    let hasConflicts = false

    for (const id of allIds) {
        const b = baseMap[id]
        const l = localMap[id]
        const s = serverMap[id]

        if (!l && !s) continue

        if (!s) {
            // In local, not in server
            if (!b) {
                // New node added by local — keep it
                mergedFlatMap[id] = { ...l }
            }
            // else: deleted by server — respect deletion
            continue
        }

        if (!l) {
            // In server, not in local
            if (!b) {
                // New node added by server — keep it
                mergedFlatMap[id] = { ...s }
            }
            // else: deleted by local — respect deletion
            continue
        }

        // Both sides have this node — merge field by field
        const merged = { ...l }

        // Merge text
        const bText = b ? b.text : l.text
        const lTextChanged = b ? l.text !== b.text : false
        const sTextChanged = b ? s.text !== b.text : false

        if (!lTextChanged && sTextChanged) {
            merged.text = s.text
        } else if (lTextChanged && sTextChanged && l.text !== s.text) {
            hasConflicts = true
            conflicts.push({ id, field: 'text', local: l.text, server: s.text, base: b ? b.text : '' })
            // Keep local as default; user may override via conflictCallback
        }

        // Merge description
        const bDesc = b ? (b.description || '') : (l.description || '')
        const lDesc = l.description || ''
        const sDesc = s.description || ''
        const lDescChanged = b ? lDesc !== bDesc : false
        const sDescChanged = b ? sDesc !== bDesc : false

        if (!lDescChanged && sDescChanged) {
            merged.description = sDesc
        } else if (lDescChanged && sDescChanged && lDesc !== sDesc) {
            hasConflicts = true
            conflicts.push({ id, field: 'description', local: lDesc, server: sDesc, base: bDesc })
        }

        // Merge parentId (structural move)
        if (b && l.parentId !== b.parentId && s.parentId === b.parentId) {
            // Only local moved this node
            merged.parentId = l.parentId
        } else if (b && l.parentId === b.parentId && s.parentId !== b.parentId) {
            // Only server moved this node
            merged.parentId = s.parentId
        }
        // If both moved, keep local

        // Merge children (handle additions from either side)
        const bChildSet = new Set(b ? b.children : [])
        const lChildren = l.children || []
        const sChildren = s.children || []
        const lChildSet = new Set(lChildren)

        let mergedChildren = [...lChildren]

        // Add children that server added (not in base)
        const serverAdded = sChildren.filter(cid => !bChildSet.has(cid))
        for (const cid of serverAdded) {
            if (!lChildSet.has(cid)) {
                mergedChildren.push(cid)
            }
        }

        // Remove children that server deleted (in base, not in server, but local still has them)
        if (b) {
            const serverDeletedSet = new Set(b.children.filter(cid => !sChildren.includes(cid)))
            mergedChildren = mergedChildren.filter(cid => !serverDeletedSet.has(cid) || lChildren.includes(cid))
            // Re-add if local explicitly added it back (it's in local but not base)
            // Actually: if server deleted and local still has it (was in base AND local), server wins
            // Simplified: remove from merged if server deleted and it was in base
            mergedChildren = mergedChildren.filter(cid => !serverDeletedSet.has(cid))
        }

        merged.children = mergedChildren
        mergedFlatMap[id] = merged
    }

    // Clean up: remove references to nodes that don't exist in mergedFlatMap
    for (const id of Object.keys(mergedFlatMap)) {
        mergedFlatMap[id].children = (mergedFlatMap[id].children || []).filter(cid => mergedFlatMap[cid])
    }

    // Ensure parent references are valid
    for (const id of Object.keys(mergedFlatMap)) {
        if (id === 'root') continue
        const node = mergedFlatMap[id]
        if (node.parentId && !mergedFlatMap[node.parentId]) {
            node.parentId = 'root'
            if (mergedFlatMap['root'] && !mergedFlatMap['root'].children.includes(id)) {
                mergedFlatMap['root'].children.push(id)
            }
        }
    }

    return { mergedFlatMap, hasConflicts, conflicts }
}

// Apply per-node user choices to resolved conflicting fields
function applyChoices(mergedFlatMap, conflicts, choices) {
    // Build server values keyed by nodeId+field
    const serverByNodeField = {}
    for (const conflict of conflicts) {
        if (!serverByNodeField[conflict.id]) serverByNodeField[conflict.id] = {}
        serverByNodeField[conflict.id][conflict.field] = conflict.server
    }
    for (const [nodeId, choice] of Object.entries(choices)) {
        if (!mergedFlatMap[nodeId]) continue
        if (choice === 'server' && serverByNodeField[nodeId]) {
            for (const [field, serverVal] of Object.entries(serverByNodeField[nodeId])) {
                mergedFlatMap[nodeId][field] = serverVal
            }
        }
        // choice === 'local' → keep local (already in mergedFlatMap)
    }
}

let _debounceTimer = null
let _debounceArgs = null

const syncModule = {
    _lastServerUpdatedAt: null,
    conflictCallback: null,
    client: null,
    _userId: null,

    init() {
        const config = readConfig()
        const DEFAULT = { url: 'https://gcpdascpdrakecpknrtt.supabase.co', key: 'sb_publishable_9Uxo-0GD-21K6mUPQ2FSuw_mDO06TJc' }
        if (window.supabase?.createClient) {
            const cfg = config || DEFAULT
            this.client = window.supabase.createClient(cfg.url, cfg.key)
        }
    },

    async refreshSession() {
        if (!this.client) return
        try {
            const result = await this.client.auth.getUser()
            this._userId = result?.data?.user?.id || null
        } catch { /* no-op */ }
    },

    async fetchServerTimestamp() {
        if (!this.client) return null
        try {
            const result = await this.client.from('outlines')
                .select('updated_at')
                .eq('user_id', this._userId)
                .single()
            if (result?.error?.code === 'PGRST116') return null
            return result?.data?.updated_at || null
        } catch { return null }
    },

    async download() {
        if (!this.client) return null
        try {
            const result = await this.client.from('outlines')
                .select('salt, data, updated_at')
                .eq('user_id', this._userId)
                .single()
            if (result?.error?.code === 'PGRST116') return null
            return result?.data || null
        } catch { return null }
    },

    async _upload(doc, key, salt) {
        if (!this.client || !salt) return
        const encrypted = await encrypt(JSON.stringify(doc), key, salt)
        const payload = {
            salt,
            data: encrypted,
            updated_at: doc.updated_at || new Date().toISOString(),
            user_id: this._userId
        }
        await this.client.from('outlines').upsert(payload)
    },

    triggerBackgroundUpload(doc, key) {
        _debounceArgs = { doc, key }
        if (_debounceTimer) clearTimeout(_debounceTimer)
        _debounceTimer = setTimeout(async () => {
            _debounceTimer = null
            if (!_debounceArgs) return
            const { doc: d, key: k } = _debounceArgs
            _debounceArgs = null
            try {
                const base = getLocalBase()
                const localSalt = localStorage.getItem('vmd_data_enc')?.split('|')[0]
                const salt = base?.salt || localSalt
                if (salt) {
                    await syncModule._upload(d, k, salt)
                }
            } catch (e) {
                log('[Sync] Background upload failed:', e)
            }
        }, 800)
    },

    async checkAndSync(localDoc, key) {
        const serverTs = await this.fetchServerTimestamp()
        this._lastServerUpdatedAt = serverTs

        const localTs = localDoc?.updated_at
        if (localTs === serverTs) {
            return { success: true, action: 'none', data: localDoc }
        }
        if (!serverTs) {
            return { success: true, action: 'none', data: localDoc }
        }

        // Download full server record (use this.download so tests can monkeypatch it)
        const serverRaw = await this.download()
        if (!serverRaw?.data) {
            return { success: true, action: 'none', data: localDoc }
        }

        // Decrypt server document
        let serverDoc
        try {
            const serverStr = await decrypt(serverRaw.data, key, serverRaw.salt)
            serverDoc = JSON.parse(serverStr)
        } catch {
            return { success: false, action: 'none', data: localDoc }
        }

        // Get base document for 3-way merge
        let baseDoc = null
        const base = getLocalBase()
        if (base?.data) {
            try {
                const baseStr = await decrypt(base.data, key, base.salt)
                baseDoc = JSON.parse(baseStr)
            } catch { /* use null base */ }
        }

        // 3-way merge
        const { mergedFlatMap, hasConflicts, conflicts } = threeWayMerge(baseDoc, localDoc, serverDoc)

        let finalAction = hasConflicts ? 'merged_user' : 'merged_auto'

        if (hasConflicts && this.conflictCallback) {
            const resolution = await this.conflictCallback({ type: 'field-merge', conflicts })
            if (resolution?.choice === 'merge' && resolution.choices) {
                applyChoices(mergedFlatMap, conflicts, resolution.choices)
                finalAction = 'merged_user'
            } else if (resolution === 'server') {
                // Whole-doc server wins — apply all server values for conflicts
                const serverChoices = {}
                for (const c of conflicts) serverChoices[c.id] = 'server'
                applyChoices(mergedFlatMap, conflicts, serverChoices)
                finalAction = 'merged_user'
            }
        }

        const mergedTree = buildTree(mergedFlatMap, 'root')

        // Persist merged result and upload
        try {
            const salt = serverRaw.salt
            const encrypted = await encrypt(JSON.stringify(mergedTree), key, salt)
            saveLocalBase(encrypted, salt)
            localStorage.setItem('vmd_data_enc', salt + '|' + encrypted)
            await this.client.from('outlines').upsert({
                salt,
                data: encrypted,
                updated_at: mergedTree.updated_at || new Date().toISOString(),
                user_id: this._userId
            })
        } catch (e) {
            log('[Sync] Failed to persist merged result:', e)
        }

        return { success: true, action: finalAction, data: mergedTree }
    }
}

export default syncModule

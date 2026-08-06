// Generic VMD.md Layer C metadata parser.
// Implements the metadata recognition algorithm from docs/VMD.md §8:
//   1. Split item content into whitespace-delimited tokens.
//   2. Scan tokens right-to-left.
//   3. A token matches if it contains a colon, splits into `property:value`
//      at the first colon, `property` exists in the registry, and `value`
//      passes the optional regex.
//   4. First match wins (last-on-line wins). Stop scanning immediately upon
//      encountering any non-matching token, unregistered property, tag, or mention.
//   5. All tokens to the left of the stop point become content.
//
// The registry is intentionally small: `due` is the only registered key.

const META_REGISTRY = {
    due: /^\d{4}-\d{2}-\d{2}$/
}

const TOKEN_RE = /\S+/g

/**
 * Parse metadata from the end of a text string.
 * @param {string} text
 * @returns {{ meta: Record<string, string>, text: string }}
 */
export function parseMeta(text) {
    const meta = {}
    const tokens = String(text || '').match(TOKEN_RE) || []
    if (tokens.length === 0) return { meta, text: String(text || '') }

    let stopIndex = tokens.length // index of first token to keep in text

    for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i]
        const colonIdx = token.indexOf(':')
        if (colonIdx === -1) {
            // Non-matching token (no colon) → stop scanning.
            // Keep everything including this token (i + 1).
            stopIndex = i + 1
            break
        }
        const property = token.slice(0, colonIdx)
        const value = token.slice(colonIdx + 1)
        const regex = META_REGISTRY[property]
        if (!regex || !regex.test(value) || (property === 'due' && !isValidDueDate(value))) {
            // Unregistered property or invalid value → stop scanning.
            // Keep everything including this token (i + 1).
            stopIndex = i + 1
            break
        }
        // First match wins (last-on-line wins): only set if not already present.
        if (!(property in meta)) {
            meta[property] = value
        }
        stopIndex = i
    }

    const residual = tokens.slice(0, stopIndex).join(' ')
    return { meta, text: residual }
}

/**
 * Append metadata back to text (round-trip).
 * @param {string} text
 * @param {Record<string, string>} meta
 * @returns {string}
 */
export function formatMeta(text, meta) {
    const parts = [String(text || '')]
    for (const [key, value] of Object.entries(meta)) {
        parts.push(`${key}:${value}`)
    }
    return parts.filter(Boolean).join(' ')
}

export function isValidDueDate(dueStr) {
    return parseDate(dueStr) !== null
}

/**
 * Check if a yyyy-MM-dd due date is strictly before today (local timezone).
 * @param {string} dueStr
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isOverdue(dueStr, now = new Date()) {
    const due = parseDate(dueStr)
    if (!due) return false
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return due < today
}

/**
 * Format a yyyy-MM-dd date for display.
 * Omits the year when it matches the current year.
 * @param {string} dueStr
 * @param {Date} [now]
 * @returns {string}
 */
export function formatDueDate(dueStr, now = new Date()) {
    const due = parseDate(dueStr)
    if (!due) return dueStr
    const month = due.toLocaleString('en-US', { month: 'short' })
    const day = due.getDate()
    if (due.getFullYear() === now.getFullYear()) {
        return `${month} ${day}`
    }
    return `${month} ${day}, ${due.getFullYear()}`
}

/**
 * Parse a yyyy-MM-dd string as a local date (not UTC).
 * @param {string} str
 * @returns {Date|null}
 */
function parseDate(str) {
    if (!META_REGISTRY.due.test(str)) return null
    const [y, m, d] = str.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    // Validate the date is real (e.g. 2026-02-30 rolls over to March)
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
        return null
    }
    return date
}
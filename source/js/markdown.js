import { Marked } from 'marked'
import DOMPurify from 'dompurify'

const SAFE_HTTP_URL_RE = /^https?:\/\//i

function isSafeHttpUrl(value) {
    if (!value) return false
    return SAFE_HTTP_URL_RE.test(String(value).trim())
}

function escapeAttribute(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function normalizeMarkdownAliases(text) {
    // SPEC accepts __Italic__ as emphasis.
    return String(text || '').replace(/__(.+?)__/g, '_$1_')
}

const markdown = new Marked({
    async: false,
    gfm: true,
    breaks: false
})

markdown.use({
    renderer: {
        link(token) {
            const href = isSafeHttpUrl(token.href) ? token.href : '#'
            const body = this.parser.parseInline(token.tokens)
            const title = token.title ? ` title="${escapeAttribute(token.title)}"` : ''
            return `<a href="${escapeAttribute(href)}"${title} target="_blank" rel="noopener noreferrer">${body}</a>`
        },
        image(token) {
            if (!isSafeHttpUrl(token.href)) {
                return escapeAttribute(token.text || '')
            }
            const alt = escapeAttribute(token.text || '')
            const src = escapeAttribute(token.href)
            const title = token.title ? ` title="${escapeAttribute(token.title)}"` : ''
            return `<img src="${src}" alt="${alt}"${title}>`
        }
    }
})

const SANITIZE_OPTIONS = {
    USE_PROFILES: { html: true },
    ALLOWED_TAGS: ['strong', 'em', 'a', 'img', 'code', 'br'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'rel']
}

export function renderInlineMarkdown(text) {
    if (!text) return ''
    const rawHtml = markdown.parseInline(normalizeMarkdownAliases(text))
    return DOMPurify.sanitize(rawHtml, SANITIZE_OPTIONS)
}

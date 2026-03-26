import { h, render } from "https://esm.sh/preact";
import htm from "https://esm.sh/htm";
import { useState, useEffect } from "https://esm.sh/preact/hooks";
import { unlock } from "./ideias.js"
import * as cryptoFn from "./crypto2.js"
import outline from "./outline.js"
const html = htm.bind(h);


// ------------------ LOCK SCREEN ------------------

function LockScreen({ onUnlock }) {
    let inputRef

    return html`
        <div class="lock-screen">
            <h3>Unlock Document</h3>
            <input type="password" ref=${el => inputRef = el} />
            <button onClick=${() => onUnlock(inputRef.value)}>
                Unlock
            </button>
        </div>
    `
}

// ------------------ TREE UI ------------------

function NodeView({ id }) {
    useEffect(() => outline.dataVersion, [outline.dataVersion.value]) // subscribe to node changes
    const node = outline.get(id)
    if (!node) return null

    return html`
        <div class="node">
            <div class="node-header">
                <button onClick=${() => outline.addNewNode(id)}>+</button>
                ${id !== undefined && html`
                    <button onClick=${() => outline.deleteNode(id)}>x</button>
                    <button onClick=${() => outline.moveUp(id)}>↑</button>
                    <button onClick=${() => outline.moveDown(id)}>↓</button>
                    <button onClick=${() => outline.indent(id)}>→</button>
                    <button onClick=${() => outline.outdent(id)}>←</button>
                `}
                <strong>${id}</strong>
            </div>

            <textarea
                value=${node.text.value}
                onInput=${e => outline.update(id, { text: e.target.value })}
            ></textarea>

            ${node.children.map(childId => html`
                <${NodeView} id=${childId} key=${childId}/>
            `)}
        </div>
    `
}
function App() {
    const [unlocked, setUnlocked] = useState(false)
    const [error, setError] = useState(null)
    async function tryUnlock(passphrase) {
        try {
            setError(null)
            const result = await unlock(passphrase)
            setUnlocked(result)
        } catch (e) {
            setError("Unlock failed: " + e.message)
            setTimeout(() => setError(null), 3000)
        }
    }

    if (unlocked) {
        return html`<div>
                <button id="resetBtn" onClick=${() => {
                if (!confirm("Reset document and clear storage?")) return
                localStorage.removeItem("vmd_data_enc")
                location.reload()
            }}>RESET</button>
                <button id="testBtn" class="debug-only" onClick=${() => runTests()}>TEST</button>

                <hr />
                <button onClick=${() => outline.addNewNode()}>+</button>

                <${NodeView} />
                <div id="testOutput" class="debug-only"></div>
            </div>`
    }

    return html`
            <button id="resetBtn" onClick=${() => {
            if (!confirm("Reset document and clear storage?")) return
            localStorage.removeItem("vmd_data_enc")
            location.reload()
        }}>RESET</button>
            <${LockScreen} onUnlock=${tryUnlock}/>
            ${error && html`<div class="unlock-error">${error}</div>`}
            `
}

render(html`<${App}/>`, document.getElementById("app"))

// ------------------ TESTS ------------------

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

// Estrutura invariantes
function validateTree() {
    const visited = new Set()

    function visit(id) {
        if (visited.has(id)) {
            throw new Error("Cycle detected")
        }
        visited.add(id)

        const node = outline.get(id)
        assert(node, "Missing node: " + id)

        node.peek().children.forEach(childId => {
            assert(outline.get(childId), "Child does not exist: " + childId)
            visit(childId)
        })
    }

    outline.getRoot().value.children.forEach(visit)
}

// ------------------ TEST UI ------------------

async function runTests() {
    const out = document.getElementById("testOutput")
    const startTime = performance.now()

    out.innerHTML = ""
    out.style.background = "#111"
    out.style.color = "#eee"
    out.style.padding = "15px"
    out.style.borderRadius = "8px"
    out.style.fontFamily = "monospace"

    let passed = 0
    let failed = 0

    async function test(name, fn) {
        outline.reset()
        try {
            await fn()
            validateTree()
            out.innerHTML += `<div style="color:#4caf50">✔ ${name}</div>`
            passed++
        } catch (e) {
            out.innerHTML += `<div style="color:#f44336">✘ ${name} — ${e.message}</div>`
            failed++
        }
    }

    // ------------------ TREE TESTS ------------------

    await test("Create single node", () => {
        const n = outline.addNewNode()
        assert(n !== null, "Node not created")
    })

    await test("Multiple children order preserved", () => {
        const a = outline.addNewNode()
        const b = outline.addNewNode()
        const root = outline.getRoot()
        assert(root.children[0] === a.id, "Order broken")
        assert(root.children[1] === b.id, "Order broken")
    })

    await test("Indent moves node under previous sibling", () => {
        const a = outline.addNewNode()
        const b = outline.addNewNode()
        outline.indent(b.id)
        const parent = outline.get(b.parentId)
        assert(parent.id === a.id, "Indent failed")
    })

    await test("Outdent restores to grandparent", () => {
        const a = outline.addNewNode()
        const b = outline.addNewNode()
        outline.indent(b.id)
        outline.outdent(b.id)
        const parent = outline.get(b.parentId)
        assert(parent.id === undefined, "Outdent failed")
    })

    await test("MoveUp swaps siblings", () => {
        const a = outline.addNewNode()
        const b = outline.addNewNode()
        outline.moveUp(b.id)
        const root = outline.getRoot()
        assert(root.value.children[0] === b.id, "MoveUp failed")
    })

    await test("MoveDown swaps siblings", () => {
        const a = outline.addNewNode()
        const b = outline.addNewNode()
        outline.moveDown(a.id)
        const root = outline.getRoot()
        assert(root.value.children[1] === a.id, "MoveDown failed")
    })

    await test("Recursive delete removes subtree", () => {
        const a = outline.addNewNode()
        const b = outline.addNewNode(a.id)
        outline.deleteNode(a.id)
        assert(!outline.get(a.id), "Parent not deleted")
        assert(!outline.get(b.id), "Child not deleted")
    })

    await test("Deep tree structure integrity", () => {
        let parent = undefined
        for (let i = 0; i < 20; i++) {
            const n = outline.addNewNode(parent)
            parent = n.id
        }
    })

    await test("Serialization roundtrip", () => {
        const a = outline.addNewNode()
        outline.setNodeTxt(a.id, "Hello")
        const json = outline.serialize()
        outline.reset(json)
        outline.deserialize(json)
        const node = outline.get(a.id)
        assert(node.txt.value === "Hello", "Deserialize failed")
    })

    // ------------------ CRYPTO TESTS ------------------

    await test("Crypto small payload", async () => {
        const json = outline.serialize()
        const salt = cryptoFn.randomId()
        const enc = await cryptoFn.encrypt(json, "pass", salt)
        const dec = await cryptoFn.decrypt(enc, "pass", salt)
        assert(dec === json, "Mismatch")
    })

    await test("Crypto large payload", async () => {
        const large = "x".repeat(200000)
        const salt = cryptoFn.randomId()
        const enc = await cryptoFn.encrypt(large, "pass", salt)
        const dec = await cryptoFn.decrypt(enc, "pass", salt)
        assert(dec === large, "Large payload mismatch")
    })

    await test("Crypto wrong password fails", async () => {
        const json = outline.serialize()
        const salt = cryptoFn.randomId()
        const enc = await cryptoFn.encrypt(json, "pass", salt)
        let failedDecrypt = false
        try {
            await cryptoFn.decrypt(enc, "wrong", salt)
        } catch {
            failedDecrypt = true
        }
        assert(failedDecrypt, "Wrong password did not fail")
    })

    // ------------------ SUMMARY ------------------

    const duration = (performance.now() - startTime).toFixed(1)

    out.innerHTML += `
        <hr style="margin:10px 0;border-color:#333">
        <div><strong>Total:</strong> ${passed + failed}</div>
        <div style="color:#4caf50">Passed: ${passed}</div>
        <div style="color:#f44336">Failed: ${failed}</div>
        <div>Time: ${duration} ms</div>
    `
}

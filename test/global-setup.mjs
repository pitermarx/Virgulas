import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const stateFile = path.resolve(root, 'source', 'js', 'state.js');
const backupFile = stateFile + '.bak';

function getLocalSupabase() {
    try {
        const binDir = path.resolve(root, 'node_modules', '.bin');
        const pathEnv = binDir + path.delimiter + process.env.PATH;
        const out = execSync('supabase status --output json', {
            cwd: root,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 15000,
            env: { ...process.env, PATH: pathEnv },
        });
        const status = JSON.parse(out.toString());
        const url = status.API_URL || status.api_url;
        const key = status.ANON_KEY || status.anon_key;
        if (url && key) return { url, key };
    } catch { /* local Supabase not running — fall through */ }
    return null;
}

function injectLocal(content, url, key) {
    let updated = content;
    updated = updated.replace(
        /https:\/\/__SUPABASE_PROJECT__\.supabase\.co/g,
        url,
    );
    updated = updated.replace(/__SUPABASE_PUBLISHABLE_DEFAULT_KEY__/g, key);
    return updated;
}

export default function globalSetup() {
    if (process.env.BASE_URL) return;       // remote target — nothing to inject

    const content = fs.readFileSync(stateFile, 'utf8');
    let updated = content;

    if (process.env.SUPABASE_PROJECT) {
        // Remote credentials (CI env vars)
        updated = updated.replace(/__SUPABASE_PROJECT__/g, process.env.SUPABASE_PROJECT);
        if (process.env.SUPABASE_PUBLISHABLE_DEFAULT_KEY) {
            updated = updated.replace(/__SUPABASE_PUBLISHABLE_DEFAULT_KEY__/g, process.env.SUPABASE_PUBLISHABLE_DEFAULT_KEY);
        }
    } else {
        // Auto-detect running local Supabase
        const local = getLocalSupabase();
        if (local) {
            updated = injectLocal(content, local.url, local.key);
            console.log(`[global-setup] Using local Supabase at ${local.url}`);
        } else {
            return; // nothing to inject
        }
    }

    if (updated !== content) {
        fs.writeFileSync(backupFile, content);  // back up original
        fs.writeFileSync(stateFile, updated);
    }
}

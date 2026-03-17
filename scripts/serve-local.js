#!/usr/bin/env node
// Starts local Supabase, patches source/index.html with credentials from status,
// serves the app on port 3000, then restores the original file and removes the local DB.
const { execSync, spawn } = require('child_process');
const { readFileSync, writeFileSync, existsSync, unlinkSync } = require('fs');
const { resolve } = require('path');

const root = resolve(__dirname, '..');
const indexPath = resolve(root, 'source', 'index.html');
const backupPath = resolve(root, 'source', 'index.html.bak');
const isWindows = process.platform === 'win32';
const ext = isWindows ? '.cmd' : '';
const supabaseBin = resolve(root, 'node_modules', '.bin', `supabase${ext}`);
const serveBin = resolve(root, 'node_modules', '.bin', `serve${ext}`);
let child = null;
let shuttingDown = false;

// Restore from a previous unclean exit if backup exists
if (existsSync(backupPath)) {
    writeFileSync(indexPath, readFileSync(backupPath, 'utf8'));
    unlinkSync(backupPath);
}

const restoreIndex = () => {
    if (!existsSync(backupPath)) return;

    writeFileSync(indexPath, readFileSync(backupPath, 'utf8'));
    unlinkSync(backupPath);
    console.log('Restored index.html');
};

const stopServe = () => {
    if (!child || child.exitCode !== null) return;

    try {
        if (isWindows) {
            execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
        } else {
            child.kill('SIGTERM');
        }
    } catch { }
};

const stopSupabase = () => {
    try {
        console.log('Cleaning up local Supabase...');
        execSync(`"${supabaseBin}" stop --no-backup --yes`, { cwd: root, stdio: 'inherit' });
    } catch { }
};

const shutdown = (exitCode, shouldStopServe) => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (shouldStopServe) stopServe();
    restoreIndex();
    stopSupabase();
    process.exit(exitCode);
};

// Ensure the full local Supabase stack is up before serving the app.
console.log('Starting local Supabase services...');
execSync(`"${supabaseBin}" start --ignore-health-check`, { cwd: root, stdio: 'inherit' });
const statusOutput = execSync(`"${supabaseBin}" status`, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

// Parse Project URL and Publishable key from the status table
const urlMatch = statusOutput.match(/Project URL\s*.\s*(https?:\/\/\S+)/);
const keyMatch = statusOutput.match(/Publishable\s*.\s*(\S+)/);

if (!urlMatch || !keyMatch) {
    console.error('ERROR: Could not parse Supabase URL or key from status output.');
    process.exit(1);
}

const url = urlMatch[1];
const key = keyMatch[1];

// Backup and patch index.html
const original = readFileSync(indexPath, 'utf8');
writeFileSync(backupPath, original);
writeFileSync(indexPath,
    original
        .replace(/%%SUPABASE_URL%%/g, url)
        .replace(/%%SUPABASE_ANON_KEY%%/g, key)
);

console.log(`Supabase URL : ${url}`);
console.log('Serving at   : http://localhost:3000');

process.on('SIGINT', () => shutdown(0, true));
process.on('SIGTERM', () => shutdown(0, true));
process.on('uncaughtException', (error) => {
    console.error(error);
    shutdown(1, true);
});
process.on('unhandledRejection', (error) => {
    console.error(error);
    shutdown(1, true);
});

child = spawn(serveBin, ['-p', '3000', 'source'], {
    stdio: 'inherit',
    shell: isWindows,
    cwd: root,
});

child.on('error', (error) => {
    console.error(error);
    shutdown(1, false);
});

child.on('exit', (code) => shutdown(code ?? 0, false));

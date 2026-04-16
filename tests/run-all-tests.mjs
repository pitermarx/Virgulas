#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const forwardedArgs = process.argv.slice(2);
const nodeCommand = process.execPath;
const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
    console.error('Unable to locate npm CLI path from npm_execpath.');
    process.exit(1);
}

function runScript(scriptName) {
    const args = ['run', scriptName];
    if (forwardedArgs.length > 0) {
        args.push('--', ...forwardedArgs);
    }

    const result = spawnSync(nodeCommand, [npmCliPath, ...args], {
        stdio: 'inherit',
        shell: false
    });

    if (result.error) {
        console.error(`Failed to run ${scriptName}:`, result.error.message);
        return 1;
    }

    return result.status ?? 1;
}

const unitExitCode = runScript('test:unit');
const e2eExitCode = runScript('test:e2e');

if (e2eExitCode !== 0 || unitExitCode !== 0) {
    process.exit(1);
}

process.exit(0);

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.resolve(__dirname, '..', 'source', 'js', 'state.js');
const backupFile = stateFile + '.bak';

export default function globalTeardown() {
    if (fs.existsSync(backupFile)) {
        fs.copyFileSync(backupFile, stateFile);
        fs.unlinkSync(backupFile);
    }
}

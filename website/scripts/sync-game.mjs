import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');
const output = path.resolve(scriptDir, '..', 'public');
const files = [['index.html', 'game.html'], ['social.js', 'social.js']];
const available = files.map(([name]) => existsSync(path.join(root, name)));
if (available.every(Boolean)) {
  for (const file of files) {
    const source = path.join(root, file[0]);
    mkdirSync(output, { recursive: true });
    copyFileSync(source, path.join(output, file[1]));
  }
  console.log('Synced root game sources into website/public');
} else if (available.every(value => !value) && files.every(([, name]) => existsSync(path.join(output, name)))) {
  console.log('Using bundled game sources in standalone website checkout');
} else {
  throw new Error('Missing or incomplete game sources; expected both root files or both bundled public files');
}

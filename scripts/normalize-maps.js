/**
 * Normalize absolute file:// source paths in dist/*.map so local Windows
 * builds and Linux CI produce identical dist/ artifacts.
 */
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const STABLE_PREFIX = 'file:///Users/user/trustbridge-action/src/';

for (const name of fs.readdirSync(distDir)) {
  if (!name.endsWith('.map')) continue;
  const filePath = path.join(distDir, name);
  const original = fs.readFileSync(filePath, 'utf8');
  const normalized = original.replace(
    /file:\/\/\/(?:[A-Za-z]:\/)?[^"]+?\/src\//g,
    STABLE_PREFIX,
  );
  if (normalized !== original) {
    fs.writeFileSync(filePath, normalized, 'utf8');
    console.log(`normalized source paths in dist/${name}`);
  }
}

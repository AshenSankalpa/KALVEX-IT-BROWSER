'use strict';

// Post-build tidy-up for electron-builder's output folder.
//
// Keeps exactly the three files a release needs and deletes everything else
// in dist/ (win-unpacked/, builder-debug.yml, builder-effective-config.yaml,
// installers from older versions, stray copies like latest.exe):
//
//     Virel-POS-Setup-<version>.exe
//     Virel-POS-Setup-<version>.exe.blockmap
//     latest.yml
//
// The installer's name comes from latest.yml itself (its `path:` field), not
// from a pattern, so the keep-list can never drift from what electron-updater
// will actually request.
//
// Because this deletes things, it checks first and refuses to touch anything
// if the release set isn't whole and consistent:
//   - the folder must be named exactly "dist"
//   - latest.yml, the installer and its blockmap must all exist
//   - the installer's size and sha512 must match latest.yml
// A failure exits non-zero (the build output is not publishable) and leaves
// dist/ exactly as it was. A file that can't be deleted (e.g. an installer
// that is currently open) is only a warning — the release set is still good.
//
// Usage: node scripts/clean-dist.js [path-to-dist]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseLatestYml(text) {
  const installer = (text.match(/^path:\s*(.+?)\s*$/m) || [])[1];
  const sha512 = (text.match(/^sha512:\s*(\S+)\s*$/m) || [])[1]; // top-level only (no indentation)
  const size = (text.match(/^\s+size:\s*(\d+)\s*$/m) || [])[1];
  return {
    installer: installer ? installer.replace(/^['"]|['"]$/g, '') : undefined,
    sha512,
    size: size === undefined ? undefined : Number(size)
  };
}

function sha512Base64(file) {
  const hash = crypto.createHash('sha512');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('base64');
}

function cleanDist(distDir) {
  const dist = path.resolve(distDir);
  if (path.basename(dist) !== 'dist') {
    throw new Error(`refusing to clean "${dist}": the folder must be named "dist"`);
  }
  if (!fs.existsSync(dist) || !fs.statSync(dist).isDirectory()) {
    throw new Error(`"${dist}" does not exist`);
  }

  const ymlPath = path.join(dist, 'latest.yml');
  if (!fs.existsSync(ymlPath)) {
    throw new Error('latest.yml is missing — electron-builder did not produce the update manifest; dist left untouched');
  }
  const { installer, sha512, size } = parseLatestYml(fs.readFileSync(ymlPath, 'utf8'));
  if (!installer || !sha512 || size === undefined) {
    throw new Error('latest.yml is missing its path/sha512/size fields; dist left untouched');
  }
  if (installer !== path.basename(installer) || installer.includes('..')) {
    throw new Error(`latest.yml names an unsafe installer path ("${installer}"); dist left untouched`);
  }

  const installerPath = path.join(dist, installer);
  const blockmap = `${installer}.blockmap`;
  for (const needed of [installer, blockmap]) {
    if (!fs.existsSync(path.join(dist, needed))) {
      throw new Error(`${needed} is listed for release but missing from dist; dist left untouched`);
    }
  }

  const actualSize = fs.statSync(installerPath).size;
  if (actualSize !== size) {
    throw new Error(`${installer} is ${actualSize} bytes but latest.yml says ${size}; dist left untouched`);
  }
  if (sha512Base64(installerPath) !== sha512) {
    throw new Error(`${installer} does not match the sha512 in latest.yml; dist left untouched`);
  }

  const keep = new Set([installer, blockmap, 'latest.yml'].map((n) => n.toLowerCase()));
  const kept = [installer, blockmap, 'latest.yml'];
  const removed = [];
  const warnings = [];

  for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
    if (keep.has(entry.name.toLowerCase())) continue;
    const target = path.join(dist, entry.name);
    if (entry.isSymbolicLink()) {
      warnings.push(`${entry.name}: left alone (symbolic link / junction — not followed)`);
      continue;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
    } catch (err) {
      warnings.push(`${entry.name}: could not be removed (${err.code || err.message}) — is it open in another program?`);
    }
  }

  return { dist, kept, removed, warnings };
}

module.exports = { cleanDist, parseLatestYml };

if (require.main === module) {
  const target = process.argv[2] || path.join(__dirname, '..', 'dist');
  try {
    const { dist, kept, removed, warnings } = cleanDist(target);
    console.log(`[clean-dist] ${dist}`);
    console.log(`[clean-dist] kept    : ${kept.join(', ')}`);
    console.log(`[clean-dist] removed : ${removed.length ? removed.join(', ') : '(nothing to remove)'}`);
    for (const w of warnings) console.warn(`[clean-dist] warning: ${w}`);
  } catch (err) {
    console.error(`[clean-dist] ERROR: ${err.message}`);
    process.exit(1);
  }
}

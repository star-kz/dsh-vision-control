// tools/concat-worker.mjs
// Build backend/worker.ps1 by byte-concatenating backend/parts/*.ps1 in sorted
// order, and write the hash manifest backend/parts-manifest.json.
//
// The worker is a single PowerShell file produced from the parts tree; the
// parts are the source of truth. Byte-exact concatenation (no separators, no
// newline normalization) is what keeps worker.ps1 reproducible and reviewable.
//
// Usage:
//   node tools/concat-worker.mjs           build worker.ps1 + manifest
//   node tools/concat-worker.mjs --check   verify only (exit 1 on drift), write nothing
//
// Exit codes: 0 = ok / in sync, 1 = drift or IO/parse failure.
// Line endings: this file is LF; the emitted worker.ps1 keeps whatever bytes
// the parts carry (parts are UTF-8 no BOM, CRLF).

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, '..', 'backend');
const partsDir = join(backend, 'parts');
const workerPath = join(backend, 'worker.ps1');
const manifestPath = join(backend, 'parts-manifest.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function collectParts() {
  const names = readdirSync(partsDir)
    .filter((f) => f.endsWith('.ps1'))
    .sort(); // 00-..13- numeric prefixes sort correctly as strings
  if (names.length === 0) {
    throw new Error(`no .ps1 parts found in ${partsDir}`);
  }
  return names.map((file) => {
    const bytes = readFileSync(join(partsDir, file));
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error(`${file} starts with a UTF-8 BOM; parts must be UTF-8 no BOM`);
    }
    return { file, bytes, sha256: sha256(bytes) };
  });
}

function build() {
  const parts = collectParts();
  const concat = Buffer.concat(parts.map((p) => p.bytes));
  return {
    parts,
    concat,
    workerSha256: sha256(concat),
  };
}

function makeManifest(b) {
  return {
    generatedAt: new Date().toISOString(),
    generator: 'tools/concat-worker.mjs',
    worker: {
      path: 'backend/worker.ps1',
      bytes: b.concat.length,
      sha256: b.workerSha256,
    },
    parts: b.parts.map((p) => ({ file: `backend/parts/${p.file}`, bytes: p.bytes.length, sha256: p.sha256 })),
  };
}

const checkOnly = process.argv.includes('--check');
const built = build();

if (checkOnly) {
  let current;
  try {
    current = readFileSync(workerPath);
  } catch (err) {
    console.error(`PARTS_DRIFT: cannot read ${workerPath}: ${err.message}`);
    process.exit(1);
  }
  const currentSha = sha256(current);
  if (current.equals(built.concat)) {
    console.log(`OK worker.ps1 in sync with parts (sha256 ${built.workerSha256})`);
    process.exit(0);
  }
  // Locate first drift and map it to a part for actionable reporting.
  const n = Math.min(current.length, built.concat.length);
  let i = 0;
  while (i < n && current[i] === built.concat[i]) i++;
  let acc = 0;
  let where = 'beyond end of parts';
  for (const p of built.parts) {
    if (i < acc + p.bytes.length) {
      where = `${p.file} @ part-local byte ${i - acc}`;
      break;
    }
    acc += p.bytes.length;
  }
  console.error(`PARTS_DRIFT: worker.ps1 (sha256 ${currentSha}) != concat(parts) (sha256 ${built.workerSha256})`);
  console.error(`first differing byte offset ${i}; maps to ${where}`);
  process.exit(1);
}

writeFileSync(workerPath, built.concat);
// Verify the write by re-reading (guards against partial writes / AV scanners).
const reread = readFileSync(workerPath);
if (!reread.equals(built.concat)) {
  console.error('write verification failed: worker.ps1 differs from intended bytes after write');
  process.exit(1);
}
writeFileSync(manifestPath, JSON.stringify(makeManifest(built), null, 2) + '\n', 'utf8');
console.log(`wrote backend/worker.ps1 (${built.concat.length} bytes, sha256 ${built.workerSha256})`);
console.log(`wrote backend/parts-manifest.json (${built.parts.length} parts)`);

#!/usr/bin/env node
/**
 * fetch-assets.mjs
 *
 * Vendors CC0 3D models and an HDRI from the pmndrs/market-assets GitHub
 * repo into public/assets/. This is a one-off maintenance script — it is
 * NOT part of the app build. Run manually:
 *
 *   node scripts/fetch-assets.mjs
 *
 * Only GitHub is reachable from this environment (kenney.nl, quaternius.com,
 * polyhaven.org, and codeload.github.com zip downloads are blocked), so we
 * do a partial clone of pmndrs/market-assets and checkout only the blobs we
 * need:
 *
 *   git clone --depth 1 --filter=blob:none --no-checkout <repo>
 *   git checkout HEAD -- <paths>
 *
 * Each model lives at files/models/<name>/model.gltf as a single-file glTF
 * with embedded base64 data-URI buffers (no external .bin/.png), so a plain
 * file copy is all that's needed. The HDRI lives at
 * files/hdris/kiara/kiara_1_dawn_1k.hdr.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const REPO_URL = 'https://github.com/pmndrs/market-assets.git';

const MODEL_NAMES = [
  // vehicles
  'sedan', 'suv', 'suv-luxury', 'hatchback', 'taxi', 'van',
  // nature
  'tree-big', 'tree-small', 'low-poly-tree',
  'formation-stone', 'formation-rock', 'formation-large-stone',
  // props
  'bench', 'table',
  // characters (skinned)
  'male', 'skater-male', 'skater-female', 'survivor-male', 'survivor-female',
];

const HDRI_REL_PATH = 'files/hdris/kiara/kiara_1_dawn_1k.hdr';
const HDRI_OUT_NAME = 'kiara_1_dawn_1k.hdr';

const MODELS_OUT_DIR = join(REPO_ROOT, 'public', 'assets', 'models');
const HDRI_OUT_DIR = join(REPO_ROOT, 'public', 'assets', 'hdri');
const LICENSES_PATH = join(REPO_ROOT, 'public', 'assets', 'LICENSES.md');

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function allAssetsAlreadyPresent() {
  const modelsOk = MODEL_NAMES.every((name) =>
    existsSync(join(MODELS_OUT_DIR, `${name}.gltf`))
  );
  const hdriOk = existsSync(join(HDRI_OUT_DIR, HDRI_OUT_NAME));
  const licensesOk = existsSync(LICENSES_PATH);
  return modelsOk && hdriOk && licensesOk;
}

function writeLicenses() {
  const content = `# Vendored Asset Licenses

## 3D Models (\`public/assets/models/*.gltf\`)

- **License:** CC0 (public domain)
- **Creator:** Kenney (kenney.nl)
- **Source:** Fetched from the [pmndrs/market-assets](https://github.com/pmndrs/market-assets)
  GitHub repository (\`files/models/<name>/model.gltf\`), which mirrors
  Kenney's CC0 asset packs as single-file glTF models with embedded
  base64 data-URI buffers.

Included models: ${MODEL_NAMES.map((n) => `\`${n}\``).join(', ')}.

## HDRI (\`public/assets/hdri/${HDRI_OUT_NAME}\`)

- **License:** CC0 (public domain)
- **Creator:** Poly Haven (polyhaven.com)
- **Source:** Fetched from the [pmndrs/market-assets](https://github.com/pmndrs/market-assets)
  GitHub repository (\`${HDRI_REL_PATH}\`), which mirrors Poly Haven's CC0
  HDRI library.

## Fetch script

These files are vendored (not fetched at build time) via
\`scripts/fetch-assets.mjs\`. Re-run that script to refresh or add assets.
`;
  writeFileSync(LICENSES_PATH, content);
}

function main() {
  if (allAssetsAlreadyPresent()) {
    console.log('All vendored assets already present in public/assets/ — nothing to do.');
    console.log('(Delete public/assets/models, public/assets/hdri, or public/assets/LICENSES.md and re-run to refresh.)');
    return;
  }

  mkdirSync(MODELS_OUT_DIR, { recursive: true });
  mkdirSync(HDRI_OUT_DIR, { recursive: true });

  const tmpDir = mkdtempSync(join(tmpdir(), 'market-assets-'));
  console.log(`Cloning ${REPO_URL} (blobless, no checkout) into ${tmpDir} ...`);

  try {
    run('git', ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', REPO_URL, tmpDir]);

    const checkoutPaths = [
      ...MODEL_NAMES.map((name) => `files/models/${name}`),
      'files/hdris/kiara',
    ];

    console.log(`Checking out ${checkoutPaths.length} paths...`);
    run('git', ['checkout', 'HEAD', '--', ...checkoutPaths], tmpDir);

    for (const name of MODEL_NAMES) {
      const src = join(tmpDir, 'files', 'models', name, 'model.gltf');
      const dest = join(MODELS_OUT_DIR, `${name}.gltf`);
      if (!existsSync(src)) {
        throw new Error(`Expected model file not found after checkout: ${src}`);
      }
      copyFileSync(src, dest);
      console.log(`  copied ${name}.gltf`);
    }

    const hdriSrc = join(tmpDir, HDRI_REL_PATH);
    const hdriDest = join(HDRI_OUT_DIR, HDRI_OUT_NAME);
    if (!existsSync(hdriSrc)) {
      throw new Error(`Expected HDRI file not found after checkout: ${hdriSrc}`);
    }
    copyFileSync(hdriSrc, hdriDest);
    console.log(`  copied ${HDRI_OUT_NAME}`);

    writeLicenses();
    console.log('  wrote LICENSES.md');

    console.log(`Done. Vendored ${MODEL_NAMES.length} models + 1 HDRI into public/assets/.`);
  } finally {
    console.log(`Cleaning up temp clone at ${tmpDir} ...`);
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();

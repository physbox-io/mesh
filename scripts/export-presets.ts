// Exports every built-in preset for the native desktop app (../mesh_desktop).
//
// Two artefacts per preset:
//   <key>.json  — the raw SceneGraph. This is the real payload: the native app
//                 owns a C++ port of compileToMJCF and compiles this itself, so
//                 the SceneGraph is the single shared source of truth exactly
//                 as it is in the browser.
//   <key>.xml   — MJCF produced by THIS (TypeScript) compiler, kept as the
//                 golden reference. The native build has a test that compiles
//                 each .json and diffs against the matching .xml, so the two
//                 emitters can't silently drift apart.
//
// Usage:  npm run export:presets [outDir]

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PRESETS } from '../src/presets/presetScenes';
import { compileToMJCF } from '../src/utils/mjcf';

const outDir = resolve(process.argv[2] ?? '../mesh_desktop/assets/presets');

if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

interface IndexEntry {
  key: string;
  name: string;
  scene: string;
  golden: string;
}

const index: IndexEntry[] = [];
const failures: { key: string; error: string }[] = [];

for (const [key, preset] of Object.entries(PRESETS as Record<string, any>)) {
  try {
    const xml = compileToMJCF(preset.scene);
    writeFileSync(join(outDir, `${key}.json`), JSON.stringify(preset.scene));
    writeFileSync(join(outDir, `${key}.xml`), xml);
    index.push({ key, name: preset.name ?? key, scene: `${key}.json`, golden: `${key}.xml` });
    console.log(`  ok    ${key.padEnd(24)} ${String(xml.length).padStart(9)} bytes mjcf`);
  } catch (err: any) {
    failures.push({ key, error: err?.message ?? String(err) });
    console.log(`  FAIL  ${key.padEnd(24)} ${err?.message ?? err}`);
  }
}

writeFileSync(join(outDir, 'index.json'), JSON.stringify({ presets: index }, null, 2));

// TSV alongside the JSON purely so the C++ loader needs no JSON dependency to
// enumerate presets (it does use one to parse the scenes themselves).
writeFileSync(
  join(outDir, 'index.tsv'),
  index.map(e => `${e.key}\t${e.name}\t${e.scene}\t${e.golden}`).join('\n') + '\n'
);

console.log(`\n${index.length} preset(s) written to ${outDir}`);
if (failures.length) {
  console.log(`${failures.length} failed:`);
  for (const f of failures) console.log(`  - ${f.key}: ${f.error}`);
}

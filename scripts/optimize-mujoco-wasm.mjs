// Re-inlines MuJoCo's WebAssembly build after install (`postinstall`).
//
// From 3.10 on, the @mujoco/mujoco wasm is built without cross-file inlining:
// mju_dot3, mju_copy, mju_zero, mju_min and the like are real calls from
// hundreds of sites, where 3.9 had them inlined. That cost 20-50% per step on
// small scenes (pendulum 2.5 -> 3.6 us, oval_track 19 -> 36 us). Binaryen's
// wasm-opt (the pinned `binaryen` devDependency) puts the inlining back.
// Physics is bit-identical - qpos and qvel after 2000 steps match on every
// preset - and 3.17 comes out ~7% faster overall, back level with 3.9.
//
// It takes about two minutes, so the result is cached by input hash under
// ~/.cache/mesh-mujoco-wasm: each machine pays once, and CI restores the
// directory. MESH_SKIP_WASM_OPT=1 leaves the stock wasm in place.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Raising the flexible limit and inlining loops as well came out no faster
// and 1.3 MB bigger; larger limits still ran for over 15 minutes.
const FLAGS = ['-all', '-O3', '--always-inline-max-function-size=20'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const log = (msg) => console.log(`[optimize-mujoco-wasm] ${msg}`);

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('@mujoco/mujoco/mujoco.wasm');
const stampPath = `${wasmPath}.optimized`;
const binaryenDir = dirname(require.resolve('binaryen/package.json'));
const binaryenVersion = JSON.parse(readFileSync(join(binaryenDir, 'package.json'), 'utf8')).version;
const cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'mesh-mujoco-wasm');

if (process.env.MESH_SKIP_WASM_OPT) {
  log('skipped (MESH_SKIP_WASM_OPT)');
} else {
  const input = readFileSync(wasmPath);
  const inputHash = sha256(input);
  if (existsSync(stampPath) && JSON.parse(readFileSync(stampPath, 'utf8')).output === inputHash) {
    log('already optimized');
  } else {
    mkdirSync(cacheDir, { recursive: true });
    const cached = join(cacheDir, `${sha256(`${inputHash} ${binaryenVersion} ${FLAGS.join(' ')}`)}.wasm`);
    if (!existsSync(cached)) {
      log('running wasm-opt (about two minutes, once per MuJoCo version)');
      const out = `${cached}.${process.pid}`;
      execFileSync(process.execPath, [join(binaryenDir, 'bin', 'wasm-opt'), wasmPath, ...FLAGS, '-o', out], { stdio: 'inherit' });
      renameSync(out, cached);
    }
    const output = readFileSync(cached);
    copyFileSync(cached, wasmPath);
    writeFileSync(stampPath, JSON.stringify({ input: inputHash, output: sha256(output), binaryen: binaryenVersion, flags: FLAGS }, null, 2));
    log(`optimized ${input.length} -> ${output.length} bytes`);
  }
}

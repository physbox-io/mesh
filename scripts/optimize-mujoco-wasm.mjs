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
// It takes minutes (about eight in Cloud Build for both wasms), so the result
// is cached by input hash under $XDG_CACHE_HOME/mesh-mujoco-wasm: each machine
// pays once, CI restores the directory with actions/cache, and the deploy
// trigger restores it from a Cloud Storage bucket (see the Dockerfile).
// MESH_SKIP_WASM_OPT=1 leaves the stock wasm in place.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Raising the flexible limit and inlining loops as well came out no faster
// and 1.3 MB bigger; larger limits still ran for over 15 minutes.
const FLAGS = ['-all', '-O3', '--always-inline-max-function-size=20'];
const MT_PATCH_VERSION = 'mt-futex-v1';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const log = (msg) => console.log(`[optimize-mujoco-wasm] ${msg}`);

const require = createRequire(import.meta.url);
const binaryenDir = dirname(require.resolve('binaryen/package.json'));
const binaryenVersion = JSON.parse(readFileSync(join(binaryenDir, 'package.json'), 'utf8')).version;
const cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'mesh-mujoco-wasm');

/**
 * Patches @mujoco/mujoco/mt's ThreadPoolContext to use WebAssembly's native
 * memory.atomic.wait32 / memory.atomic.notify on pool->epoch (offset 192)
 * instead of Emscripten libc++'s fallback polling/nanosleep loop (which sleeps
 * on an unwakeable dummy address after 0.2 ms of idle and stalls 4 ms ticks).
 */
function patchMtThreadPool(wasmPath, outPath) {
  const watPath = `${outPath}.wat`;
  execFileSync(process.execPath, [join(binaryenDir, 'bin', 'wasm-dis'), wasmPath, '-o', watPath], { stdio: 'inherit' });
  let wat = readFileSync(watPath, 'utf8');

  const old3761 = `         (i32.atomic.store offset=192
          (local.get $3)
          (i32.const 0)
         )
         (drop
          (i64.atomic.rmw.add
           (i32.add
            (local.tee $2
             (i32.add
              (i32.shl
               (i32.and
                (call $5983
                 (i32.add
                  (local.get $3)
                  (i32.const 192)
                 )
                )
                (i32.const 255)
               )
               (i32.const 6)
              )
              (i32.const 720128)
             )
            )
            (i32.const 8)
           )
           (i64.const 1)
          )
         )
         (drop
          (i64.atomic.load
           (local.get $2)
          )
         )`;
  const new3761 = `         (i32.atomic.store offset=192
          (local.get $3)
          (i32.const 0)
         )
         (drop
          (memory.atomic.notify offset=192
           (local.get $3)
           (i32.const -1)
          )
         )`;

  const old3762 = `  (i64.store offset=192
   (local.get $0)
   (i64.const 1)
  )`;
  const new3762 = `  (i32.store offset=188
   (local.get $0)
   (i32.const 0)
  )
  (i64.store offset=192
   (local.get $0)
   (i64.const 1)
  )`;

  const old3766 = `   (i32.atomic.store offset=192
    (local.get $5)
    (i32.sub
     (i32.const 0)
     (i32.atomic.load offset=192
      (local.get $5)
     )
    )
   )
   (drop
    (i64.atomic.rmw.add
     (i32.add
      (local.tee $0
       (i32.add
        (i32.shl
         (i32.and
          (call $5983
           (i32.add
            (local.get $5)
            (i32.const 192)
           )
          )
          (i32.const 255)
         )
         (i32.const 6)
        )
        (i32.const 720128)
       )
      )
      (i32.const 8)
     )
     (i64.const 1)
    )
   )
   (drop
    (i64.atomic.load
     (local.get $0)
    )
   )`;
  const new3766 = `   (i32.atomic.store offset=192
    (local.get $5)
    (i32.sub
     (i32.const 0)
     (i32.atomic.load offset=192
      (local.get $5)
     )
    )
   )
   (if
    (i32.atomic.load offset=188
     (local.get $5)
    )
    (then
     (drop
      (memory.atomic.notify offset=192
       (local.get $5)
       (i32.const -1)
      )
     )
    )
   )`;

  if (!wat.includes(old3761) || !wat.includes(old3762) || !wat.includes(old3766)) {
    unlinkSync(watPath);
    throw new Error('Failed to match ThreadPoolContext notify patterns in mt/mujoco.wasm');
  }
  wat = wat.replace(old3761, new3761).replace(old3762, new3762).replace(old3766, new3766);

  const f3763Start = wat.indexOf(' (func $3763 (param $0 i32) (param $1 i32)\n');
  const f3764Start = wat.indexOf(' (func $3764 ', f3763Start);
  if (f3763Start < 0 || f3764Start < 0) {
    unlinkSync(watPath);
    throw new Error('Failed to locate $3763 (ThreadPoolContext::Worker) in mt/mujoco.wasm');
  }
  const new3763 = ` (func $3763 (param $0 i32) (param $1 i32)
  (local $expected i32)
  (local $task i32)
  (local $spins i32)
  (local.set $expected (i32.const 1))
  (block $exit
   (loop $outer
    (local.set $spins (i32.const 0))
    (block $woke
     (loop $spin
      (br_if $woke
       (i32.ne
        (i32.atomic.load offset=192 (local.get $0))
        (local.get $expected)
       )
      )
      (br_if $spin
       (i32.lt_u
        (local.tee $spins (i32.add (local.get $spins) (i32.const 1)))
        (i32.const 200000)
       )
      )
     )
     (drop
      (i32.atomic.rmw.add offset=188
       (local.get $0)
       (i32.const 1)
      )
     )
     (drop
      (memory.atomic.wait32 offset=192
       (local.get $0)
       (local.get $expected)
       (i64.const -1)
      )
     )
     (drop
      (i32.atomic.rmw.sub offset=188
       (local.get $0)
       (i32.const 1)
      )
     )
    )
    (br_if $exit
     (i32.eqz
      (local.tee $expected
       (i32.atomic.load offset=192 (local.get $0))
      )
     )
    )
    (if
     (i32.lt_s
      (local.tee $task
       (i32.atomic.rmw.add offset=64
        (local.get $0)
        (i32.const 1)
       )
      )
      (i32.load offset=16
       (local.get $0)
      )
     )
     (then
      (loop $work
       (call_indirect (type $8)
        (i32.load (local.get $0))
        (i32.load offset=4 (local.get $0))
        (i32.load offset=12 (local.get $0))
        (local.get $1)
        (local.get $task)
        (i32.load offset=8 (local.get $0))
       )
       (br_if $work
        (i32.lt_s
         (local.tee $task
          (i32.atomic.rmw.add offset=64
           (local.get $0)
           (i32.const 1)
          )
         )
         (i32.load offset=16
          (local.get $0)
         )
        )
       )
      )
     )
    )
    (drop
     (i32.atomic.rmw.add offset=128
      (local.get $0)
      (i32.const 1)
     )
    )
    (br $outer)
   )
  )
 )\n`;
  wat = wat.slice(0, f3763Start) + new3763 + wat.slice(f3764Start);
  writeFileSync(watPath, wat);
  execFileSync(process.execPath, [join(binaryenDir, 'bin', 'wasm-as'), '-all', watPath, '-o', outPath], { stdio: 'inherit' });
  unlinkSync(watPath);
}

// Both builds: the physics worker runs the multithreaded one when the page is
// cross-origin isolated, the single-threaded one otherwise.
function optimize(wasmPath, { patchMt = false } = {}) {
  const stampPath = `${wasmPath}.optimized`;
  const current = readFileSync(wasmPath);
  const currentHash = sha256(current);
  const stamp = existsSync(stampPath) ? JSON.parse(readFileSync(stampPath, 'utf8')) : null;
  if (stamp && stamp.output === currentHash && (!patchMt || stamp.mtPatch === MT_PATCH_VERSION)) {
    return log(`${wasmPath}: already optimized`);
  }
  const inputHash = stamp && stamp.output === currentHash ? stamp.input : currentHash;
  mkdirSync(cacheDir, { recursive: true });
  const optCached = join(cacheDir, `${sha256(`${inputHash} ${binaryenVersion} ${FLAGS.join(' ')}`)}.wasm`);
  if (!existsSync(optCached)) {
    log(`${wasmPath}: running wasm-opt (about two minutes, once per MuJoCo version)`);
    const out = `${optCached}.${process.pid}`;
    execFileSync(process.execPath, [join(binaryenDir, 'bin', 'wasm-opt'), wasmPath, ...FLAGS, '-o', out], { stdio: 'inherit' });
    renameSync(out, optCached);
  }
  let finalCached = optCached;
  if (patchMt) {
    finalCached = join(cacheDir, `${sha256(`${inputHash} ${binaryenVersion} ${FLAGS.join(' ')} ${MT_PATCH_VERSION}`)}.wasm`);
    if (!existsSync(finalCached)) {
      log(`${wasmPath}: patching ThreadPoolContext wait32/notify (${MT_PATCH_VERSION})`);
      const out = `${finalCached}.${process.pid}`;
      patchMtThreadPool(optCached, out);
      renameSync(out, finalCached);
    }
  }
  const output = readFileSync(finalCached);
  copyFileSync(finalCached, wasmPath);
  writeFileSync(
    stampPath,
    JSON.stringify({ input: inputHash, output: sha256(output), binaryen: binaryenVersion, flags: FLAGS, ...(patchMt ? { mtPatch: MT_PATCH_VERSION } : {}) }, null, 2),
  );
  log(`${wasmPath}: optimized ${current.length} -> ${output.length} bytes`);
}

if (process.env.MESH_SKIP_WASM_OPT) {
  log('skipped (MESH_SKIP_WASM_OPT)');
} else {
  optimize(require.resolve('@mujoco/mujoco/mujoco.wasm'));
  optimize(require.resolve('@mujoco/mujoco/mt/mujoco.wasm'), { patchMt: true });
}

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph, SceneJoint, SceneNode } from '../src/types/scene';
import type { AeroSnapEvent, AeroVoiceTelemetry } from '../src/workers/physicsWorkerProtocol';
import {
  evaluateGustWind,
  solveAeroAcousticVoice,
  solveClothSnapPulse,
} from '../src/utils/aeroAcoustics';
import {
  ensureNativeAeroBank,
  postWorkletAeroSilence,
  postWorkletAeroSnap,
  postWorkletAeroUpdate,
} from '../src/utils/modalAudioWorklet';
import { dronePreset, paperPlanePreset, windmillPreset } from '../src/presets/presetScenes';
import { bodyAngularVelocity, bodyPointVelocity, syncKinematics } from '../src/workers/bodyKinematics';
import { autoResetCount } from '../src/utils/mujocoAutoReset';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mjPromise: Promise<Mujoco> | null = null;
const getMujoco = () => (mjPromise ??= load_mujoco());

/**
 * Headless MuJoCo aerodynamic & cloth stepper mirroring `physicsWorker.ts`:
 * applies `executeScripts()` lift/drag + `evaluateGustWind()`, runs control scripts,
 * steps MuJoCo, and extracts hub-grouped `AeroVoiceTelemetry` + trailing-edge `AeroSnapEvent`s!
 */
async function stepAeroScene(
  scene: SceneGraph,
  opts: { ticks: number; windX?: number; windY?: number; density?: number },
): Promise<{
  finalVoices: AeroVoiceTelemetry[];
  snaps: AeroSnapEvent[];
  model: InstanceType<Mujoco['MjModel']>;
  data: InstanceType<Mujoco['MjData']>;
  dispose: () => void;
}> {
  const mj = await getMujoco();
  const windX = opts.windX ?? 0;
  const windY = opts.windY ?? 0;
  const density = opts.density ?? 0;
  const xml = compileToMJCF(scene, -9.81, 1.0, windX, windY, density, 0.0);
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);

  const bodyId = (n: string) => mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, n);
  const jointId = (n: string) => mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, n);
  const geomId = (n: string) => mj.mj_name2id(model, mj.mjtObj.mjOBJ_GEOM.value, n);

  const walk = (nodes: SceneNode[], fn: (n: SceneNode) => void) => {
    for (const n of nodes || []) {
      fn(n);
      walk(n.children || [], fn);
    }
  };

  // Seed actuators & initial velocities
  const actuatorJoints: SceneJoint[] = [];
  walk(scene.nodes, (n) => n.joints?.forEach((j) => { if (j.actuator) actuatorJoints.push(j); }));
  actuatorJoints.forEach((j, idx) => {
    if (j.actuator?.ctrlValue !== undefined && idx < model.nu) data.ctrl[idx] = j.actuator.ctrlValue;
  });
  mj.mj_forward(model, data);

  let seeded = false;
  walk(scene.nodes, (n) =>
    n.joints?.forEach((j) => {
      if (!j.initialVelocity) return;
      const jid = jointId(j.name);
      if (jid === -1) return;
      const dof = model.jnt_dofadr[jid];
      for (let i = 0; i < j.initialVelocity.length; i++) data.qvel[dof + i] = j.initialVelocity[i];
      seeded = true;
    }),
  );
  if (seeded) mj.mj_forward(model, data);

  // Build hub/wing/cloth voice groups (mirroring `rebuildHydroAndFlexureCaches` in `physicsWorker.ts`)
  interface ChainItem {
    node: SceneNode;
    bodyId: number;
    hingeDofAdr: number;
    hasFreeOrSlide: boolean;
  }
  const aeroItems: { node: SceneNode; bId: number; chain: ChainItem[] }[] = [];
  const collectChain = (list: SceneNode[], chain: ChainItem[]) => {
    for (const n of list || []) {
      const bId = bodyId(n.name || n.id) !== -1 ? bodyId(n.name || n.id) : bodyId(n.id);
      let hingeDofAdr = -1;
      let hasFreeOrSlide = false;
      for (const j of n.joints ?? []) {
        if (j.type === 'free' || j.type === 'slide') hasFreeOrSlide = true;
        if (j.type === 'hinge' && hingeDofAdr === -1) {
          const jid = jointId(j.name);
          if (jid !== -1) hingeDofAdr = model.jnt_dofadr[jid];
        }
      }
      const nextChain = bId > 0 ? [...chain, { node: n, bodyId: bId, hingeDofAdr, hasFreeOrSlide }] : chain;
      if (n.isAerodynamic && bId > 0) aeroItems.push({ node: n, bId, chain: nextChain });
      if (n.children?.length) collectChain(n.children, nextChain);
    }
  };
  collectChain(scene.nodes, []);

  const aeroSet = new Set(aeroItems.map((x) => x.node.id));
  const memRootMap = new Map<string, ChainItem>();
  for (const it of aeroItems) {
    let topAero: ChainItem | null = null;
    let hinged = 0;
    for (const anc of it.chain) {
      if (aeroSet.has(anc.node.id)) {
        if (!topAero) topAero = anc;
        if (anc.hingeDofAdr >= 0) hinged++;
      }
    }
    if (topAero && topAero.node.id !== it.node.id && hinged >= 1) {
      memRootMap.set(it.node.id, topAero);
      memRootMap.set(topAero.node.id, topAero);
    }
  }

  interface TestGroup {
    id: string;
    hubBodyId: number;
    hubJointDofAdr: number;
    bladeCount: number;
    isCloth: boolean;
    blades: {
      node: SceneNode;
      bId: number;
      areaM2: number;
      chordM: number;
      thicknessM: number;
      tipRadiusM: number;
      sigma: number;
      hingeDofAdr: number;
    }[];
    lastForceSum: number;
    lastRelSpeedAreaSum: number;
    lastAlphaAreaSum: number;
    lastAreaSum: number;
    lastTipMax: number;
  }

  const groups = new Map<string, TestGroup>();
  const bladeToGroup = new Map<string, TestGroup>();
  const trailingWatches: {
    nodeId: string;
    bodyId: number;
    sigma: number;
    dofAdrs: number[];
    prevNormVel: number;
    prevSpeedSq: number;
    prevCMag: number;
    init: boolean;
    lastSnapT: number;
  }[] = [];

  for (const { node, bId, chain } of aeroItems) {
    const geom = node.geoms?.[0];
    const s = geom?.size ?? [0.05, 0.05, 0.002];
    const halfX = s[0] || 0.05;
    const halfY = s[1] || halfX;
    const halfZ = s[2] || 0.002;
    const dims = [halfX * 2, halfY * 2, halfZ * 2].sort((a, b) => a - b);
    const thicknessM = Math.max(0.0005, dims[0]);
    const chordM = halfX * 2;
    const areaM2 = chordM * (halfY * 2);
    const mKg = Math.max(0.0002, model.body_mass[bId] || geom?.mass || 0.01);
    const sigma = Math.max(0.02, Math.min(2.5, mKg / areaM2));
    const selfItem = chain[chain.length - 1];

    const memRoot = memRootMap.get(node.id);
    if (memRoot) {
      let grp = groups.get(memRoot.node.id);
      if (!grp) {
        grp = {
          id: memRoot.node.id,
          hubBodyId: memRoot.bodyId,
          hubJointDofAdr: -1,
          bladeCount: 0,
          isCloth: true,
          blades: [],
          lastForceSum: 0,
          lastRelSpeedAreaSum: 0,
          lastAlphaAreaSum: 0,
          lastAreaSum: 0,
          lastTipMax: 0,
        };
        groups.set(grp.id, grp);
      }
      grp.blades.push({
        node,
        bId,
        areaM2,
        chordM,
        thicknessM,
        tipRadiusM: 0.1,
        sigma,
        hingeDofAdr: selfItem?.hingeDofAdr ?? -1,
      });
      bladeToGroup.set(node.id, grp);

      const hasAeroChild = (node.children ?? []).some((ch) => aeroSet.has(ch.id));
      if (!hasAeroChild && selfItem && selfItem.hingeDofAdr >= 0) {
        trailingWatches.push({
          nodeId: node.id,
          bodyId: bId,
          sigma,
          dofAdrs: chain.filter((c) => c.hingeDofAdr >= 0).map((c) => c.hingeDofAdr),
          prevNormVel: 0,
          prevSpeedSq: 0,
          prevCMag: 0,
          init: false,
          lastSnapT: -1,
        });
      }
      continue;
    }

    let hubAnc: ChainItem | null = null;
    for (let k = chain.length - 2; k >= 0; k--) {
      const anc = chain[k];
      if (anc.hingeDofAdr >= 0 && !anc.hasFreeOrSlide && (selfItem?.hingeDofAdr ?? -1) === -1) {
        hubAnc = anc;
        break;
      }
      if (anc.hasFreeOrSlide) break;
    }

    if (hubAnc) {
      const gp = geom?.pos ?? [0, 0, 0];
      const hubTipR = Math.max(0.02, Math.hypot(gp[0] || 0, gp[1] || 0, gp[2] || 0) + Math.max(halfX, halfY));
      let grp = groups.get(hubAnc.node.id);
      if (!grp) {
        grp = {
          id: hubAnc.node.id,
          hubBodyId: hubAnc.bodyId,
          hubJointDofAdr: hubAnc.hingeDofAdr,
          bladeCount: 0,
          isCloth: false,
          blades: [],
          lastForceSum: 0,
          lastRelSpeedAreaSum: 0,
          lastAlphaAreaSum: 0,
          lastAreaSum: 0,
          lastTipMax: 0,
        };
        groups.set(grp.id, grp);
      }
      grp.blades.push({ node, bId, areaM2, chordM, thicknessM, tipRadiusM: hubTipR, sigma, hingeDofAdr: -1 });
      bladeToGroup.set(node.id, grp);
    } else {
      let pId = bId;
      while (pId > 0 && model.body_dofnum[pId] === 0) pId = model.body_parentid[pId];
      const pName = mj.mj_id2name(model, mj.mjtObj.mjOBJ_BODY.value, pId) || node.id;
      let grp = groups.get(pName);
      if (!grp) {
        grp = {
          id: pName,
          hubBodyId: pId > 0 ? pId : bId,
          hubJointDofAdr: -1,
          bladeCount: 0,
          isCloth: false,
          blades: [],
          lastForceSum: 0,
          lastRelSpeedAreaSum: 0,
          lastAlphaAreaSum: 0,
          lastAreaSum: 0,
          lastTipMax: 0,
        };
        groups.set(pName, grp);
      }
      grp.blades.push({ node, bId, areaM2, chordM, thicknessM, tipRadiusM: 0.1, sigma, hingeDofAdr: -1 });
      bladeToGroup.set(node.id, grp);
    }
  }

  for (const grp of groups.values()) {
    if (!grp.isCloth && grp.hubJointDofAdr >= 0) {
      grp.bladeCount = grp.blades.length >= 2 ? grp.blades.length : 0;
    }
  }

  // Compile control scripts
  const scripted: { node: SceneNode; fn: (api: Record<string, unknown>) => void }[] = [];
  walk(scene.nodes, (n) => {
    if (n.script && n.script.trim()) {
      scripted.push({ node: n, fn: new Function('api', n.script) as (api: Record<string, unknown>) => void });
    }
  });

  const snaps: AeroSnapEvent[] = [];
  const dt = model.opt.timestep;

  for (let tick = 0; tick < opts.ticks; tick++) {
    data.xfrc_applied.fill(0);
    data.qfrc_applied.fill(0);
    for (const grp of groups.values()) {
      grp.lastForceSum = 0;
      grp.lastRelSpeedAreaSum = 0;
      grp.lastAlphaAreaSum = 0;
      grp.lastAreaSum = 0;
      grp.lastTipMax = 0;
    }

    const views = {
      cvel: data.cvel,
      xpos: data.xpos,
      subtreeCom: data.subtree_com,
      rootId: model.body_rootid,
    };

    // Aerodynamic forces (exact `executeScripts` model from `physicsWorker.ts`)
    for (const { node, bId } of aeroItems) {
      const geom = node.geoms?.[0];
      if (!geom) continue;
      let pId = bId;
      while (pId > 0 && model.body_dofnum[pId] === 0) pId = model.body_parentid[pId];
      const gId = geomId(geom.name || '');
      const gx = gId !== -1 ? data.geom_xpos[gId * 3] : data.xpos[bId * 3];
      const gy = gId !== -1 ? data.geom_xpos[gId * 3 + 1] : data.xpos[bId * 3 + 1];
      const gz = gId !== -1 ? data.geom_xpos[gId * 3 + 2] : data.xpos[bId * 3 + 2];

      const rx = gx - data.xipos[pId * 3];
      const ry = gy - data.xipos[pId * 3 + 1];
      const rz = gz - data.xipos[pId * 3 + 2];

      const [wx, wy, wz] = bodyAngularVelocity(views, bId);
      const [vx, vy, vz] = bodyPointVelocity(views, bId, [gx, gy, gz]);

      const o = bId * 9;
      const noseX = data.xmat[o], noseY = data.xmat[o + 3], noseZ = data.xmat[o + 6];
      const spanX = data.xmat[o + 1], spanY = data.xmat[o + 4], spanZ = data.xmat[o + 7];
      const upX = data.xmat[o + 2], upY = data.xmat[o + 5], upZ = data.xmat[o + 8];

      const grp = bladeToGroup.get(node.id);
      let lwX = windX;
      let lwY = windY;
      let lwZ = 0;
      if (grp?.isCloth && (lwX !== 0 || lwY !== 0)) {
        [lwX, lwY, lwZ] = evaluateGustWind(lwX, lwY, gx, gy, gz, data.time);
      }

      const relVx = vx - lwX;
      const relVy = vy - lwY;
      const relVz = vz - lwZ;
      const spanDotV = relVx * spanX + relVy * spanY + relVz * spanZ;
      const afVx = relVx - spanDotV * spanX;
      const afVy = relVy - spanDotV * spanY;
      const afVz = relVz - spanDotV * spanZ;
      const relSpeed = Math.hypot(afVx, afVy, afVz);

      if (relSpeed >= 0.05 && density >= 0) {
        const s = geom.size || [];
        const halfX = s[0] || 0.3;
        const halfY = s[1] || 0.2;
        const wingArea = (halfX * 2) * (halfY * 2);
        const chord = halfX * 2;
        const rho = density > 0 ? density : 1.225;
        const q = 0.5 * rho * relSpeed * relSpeed;
        const vhx = afVx / relSpeed, vhy = afVy / relSpeed, vhz = afVz / relSpeed;
        const v_nose = vhx * noseX + vhy * noseY + vhz * noseZ;
        const v_up = vhx * upX + vhy * upY + vhz * upZ;
        const alpha = Math.atan2(-v_up, v_nose);
        const alphaDeg = Math.abs((alpha * 180) / Math.PI);
        let CL: number;
        if (alphaDeg <= 15) CL = 5.7 * alpha;
        else if (alphaDeg <= 30) {
          const sign = Math.sign(alpha) || 1;
          const t = (alphaDeg - 15) / 15;
          CL = sign * (1.1 * (1 - t) + 0.4 * t);
        } else {
          CL = Math.sin(2 * alpha);
        }
        const CD = 0.05 + 1.5 * Math.sin(alpha) * Math.sin(alpha);
        const ldx = -v_up * noseX + v_nose * upX;
        const ldy = -v_up * noseY + v_nose * upY;
        const ldz = -v_up * noseZ + v_nose * upZ;
        const fx = (CL * ldx - CD * vhx) * q * wingArea;
        const fy = (CL * ldy - CD * vhy) * q * wingArea;
        const fz = (CL * ldz - CD * vhz) * q * wingArea;
        let scale = 1.0;
        const bodyMassVal = model.body_mass[pId] || 0;
        if (bodyMassVal > 0 && bodyMassVal < 0.15) {
          const fMagRaw = Math.hypot(fx, fy, fz);
          const maxPassiveForce = (0.35 * bodyMassVal * Math.max(1.0, relSpeed)) / dt;
          if (fMagRaw > maxPassiveForce) scale = maxPassiveForce / fMagRaw;
        }
        const sFx = fx * scale, sFy = fy * scale, sFz = fz * scale;
        const pm = -0.05 * alpha * q * wingArea * chord * scale;
        data.xfrc_applied[pId * 6 + 0] += sFx;
        data.xfrc_applied[pId * 6 + 1] += sFy;
        data.xfrc_applied[pId * 6 + 2] += sFz;
        data.xfrc_applied[pId * 6 + 3] += pm * spanX + (ry * sFz - rz * sFy) - 0.0005 * wx;
        data.xfrc_applied[pId * 6 + 4] += pm * spanY + (rz * sFx - rx * sFz) - 0.0005 * wy;
        data.xfrc_applied[pId * 6 + 5] += pm * spanZ + (rx * sFy - ry * sFx) - 0.0005 * wz;

        if (grp) {
          grp.lastForceSum += Math.hypot(sFx, sFy, sFz);
          grp.lastRelSpeedAreaSum += relSpeed * wingArea;
          grp.lastAlphaAreaSum += alphaDeg * wingArea;
          grp.lastAreaSum += wingArea;
          if (relSpeed > grp.lastTipMax) grp.lastTipMax = relSpeed;
        }
      }
    }

    // Run scripts (e.g. `free_drone_body` PD controller vs `unstable_drone_body` open-loop)
    for (const sc of scripted) {
      const bId = bodyId(sc.node.name || sc.node.id);
      sc.fn({
        getOrientation: () => Array.from({ length: 9 }, (_, i) => data.xmat[bId * 9 + i]),
        getAngularVelocity: () => bodyAngularVelocity(views, bId),
        applyTorque: (t: number[]) => {
          data.xfrc_applied[bId * 6 + 3] += t[0];
          data.xfrc_applied[bId * 6 + 4] += t[1];
          data.xfrc_applied[bId * 6 + 5] += t[2];
        },
        getWind: () => [windX, windY],
        getTime: () => data.time,
        getJointPosition: (jn: string) => data.qpos[model.jnt_qposadr[jointId(jn)]],
        getJointVelocity: (jn: string) => data.qvel[model.jnt_dofadr[jointId(jn)]],
        applyJointForce: (jn: string, f: number) => { data.qfrc_applied[model.jnt_dofadr[jointId(jn)]] += f; },
      });
    }

    // Free-joint damping (as in `applyFreeJointDamping`)
    walk(scene.nodes, (n) => {
      for (const j of n.joints ?? []) {
        if (j.type === 'free' && j.damping && j.damping > 0) {
          const bId = bodyId(n.name || n.id);
          if (bId > 0) {
            const [wx, wy, wz] = bodyAngularVelocity(views, bId);
            const [vx, vy, vz] = bodyPointVelocity(views, bId, [
              data.xipos[bId * 3],
              data.xipos[bId * 3 + 1],
              data.xipos[bId * 3 + 2],
            ]);
            const m = model.body_mass[bId] || 1;
            const ix = model.body_inertia[bId * 3] || 1;
            const iy = model.body_inertia[bId * 3 + 1] || 1;
            const iz = model.body_inertia[bId * 3 + 2] || 1;
            data.xfrc_applied[bId * 6 + 0] -= j.damping * m * vx;
            data.xfrc_applied[bId * 6 + 1] -= j.damping * m * vy;
            data.xfrc_applied[bId * 6 + 2] -= j.damping * m * vz;
            data.xfrc_applied[bId * 6 + 3] -= j.damping * ix * wx;
            data.xfrc_applied[bId * 6 + 4] -= j.damping * iy * wy;
            data.xfrc_applied[bId * 6 + 5] -= j.damping * iz * wz;
          }
        }
      }
    });

    const prevTime = data.time;
    const prevResets = autoResetCount(data);
    mj.mj_step(model, data);
    if (data.time <= prevTime || autoResetCount(data) !== prevResets) {
      throw new Error(`Simulation diverged (auto-reset at tick ${tick + 1}, t=${prevTime.toFixed(4)}s)`);
    }
    syncKinematics(mj, model, data);

    // Sample trailing-edge flag snaps
    const viewsAfter = {
      cvel: data.cvel,
      xpos: data.xpos,
      subtreeCom: data.subtree_com,
      rootId: model.body_rootid,
    };
    for (const w of trailingWatches) {
      const px = data.xpos[w.bodyId * 3];
      const py = data.xpos[w.bodyId * 3 + 1];
      const pz = data.xpos[w.bodyId * 3 + 2];
      const [vx, vy, vz] = bodyPointVelocity(viewsAfter, w.bodyId, [px, py, pz]);
      const mOff = w.bodyId * 9;
      const nx = data.xmat[mOff + 2], ny = data.xmat[mOff + 5], nz = data.xmat[mOff + 8];
      const vNorm = vx * nx + vy * ny + vz * nz;
      const speedSq = vx * vx + vy * vy + vz * vz;
      let cMag = 0;
      for (const da of w.dofAdrs) cMag += Math.abs(data.qfrc_constraint[da]) + Math.abs(data.qfrc_passive[da]);
      if (!w.init) {
        w.prevNormVel = vNorm;
        w.prevSpeedSq = speedSq;
        w.prevCMag = cMag;
        w.init = true;
        continue;
      }
      const accel = Math.abs(vNorm - w.prevNormVel) / dt;
      const reversal = vNorm * w.prevNormVel <= 0.02 || speedSq < w.prevSpeedSq * 0.72;
      const spike = cMag > w.prevCMag * 1.08 + 0.004 || accel > 55.0;
      w.prevNormVel = vNorm;
      w.prevSpeedSq = speedSq;
      w.prevCMag = cMag;
      const relS = Math.hypot(vx - windX, vy - windY, vz);
      if (accel > 26.0 && relS >= 0.8 && reversal && spike && data.time - w.lastSnapT >= 0.090) {
        w.lastSnapT = data.time;
        const mKg = Math.max(0.002, model.body_mass[w.bodyId] || 0.008);
        snaps.push({
          nodeId: w.nodeId,
          impulseNs: Math.min(0.45, mKg * accel * dt * 1.8),
          arealDensityKgM2: w.sigma,
          relSpeedMps: relS,
        });
      }
    }
  }

  const finalVoices: AeroVoiceTelemetry[] = [];
  const viewsEnd = {
    cvel: data.cvel,
    xpos: data.xpos,
    subtreeCom: data.subtree_com,
    rootId: model.body_rootid,
  };
  for (const grp of groups.values()) {
    let omega = grp.hubJointDofAdr >= 0 ? data.qvel[grp.hubJointDofAdr] : 0;
    if (grp.bladeCount >= 1 && grp.hubBodyId > 0) {
      const parentId = model.body_parentid[grp.hubBodyId];
      if (parentId > 0) {
        const hubW = bodyAngularVelocity(viewsEnd, grp.hubBodyId);
        const relMag = Math.hypot(hubW[0], hubW[1], hubW[2]);
        if (relMag > 0.1) omega = omega >= 0 ? relMag : -relMag;
      }
    }
    const totalArea = grp.blades.reduce((s, b) => s + b.areaM2, 0);
    const maxTipR = grp.blades.reduce((m, b) => Math.max(m, b.tipRadiusM), 0.05);
    const avgChord = grp.blades.reduce((s, b) => s + b.chordM * b.areaM2, 0) / Math.max(1e-6, totalArea);
    const avgThick = grp.blades.reduce((s, b) => s + b.thicknessM * b.areaM2, 0) / Math.max(1e-6, totalArea);
    const avgSigma = grp.blades.reduce((s, b) => s + b.sigma * b.areaM2, 0) / Math.max(1e-6, totalArea);
    const hingedBlades = grp.blades.filter((b) => b.hingeDofAdr >= 0);
    const bendRate =
      hingedBlades.length > 0
        ? hingedBlades.reduce((s, b) => s + Math.abs(data.qvel[b.hingeDofAdr]), 0) / hingedBlades.length
        : 0;
    const relSpeedMps = grp.lastAreaSum > 1e-6 ? grp.lastRelSpeedAreaSum / grp.lastAreaSum : 0;
    const tipSpeedMps = Math.max(grp.lastTipMax, Math.abs(omega) * maxTipR);
    const alphaDeg = grp.lastAreaSum > 1e-6 ? grp.lastAlphaAreaSum / grp.lastAreaSum : 0;

    if (density >= 0 && (relSpeedMps >= 0.25 || tipSpeedMps >= 0.25 || Math.abs(omega) >= 0.35)) {
      finalVoices.push({
        hubOrBodyId: grp.id,
        bladeCount: grp.bladeCount,
        omegaRadPerSec: omega,
        tipSpeedMps,
        relSpeedMps,
        alphaDeg,
        areaM2: totalArea,
        chordM: avgChord,
        thicknessM: avgThick,
        aeroForceN: grp.lastForceSum,
        arealDensityKgM2: avgSigma,
        bendRateRadPerSec: bendRate,
        ...(grp.isCloth ? { isCloth: true } : {}),
      });
    }
  }

  return {
    finalVoices,
    snaps,
    model,
    data,
    dispose: () => {
      data.delete();
      model.delete();
    },
  };
}

describe('Unified 3D Aeroacoustics (Rotors, Wings, Windmills & Cloth)', () => {
  it('scales Gutin f_BPF linearly with rotor Ω and blade count B (B=2 quadcopter vs B=3 windmill) and brightens harmonics with thrust/Mach', () => {
    const baseRotor: AeroVoiceTelemetry = {
      hubOrBodyId: 'rotor_hub',
      bladeCount: 2,
      omegaRadPerSec: 90 * Math.PI * 0.5, // 141.37 rad/s -> B=2 gives 45 Hz
      tipSpeedMps: 42,
      relSpeedMps: 30,
      alphaDeg: 10,
      areaM2: 0.028,
      chordM: 0.05,
      thicknessM: 0.002,
      aeroForceN: 1.5,
      arealDensityKgM2: 0.35,
      bendRateRadPerSec: 0,
    };

    const twoBlade = solveAeroAcousticVoice(baseRotor);
    const twoBladeDoubleSpeed = solveAeroAcousticVoice({
      ...baseRotor,
      omegaRadPerSec: baseRotor.omegaRadPerSec * 2,
      tipSpeedMps: baseRotor.tipSpeedMps * 2,
    });
    const threeBladeSameSpeed = solveAeroAcousticVoice({
      ...baseRotor,
      bladeCount: 3,
    });

    expect(twoBlade.tonalActive).toBe(true);
    expect(twoBlade.bpfHz).toBeCloseTo((2 * baseRotor.omegaRadPerSec) / (2 * Math.PI), 2);
    expect(twoBladeDoubleSpeed.bpfHz).toBeCloseTo(twoBlade.bpfHz * 2, 2);
    expect(threeBladeSameSpeed.bpfHz).toBeCloseTo(twoBlade.bpfHz * 1.5, 2);

    // Higher thrust loading + tip Mach brightens upper harmonics (n=4 / n=1 ratio increases) and raises dipole gain
    const highThrust = solveAeroAcousticVoice({
      ...baseRotor,
      tipSpeedMps: 95,
      aeroForceN: 8.5,
    });
    expect(highThrust.tonalGain).toBeGreaterThan(twoBlade.tonalGain);
    expect(highThrust.harmonicWeights[3] / highThrust.harmonicWeights[0]).toBeGreaterThan(
      twoBlade.harmonicWeights[3] / twoBlade.harmonicWeights[0],
    );

    // Stationary or vacuum rotors ramp cleanly to 0 gain and active: false
    const stationary = solveAeroAcousticVoice({
      ...baseRotor,
      omegaRadPerSec: 0,
      tipSpeedMps: 0.05,
      relSpeedMps: 0.05,
      aeroForceN: 0,
    });
    expect(stationary.active).toBe(false);
    expect(stationary.tonalGain).toBe(0);
    expect(stationary.noiseGain).toBe(0);

    const vacuum = solveAeroAcousticVoice({ ...baseRotor, isVacuum: true });
    expect(vacuum.active).toBe(false);
    expect(vacuum.tonalGain).toBe(0);
    expect(vacuum.noiseGain).toBe(0);
  });

  it('steps dronePreset in headless MuJoCo WASM with active rotor voices, non-zero thrust loading, and distinct motor frequencies on unstable_drone_body', async () => {
    const run = await stepAeroScene(dronePreset, { ticks: 550, windX: 2.5, windY: -1.2 });
    try {
      const mastRotors = run.finalVoices.filter((v) => /^rotor[1-4]$/.test(v.hubOrBodyId));
      const freeRotors = run.finalVoices.filter((v) => /^free_rotor[1-4]$/.test(v.hubOrBodyId));
      const unstableRotors = run.finalVoices.filter((v) => /^unstable_rotor[1-4]$/.test(v.hubOrBodyId));

      expect(mastRotors).toHaveLength(4);
      expect(freeRotors).toHaveLength(4);
      expect(unstableRotors).toHaveLength(4);

      for (const r of [...mastRotors, ...freeRotors, ...unstableRotors]) {
        expect(r.bladeCount).toBe(2);
        expect(r.aeroForceN).toBeGreaterThan(0.1);
        const solved = solveAeroAcousticVoice(r);
        expect(solved.active).toBe(true);
        expect(solved.tonalActive).toBe(true);
        expect(solved.bpfHz).toBeGreaterThan(24);
        expect(solved.tonalGain).toBeGreaterThan(0.01);
      }

      // As `unstable_drone_body` tips and tumbles without an attitude controller in a crosswind,
      // world-frame spin & asymmetric blade drag differentiate its 4 rotors' BPFs & dipole gains!
      const unstableSolved = unstableRotors.map(solveAeroAcousticVoice);
      const unstableBpfs = unstableSolved.map((s) => s.bpfHz);
      const bpfSpreadHz = Math.max(...unstableBpfs) - Math.min(...unstableBpfs);
      expect(bpfSpreadHz).toBeGreaterThan(0.01);
    } finally {
      run.dispose();
    }
  });

  it('contrasts sub-audible AM blade-pass swoosh (< 15 Hz BPF) on windmillPreset against high-speed Strouhal airframe whoosh & stall roughness on paperPlanePreset', async () => {
    const wmRun = await stepAeroScene(windmillPreset, { ticks: 1200, windX: 6.5, windY: 0 });
    try {
      const rotorVoice = wmRun.finalVoices.find((v) => v.hubOrBodyId === 'rotor');
      expect(rotorVoice).toBeDefined();
      expect(rotorVoice!.bladeCount).toBe(3);
      expect(Math.abs(rotorVoice!.omegaRadPerSec)).toBeGreaterThan(1.5);

      const solvedWindmill = solveAeroAcousticVoice(rotorVoice!);
      expect(solvedWindmill.active).toBe(true);
      // Low-RPM 3-blade turbine sits in the sub-audible blade-pass band (< 15 Hz):
      // tonal oscillator stays off while broadband wake noise is AM-modulated at f_BPF!
      expect(solvedWindmill.bpfHz).toBeGreaterThan(0.5);
      expect(solvedWindmill.bpfHz).toBeLessThan(15.0);
      expect(solvedWindmill.tonalActive).toBe(false);
      expect(solvedWindmill.tonalGain).toBe(0);
      expect(solvedWindmill.noiseGain).toBeGreaterThan(0.02);
      expect(solvedWindmill.amRateHz).toBeCloseTo(solvedWindmill.bpfHz, 2);
      expect(solvedWindmill.amDepth).toBeGreaterThan(0.45);
    } finally {
      wmRun.dispose();
    }

    const planeRun = await stepAeroScene(paperPlanePreset, { ticks: 120 });
    try {
      const wingVoice = planeRun.finalVoices.find((v) => v.hubOrBodyId === 'paper_plane_wing');
      expect(wingVoice).toBeDefined();
      expect(wingVoice!.bladeCount).toBe(0);
      expect(wingVoice!.relSpeedMps).toBeGreaterThan(2.5);

      const sleekGlide = solveAeroAcousticVoice({ ...wingVoice!, alphaDeg: 5.0 });
      const deepStall = solveAeroAcousticVoice({ ...wingVoice!, alphaDeg: 25.0 });

      expect(sleekGlide.tonalActive).toBe(false);
      expect(sleekGlide.noiseCenterHz).toBeGreaterThanOrEqual(120);
      expect(sleekGlide.noiseQ).toBeCloseTo(3.2, 1);
      expect(sleekGlide.stallRoughness).toBe(0);

      // Deep stall (|α| > 20°) widens bandpass Q (~0.75), lowers Strouhal center frequency (bluff wake d_eff grows),
      // boosts Curle dipole buffeting gain, and engages 8–18 Hz separated-flow flutter AM!
      expect(deepStall.stallRoughness).toBeGreaterThan(0.95);
      expect(deepStall.noiseQ).toBeLessThan(1.0);
      expect(deepStall.noiseCenterHz).toBeLessThan(sleekGlide.noiseCenterHz);
      expect(deepStall.noiseGain).toBeGreaterThan(sleekGlide.noiseGain);
      expect(deepStall.amRateHz).toBeGreaterThanOrEqual(8.0);
      expect(deepStall.amRateHz).toBeLessThanOrEqual(18.0);
      expect(deepStall.amDepth).toBeGreaterThan(0.5);
    } finally {
      planeRun.dispose();
    }
  });

  it('shifts cloth trailing-edge snap bandwidth downward with increasing areal density σ (nylon vs cotton vs canvas) and models weave rustle + gust shear', () => {
    const nylonSnap = solveClothSnapPulse({
      nodeId: 'nylon_tip',
      impulseNs: 0.045,
      arealDensityKgM2: 0.045,
      relSpeedMps: 7.0,
    });
    const cottonSnap = solveClothSnapPulse({
      nodeId: 'cotton_tip',
      impulseNs: 0.045,
      arealDensityKgM2: 0.15,
      relSpeedMps: 7.0,
    });
    const canvasSnap = solveClothSnapPulse({
      nodeId: 'canvas_tip',
      impulseNs: 0.045,
      arealDensityKgM2: 0.35,
      relSpeedMps: 7.0,
    });

    expect(nylonSnap.active).toBe(true);
    expect(cottonSnap.active).toBe(true);
    expect(canvasSnap.active).toBe(true);

    // Bandwidth & center frequency shift monotonically downward with areal density σ:
    //   nylon (1800–4800 Hz) > cotton (800–2000 Hz) > canvas (300–950 Hz)
    expect(nylonSnap.centerHz).toBeGreaterThan(1800);
    expect(cottonSnap.centerHz).toBeGreaterThan(800);
    expect(cottonSnap.centerHz).toBeLessThan(2000);
    expect(canvasSnap.centerHz).toBeGreaterThan(300);
    expect(canvasSnap.centerHz).toBeLessThan(950);
    expect(nylonSnap.lowpassHz).toBeGreaterThan(cottonSnap.lowpassHz);
    expect(cottonSnap.lowpassHz).toBeGreaterThan(canvasSnap.lowpassHz);

    // Asymmetric N-wave pulse duration τ_snap lengthens from ultralight nylon to heavy canvas within [0.7 ms, 2.6 ms]
    expect(nylonSnap.durationSec).toBeGreaterThanOrEqual(0.0007);
    expect(nylonSnap.durationSec).toBeLessThan(cottonSnap.durationSec);
    expect(cottonSnap.durationSec).toBeLessThan(canvasSnap.durationSec);
    expect(canvasSnap.durationSec).toBeLessThanOrEqual(0.0026);

    // Cloth continuous voice produces weave rustle proportional to bend rate & relative flow speed,
    // while spatially-sheared `evaluateGustWind` produces non-uniform crosswind & vertical gust components
    const clothVoice = solveAeroAcousticVoice({
      hubOrBodyId: 'cloth_sheet',
      bladeCount: 0,
      omegaRadPerSec: 0,
      tipSpeedMps: 7.5,
      relSpeedMps: 6.8,
      alphaDeg: 18,
      areaM2: 0.12,
      chordM: 0.30,
      thicknessM: 0.0015,
      aeroForceN: 1.4,
      arealDensityKgM2: 0.15,
      bendRateRadPerSec: 4.5,
      isCloth: true,
    });
    expect(clothVoice.active).toBe(true);
    expect(clothVoice.rustleGain).toBeGreaterThan(0.02);

    const g1 = evaluateGustWind(8.0, 0, 0.0, -0.2, 0.4, 0.5);
    const g2 = evaluateGustWind(8.0, 0, 0.3, 0.2, 0.5, 0.5);
    expect(Math.hypot(g1[0] - g2[0], g1[1] - g2[1], g1[2] - g2[2])).toBeGreaterThan(0.2);
  });

  it('wires NativeAeroBank (8 pooled WebAudio slots) into the shared studio-chamber output bus and silences cleanly', () => {
    const makeParam = (init = 0) => ({
      value: init,
      setValueAtTime(v: number) { this.value = v; },
      setTargetAtTime(v: number) { this.value = v; },
      cancelScheduledValues() {},
    });
    const makeGain = () => ({ gain: makeParam(1), connect() {}, disconnect() {} });
    const makeFilter = () => ({
      type: 'lowpass',
      frequency: makeParam(1000),
      Q: makeParam(1),
      gain: makeParam(0),
      connect() {},
      disconnect() {},
    });
    const makeOsc = () => ({
      type: 'sine',
      frequency: makeParam(440),
      detune: makeParam(0),
      setPeriodicWave() {},
      connect() {},
      disconnect() {},
      start() {},
      stop() {},
    });
    const mockCtx = {
      state: 'running',
      sampleRate: 48000,
      currentTime: 1.0,
      destination: {},
      createGain: makeGain,
      createBiquadFilter: makeFilter,
      createOscillator: makeOsc,
      createWaveShaper: () => ({ curve: null, oversample: 'none', connect() {}, disconnect() {} }),
      createDynamicsCompressor: () => ({
        threshold: makeParam(-3),
        knee: makeParam(6),
        ratio: makeParam(10),
        attack: makeParam(0.002),
        release: makeParam(0.12),
        connect() {},
      }),
      createConvolver: () => ({ normalize: false, buffer: null, connect() {}, disconnect() {} }),
      createBuffer: (_ch: number, len: number, sr: number) => {
        const arr = new Float32Array(len);
        return { sampleRate: sr, length: len, getChannelData: () => arr };
      },
      createBufferSource: () => ({
        buffer: null,
        loop: false,
        onended: null as (() => void) | null,
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
      }),
      createPeriodicWave: () => ({}),
    } as unknown as AudioContext;

    const aeroBank = ensureNativeAeroBank(mockCtx);
    expect(aeroBank).not.toBeNull();
    expect(aeroBank!.slots).toHaveLength(8);

    const droneVoice = solveAeroAcousticVoice({
      hubOrBodyId: 'rotor1',
      bladeCount: 2,
      omegaRadPerSec: 180,
      tipSpeedMps: 50,
      relSpeedMps: 38,
      alphaDeg: 10,
      areaM2: 0.028,
      chordM: 0.05,
      thicknessM: 0.002,
      aeroForceN: 2.4,
      arealDensityKgM2: 0.3,
      bendRateRadPerSec: 0,
    });
    postWorkletAeroUpdate(mockCtx, [droneVoice]);
    expect(aeroBank!.slots[0].wasActive).toBe(true);
    expect(aeroBank!.slots[0].tonalGain.gain.value).toBeGreaterThan(0.01);

    postWorkletAeroSnap(
      mockCtx,
      solveClothSnapPulse({ nodeId: 'flag_tip', impulseNs: 0.05, arealDensityKgM2: 0.15, relSpeedMps: 8.0 }),
    );

    postWorkletAeroSilence(mockCtx);
    expect(aeroBank!.slots[0].wasActive).toBe(false);
    expect(aeroBank!.slots[0].tonalGain.gain.value).toBe(0);
    expect(aeroBank!.slots[0].noiseGain.gain.value).toBe(0);

    // DocsModal Sound tab documents the new Rotors, Wings & Cloth Aeroacoustics section
    const docsSrc = fs.readFileSync(path.resolve(__dirname, '../src/components/docs/DocsModal.tsx'), 'utf8');
    expect(docsSrc).toContain('Rotors, Wings &amp; Cloth Aeroacoustics');
  });
});

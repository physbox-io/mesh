/**
 * What physics_get_object says about one body and the bodies under it.
 *
 * The scene graph as stored is no reply: a body's mesh arrays run to
 * megabytes, and a decomposed body carries every convex piece it collides as
 * as a geom of its own. A four-link arm of hollow brackets came back at about
 * 110 KB, nearly all of it pieces nobody authored and nobody can edit, each
 * with its own vertex count, box and watertight check. The pieces are counted
 * here, as physics_get_scene_summary counts them, and listed only with
 * `full`.
 */
import type { SceneGeom, SceneNode } from '../types/scene';
import type { BodyWorldPos } from './bodyWorld';
import type { PaintLayer } from './vertexPaint';
import { collisionReport, geomBboxOf, meshIntegrity } from './sceneSummary';
import { hzToNoteInfo } from './acousticTuning';
import { estimateBodyModes, type BodyModalProfile } from './modalAudio';
import { STRING_MATERIALS, analyzeSoundboxResonance, evaluateTautString } from './stringAcoustics';
import { extractBoreWaveguide, solvePlayableWindVoice } from './windAcoustics';
import { evaluateTensionedMembrane } from './membraneAcoustics';
import { extractTubeAirColumn } from './resonatorAcoustics';
import { isNonlinearPlateCandidate } from './nonlinearPlateAcoustics';
import type { ClothMaterialName } from '../types/cloth';
import type { ModelMirror } from '../types/sceneLayer';
import { CLOTH_MATERIALS } from './cloth/clothMesh';
import { garmentSettings } from './cloth/garments';
import { bodyFormLandmarksSummary, clothNodeSummary } from './cloth/clothSummary';
import { solveAeroAcousticVoice, solveClothSnapPulse } from './aeroAcoustics';

/** A paint layer as its colours, each with the vertices it covers, most first. */
function paintSummary(paint: PaintLayer): PaintLayer {
  const counts = new Map<string, number>();
  for (let i = 0; i < paint.idx.length; i++) {
    const [r, g, b] = [0, 1, 2].map((k) => paint.rgba[i * 4 + k]);
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const colors = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([hex, vertices]) => ({ hex, vertices }));
  return { res: paint.res, idx: [], rgba: [], paintedVertices: paint.idx.length, colors } as PaintLayer;
}

export const stripMeshArrays = (node: SceneNode): SceneNode => {
  const cloned = { ...node };
  if (cloned.geoms) {
    cloned.geoms = cloned.geoms.map((g) => {
      const rest = { ...g };
      delete rest.vertices;
      delete rest.faces;
      delete rest.renderVertices;
      delete rest.colliderVertices;
      delete rest.colliderFaces;
      delete rest.baseColliderVertices;
      // The undeformed copy a dented or reshaped mesh keeps: as big as the mesh.
      delete rest.baseVertices;
      delete rest.baseRenderVertices;
      // Brushed colour is an entry per painted vertex: a striped cat's ran to
      // 61 KB and overflowed physics_get_state on its own. Its colours are
      // listed instead; the arrays come with include_meshes / get_scene,
      // beside the vertices they index.
      if (rest.paint) rest.paint = paintSummary(rest.paint);
      // A text pattern's saved letter outlines are kilobytes of coordinates.
      if (rest.textures?.some((t) => t.options?.outline)) {
        rest.textures = rest.textures.map((t) => {
          if (!t.options?.outline) return t;
          const { outline: _outline, outlineSig: _sig, imageGrid: _grid, ...options } = t.options;
          return { ...t, options };
        });
      }
      return rest;
    });
  }
  if (cloned.children) {
    cloned.children = cloned.children.map(stripMeshArrays);
  }
  return cloned;
};

const generatedCollider = (g: SceneGeom) => g.csgDerived === 'collider' || !!g.contactClass;

/**
 * A node for the scene-wide replies (physics_get_state, physics_get_objects):
 * mesh arrays stripped, and the convex pieces and exact colliders generated
 * for contact counted instead of listed (`colliderGeoms`). A dress form is
 * broken into some 600 of them, and one form's alone made the state reply
 * 140 KB, too big to read. physics_get_object full=true lists them.
 */
export const stateNode = (node: SceneNode): SceneNode => {
  const geoms = node.geoms || [];
  const pieces = geoms.filter(generatedCollider).length;
  const out = stripMeshArrays({ ...node, geoms: pieces ? geoms.filter((g) => !generatedCollider(g)) : geoms, children: [] } as SceneNode);
  return { ...out, ...(pieces ? { colliderGeoms: pieces } : {}), children: (node.children || []).map(stateNode) } as SceneNode;
};

export interface ObjectReplyOptions {
  /** List every convex piece and exact pin or socket collider, and the generated SCAD. */
  full?: boolean;
  /** World positions by body id (bodyWorldPositions). */
  world?: Map<string, BodyWorldPos>;
  /** The scene's top-level bodies: a string's soundbox and a head's shell are found among them. */
  scene?: SceneNode[];
  /** Compiled MuJoCo model mirror (provides flex piece counts and outlines for `clothSummary`). */
  model?: ModelMirror | null;
  /** Live MuJoCo data mirror (provides `flexvert_xpos` for `clothSummary.bboxMm`). */
  data?: { flexvert_xpos?: ArrayLike<number> } | null;
}

const round = (v: number) => +v.toFixed(6);

/** A mesh geom with its size and integrity checks in place of its arrays. */
const withMeshChecks = (g: SceneGeom): SceneGeom => (g.type === 'mesh'
  ? { ...g, vertCount: (g.renderVertices || g.vertices || []).length / 3, faceCount: (g.faces || []).length / 3, bbox: geomBboxOf(g), ...meshIntegrity(g) } as SceneGeom
  : g);

/** Generated geoms an author never wrote: convex pieces, and a split part's exact pin and socket colliders. */

/** How it collides, without repeating the raw fields the node already carries. */
function collisionVerdict(node: SceneNode): Record<string, unknown> {
  const { collisionWarning: _w, collisionError: _e, solidity: _s, cavitiesFilled: _c, ...verdict } = collisionReport(node);
  return verdict;
}

const r1 = (v: number) => +v.toFixed(1);
const r3 = (v: number) => +v.toFixed(3);

/** Whether the body says anything acoustic: a spec, cloth, tuned pitch, or a Physical Material. */
const hasAcousticFields = (n: SceneNode) => !!(n.cloth || n.deformMaterial || n.acousticString || n.windInstrument
  || n.acousticMembrane || n.resonatorTube || n.nonlinearPlate || n.acousticBow || typeof n.tunedPitchHz === 'number');

/**
 * What the body sounds like, from the same solvers the audio engine uses:
 * pitch (Hz, note, cents off it), overtone ratio, regime and material, and per
 * spec what its solver says: a soundbox's cavity and plate resonances, a
 * string's stress and bridge coupling, a bore's modes, a head's partials, or a
 * cloth sheet's whip-snap and weave-rustle frequencies. Only for a body with an
 * acoustic field or cloth; null when nothing could be solved.
 */
function acousticsOf(node: SceneNode, scene?: SceneNode[]): Record<string, unknown> | null {
  if (!hasAcousticFields(node)) return null;
  try {
    if (node.cloth) {
      const rawMat = node.cloth.material
        ?? (node.cloth.garment ? garmentSettings(node.cloth.garment).material : node.cloth.pieces?.[0]?.material)
        ?? 'woven';
      const material = (rawMat in CLOTH_MATERIALS ? rawMat : 'woven') as ClothMaterialName;
      const mat = { ...CLOTH_MATERIALS[material], ...(node.cloth.materialOverrides ?? {}) };
      const snap = solveClothSnapPulse({
        nodeId: node.id,
        impulseNs: 0.08,
        relSpeedMps: 8.5,
        arealDensityKgM2: mat.arealDensity,
      });
      const voice = solveAeroAcousticVoice({
        hubOrBodyId: node.id,
        bladeCount: 0,
        omegaRadPerSec: 0,
        tipSpeedMps: 8.5,
        relSpeedMps: 8.5,
        alphaDeg: 18,
        areaM2: 0.25,
        chordM: 0.5,
        thicknessM: mat.thickness,
        aeroForceN: 2.0,
        isCloth: true,
        bendRateRadPerSec: 12,
        arealDensityKgM2: mat.arealDensity,
      });
      return {
        role: 'cloth_aero',
        material,
        arealDensityKgM2: r3(mat.arealDensity),
        snapCenterHz: r1(snap.centerHz),
        rustleFreqHz: r1(voice.rustleFreqHz),
      };
    }

    const out: Record<string, unknown> = {};
    let profile: BodyModalProfile | null = null;
    let pitchHz: number | null = null;
    let overtoneRatio: number | null = null;
    let regime: string | null = null;

    if (node.acousticString) {
      const ev = evaluateTautString(node, scene);
      if (ev) {
        profile = ev.profile;
        pitchHz = ev.fundamentalHz;
        out.string = {
          fundamentalHz: r3(ev.fundamentalHz),
          stressRatio: r3(ev.stressRatio),
          lengthM: r3(ev.lengthM),
          warnings: ev.warnings,
          ...(ev.bridgeCoupling > 0 ? { bridgeCoupling: r3(ev.bridgeCoupling) } : {}),
        };
      }
    }
    if (node.windInstrument) {
      const bore = extractBoreWaveguide(node);
      if (bore) {
        const spec = node.windInstrument;
        const voice = solvePlayableWindVoice(bore, Math.max(3.2, spec.breathKPa || 3.5), spec.embouchureHz);
        pitchHz = voice.pitchHz;
        const modes = bore.resonantModesHz;
        overtoneRatio = modes.length > 1 && modes[0] > 0 ? modes[1] / modes[0] : 2;
        regime = 'air_column';
        out.wind = {
          boreShape: bore.boreShape,
          lengthM: r3(bore.lengthM),
          resonantModesHz: bore.resonantModesHz.slice(0, 4).map(r1),
          muteFactor: r3(bore.muteFactor ?? 0),
          breachFactor: r3(bore.breachFactor ?? 0),
        };
      }
    }
    if (node.acousticMembrane) {
      const ev = evaluateTensionedMembrane(node, scene);
      if (ev) {
        profile = ev.profile;
        pitchHz = ev.fundamentalHz;
        out.membrane = { fundamentalHz: r3(ev.fundamentalHz), overtoneRatio: r3(ev.overtoneRatio), warnings: ev.warnings };
      }
    }
    if (node.resonatorTube) {
      const col = extractTubeAirColumn(node);
      if (col) {
        pitchHz = col.fundamentalHz;
        overtoneRatio =
          col.overtonesHz.length > 1 && col.overtonesHz[0] > 0
            ? col.overtonesHz[1] / col.overtonesHz[0]
            : col.endCondition === 'open_closed'
              ? 3
              : 2;
        regime = 'air_column';
        out.resonatorTube = { fundamentalHz: r3(col.fundamentalHz), endCondition: col.endCondition };
      }
    }
    // The body's own structural modes: the pitch of a bar or plate, and the
    // regime and material of everything else.
    profile ??= estimateBodyModes(node);
    pitchHz ??= profile.fundamentalHz;
    const note = hzToNoteInfo(pitchHz);
    out.fundamentalHz = r3(pitchHz);
    out.note = note.note;
    out.cents = note.cents;
    out.overtoneRatio = r3(overtoneRatio ?? profile.overtoneRatio);
    out.regime = regime ?? profile.regime;
    out.material = node.acousticString ? STRING_MATERIALS[node.acousticString.material]?.label ?? profile.material.label : profile.material.label;

    const box = analyzeSoundboxResonance(node);
    if (box.hasHollowCavity) {
      out.soundbox = {
        cavityVolumeLitres: r3(box.cavityVolumeLitres),
        helmholtzHz: box.helmholtzHz === null ? null : r1(box.helmholtzHz),
        topPlateHz: r1(box.topPlateHz),
        portCount: box.portCount,
      };
    }
    if (node.nonlinearPlate || isNonlinearPlateCandidate(node, profile)) out.nonlinearPlate = true;
    return out;
  } catch {
    return null;
  }
}

function replyNode(node: SceneNode, opts: ObjectReplyOptions): Record<string, unknown> {
  const geoms = node.geoms || [];
  const baseListed = opts.full ? geoms : geoms.filter((g) => !generatedCollider(g));
  const summarizeCurve = !opts.full && node.isCurve === true;
  const listed = summarizeCurve ? [] : baseListed;
  const pieces = geoms.filter((g) => g.csgDerived === 'collider').length;
  const exact = geoms.filter((g) => g.contactClass);
  const { csgScad, ...rest } = node;
  const world = opts.world?.get(node.id);
  const clothSummary = node.cloth ? clothNodeSummary(node, opts) : null;
  const formLandmarks = node.bodyForm ? bodyFormLandmarksSummary(node.bodyForm) : null;
  return {
    ...stripMeshArrays({ ...rest, geoms: listed.map(withMeshChecks), children: [] } as SceneNode),
    ...(summarizeCurve ? {
      geomCount: baseListed.length,
      curve: {
        segments: baseListed.length,
        ...(node.curvePoints ? { controlPoints: node.curvePoints.length } : {}),
        ...(node.curveWidth !== undefined ? { widthMm: +(node.curveWidth * 1000).toFixed(2) } : {}),
        ...(node.curveThickness !== undefined ? { thicknessMm: +(node.curveThickness * 1000).toFixed(2) } : {}),
        ...(node.curveClosed ? { closed: true } : {}),
        ...(node.curveBank ? { bankDeg: node.curveBank } : {}),
      },
    } : {}),
    ...(opts.full && csgScad !== undefined ? { csgScad } : {}),
    ...(clothSummary ? { clothSummary } : {}),
    ...(formLandmarks ? formLandmarks : {}),
    ...(() => {
      const acoustics = acousticsOf(node, opts.scene);
      return acoustics ? { acoustics } : {};
    })(),
    ...(world ? { worldPos: world.pos.map(round), worldPosSource: world.source } : {}),
    ...(node.csgEnabled ? {} : collisionVerdict(node)),
    ...(!opts.full && pieces ? { colliderGeoms: pieces } : {}),
    ...(!opts.full && exact.length ? {
      exactColliders: {
        pins: exact.filter((g) => g.contactClass === 'pin').length,
        sockets: exact.filter((g) => g.contactClass === 'socket').length,
      },
    } : {}),
    children: (node.children || []).map((c) => replyNode(c, opts)),
  };
}

export function objectReply(node: SceneNode, opts: ObjectReplyOptions = {}): Record<string, unknown> {
  return replyNode(node, opts);
}

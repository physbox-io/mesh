// physics_import_profile: an SVG, or the outline traced from a picture, as a
// flat part. The same work and defaults as the Import Profile dialog
// (utils/profileImport.ts).

import { useStore } from '../../store/useStore';
import { decodeImageUrl } from '../../utils/decodeImage';
import {
  svgProfile,
  traceProfile,
  profileNode,
  PROFILE_DEFAULTS,
  type Profile,
  type ProfileDetail,
  type ProfileSubject,
  type TraceResult,
} from '../../utils/profileImport';
import { settleScene } from './settleScene';
import { findNodeInScene, isFiniteNumber, isFiniteVec3 } from './bridgeUtils';
import type { McpCommands } from './types';

/** The dialog's own cap on a traced picture's long side. */
const MAX_TRACE_PX = 1000;

const SUBJECTS: ProfileSubject[] = ['auto', 'dark', 'light'];
const DETAILS: ProfileDetail[] = ['fine', 'normal', 'coarse'];

export const profileCommands: McpCommands = {
  IMPORT_PROFILE: async (msg) => {
    const m = msg as {
      svg?: unknown; imageData?: unknown; name?: unknown;
      widthMm?: unknown; heightMm?: unknown; thicknessMm?: unknown;
      threshold?: unknown; subject?: unknown; detail?: unknown;
      pos?: unknown;
    };
    if (m.svg !== undefined && m.svg !== null && typeof m.svg !== 'string') {
      return { ok: false, error: 'svg must be a string.' };
    }
    if (m.imageData !== undefined && m.imageData !== null && typeof m.imageData !== 'string') {
      return { ok: false, error: 'imageData must be a string.' };
    }
    const svg = typeof m.svg === 'string' && m.svg.length > 0 ? m.svg : undefined;
    const imageData = typeof m.imageData === 'string' && m.imageData.length > 0 ? m.imageData : undefined;
    if (!svg === !imageData) {
      return { ok: false, error: 'Give exactly one of svg (the drawing\'s text) or imageData (a picture, as a data URL or base64).' };
    }
    if (m.subject !== undefined && (typeof m.subject !== 'string' || !SUBJECTS.includes(m.subject as ProfileSubject))) {
      return { ok: false, error: `subject is one of ${SUBJECTS.join(', ')}.` };
    }
    if (m.detail !== undefined && (typeof m.detail !== 'string' || !DETAILS.includes(m.detail as ProfileDetail))) {
      return { ok: false, error: `detail is one of ${DETAILS.join(', ')}.` };
    }
    if (m.threshold !== undefined && (!isFiniteNumber(m.threshold) || !(m.threshold > 0 && m.threshold < 1))) {
      return { ok: false, error: 'threshold is a finite brightness between 0 and 1 (omit it to let the picture choose).' };
    }
    if (m.widthMm !== undefined && (!isFiniteNumber(m.widthMm) || m.widthMm <= 0)) {
      return { ok: false, error: 'widthMm must be a positive finite number.' };
    }
    if (m.heightMm !== undefined && (!isFiniteNumber(m.heightMm) || m.heightMm <= 0)) {
      return { ok: false, error: 'heightMm must be a positive finite number.' };
    }
    if (m.thicknessMm !== undefined && (!isFiniteNumber(m.thicknessMm) || m.thicknessMm <= 0)) {
      return { ok: false, error: 'thicknessMm must be a positive finite number.' };
    }
    if (m.pos !== undefined && !isFiniteVec3(m.pos)) {
      return { ok: false, error: 'pos must be [x, y, z] of finite numbers in metres.' };
    }
    const widthMm = m.widthMm as number | undefined;
    const heightMm = m.heightMm as number | undefined;
    const sized = {
      ...(widthMm !== undefined ? { widthMm } : {}),
      ...(heightMm !== undefined && widthMm === undefined ? { heightMm } : {}),
    };

    let profile: Profile;
    try {
      if (svg) {
        profile = svgProfile(svg, sized);
      } else {
        const src = imageData!.startsWith('data:') ? imageData! : `data:image/png;base64,${imageData!.trim()}`;
        const image = await decodeImageUrl(src, MAX_TRACE_PX);
        profile = traceProfile(image.data, image.width, image.height, {
          ...sized,
          subject: (m.subject as ProfileSubject) ?? PROFILE_DEFAULTS.subject,
          detail: (m.detail as ProfileDetail) ?? PROFILE_DEFAULTS.detail,
          ...(m.threshold !== undefined ? { threshold: m.threshold as number } : {}),
        });
      }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || String(e) };
    }

    const thicknessMm = (m.thicknessMm as number | undefined) ?? PROFILE_DEFAULTS.thicknessMm;
    const pos = m.pos as [number, number, number] | undefined;
    const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : (svg ? 'svg_profile' : 'traced_profile');
    const node = profileNode(profile, { name, thicknessMm, ...(pos ? { pos } : {}) });
    const res = await settleScene([...(useStore.getState().sceneGraph.nodes || []), node], { replacesScene: false });
    // The scad compile only logs a failure, so look for the mesh it should have made.
    const built = findNodeInScene(useStore.getState().sceneGraph.nodes || [], node.id);
    const compiled = !!built?.geoms?.some((g) => (g.renderVertices?.length ?? g.vertices?.length ?? 0) > 0);
    if (!compiled && (res.ok || res.scadErrors?.length)) {
      useStore.getState().deleteNode(node.id);
      return {
        ok: false,
        nodeId: node.id,
        error: res.error || 'The outline was read but its OpenSCAD body did not compile, so the part has no shape. Try detail "coarse" (fewer points) or a simpler drawing.',
      };
    }
    const traced = imageData ? (profile as TraceResult) : null;
    return {
      ok: res.ok,
      ...(res.error ? { error: res.error } : {}),
      nodeId: node.id,
      name: node.name,
      widthMm: Number(profile.widthMm.toFixed(2)),
      heightMm: Number(profile.heightMm.toFixed(2)),
      thicknessMm,
      shapes: profile.shapes.length,
      holes: profile.shapes.reduce((n, s) => n + s.holes.length, 0),
      pointCount: profile.pointCount,
      ...(traced ? {
        threshold: Number(traced.threshold.toFixed(3)),
        tracedPart: traced.byAlpha ? 'opaque (by transparency)' : traced.darkSubject ? 'dark' : 'light',
      } : {}),
      ...(profile.notes.length ? { notes: profile.notes } : {}),
      hint: 'The body is OpenSCAD with `thickness = ...;` on its second line: change it with physics_update_object { scad }. To cut the outline into a part, place it overlapping and call physics_combine { id: <the part>, withIds: [<this nodeId>], op: "difference" }.',
    };
  },
};

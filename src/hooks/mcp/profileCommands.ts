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
import { findNodeInScene } from './bridgeUtils';
import type { McpCommands } from './types';

/** The dialog's own cap on a traced picture's long side. */
const MAX_TRACE_PX = 1000;

const SUBJECTS: ProfileSubject[] = ['auto', 'dark', 'light'];
const DETAILS: ProfileDetail[] = ['fine', 'normal', 'coarse'];

export const profileCommands: McpCommands = {
  IMPORT_PROFILE: async (msg) => {
    const m = msg as {
      svg?: string; imageData?: string; name?: string;
      widthMm?: number; heightMm?: number; thicknessMm?: number;
      threshold?: number; subject?: string; detail?: string;
      pos?: [number, number, number];
    };
    if (!m.svg === !m.imageData) {
      return { ok: false, error: 'Give exactly one of svg (the drawing\'s text) or imageData (a picture, as a data URL or base64).' };
    }
    if (m.subject !== undefined && !SUBJECTS.includes(m.subject as ProfileSubject)) {
      return { ok: false, error: `subject is one of ${SUBJECTS.join(', ')}.` };
    }
    if (m.detail !== undefined && !DETAILS.includes(m.detail as ProfileDetail)) {
      return { ok: false, error: `detail is one of ${DETAILS.join(', ')}.` };
    }
    if (m.threshold !== undefined && !(m.threshold > 0 && m.threshold < 1)) {
      return { ok: false, error: 'threshold is a brightness between 0 and 1 (omit it to let the picture choose).' };
    }
    const sized = {
      ...(m.widthMm && m.widthMm > 0 ? { widthMm: m.widthMm } : {}),
      ...(m.heightMm && m.heightMm > 0 && !(m.widthMm && m.widthMm > 0) ? { heightMm: m.heightMm } : {}),
    };

    let profile: Profile;
    try {
      if (m.svg) {
        profile = svgProfile(m.svg, sized);
      } else {
        const src = m.imageData!.startsWith('data:') ? m.imageData! : `data:image/png;base64,${m.imageData!.trim()}`;
        const image = await decodeImageUrl(src, MAX_TRACE_PX);
        profile = traceProfile(image.data, image.width, image.height, {
          ...sized,
          subject: (m.subject as ProfileSubject) ?? PROFILE_DEFAULTS.subject,
          detail: (m.detail as ProfileDetail) ?? PROFILE_DEFAULTS.detail,
          ...(m.threshold !== undefined ? { threshold: m.threshold } : {}),
        });
      }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || String(e) };
    }

    const thicknessMm = m.thicknessMm && m.thicknessMm > 0 ? m.thicknessMm : PROFILE_DEFAULTS.thicknessMm;
    const pos = Array.isArray(m.pos) && m.pos.length === 3 ? m.pos : undefined;
    const node = profileNode(profile, { name: m.name || (m.svg ? 'svg_profile' : 'traced_profile'), thicknessMm, ...(pos ? { pos } : {}) });
    const res = await settleScene([...(useStore.getState().sceneGraph.nodes || []), node], { replacesScene: false });
    // The scad compile only logs a failure, so look for the mesh it should have made.
    const built = findNodeInScene(useStore.getState().sceneGraph.nodes || [], node.id);
    const compiled = !!built?.geoms?.some((g) => (g.renderVertices?.length ?? g.vertices?.length ?? 0) > 0);
    if (res.ok && !compiled) {
      return { ok: false, nodeId: node.id, error: 'The outline was read but its OpenSCAD body did not compile, so the part has no shape. Try detail "coarse" (fewer points) or a simpler drawing.' };
    }
    const traced = m.imageData ? (profile as TraceResult) : null;
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

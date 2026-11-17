// ---------------------------------------------------------------------------
// A clean capture: one frame drawn without the editor's overlays
// ---------------------------------------------------------------------------
//
// physics_get_screenshot with clean: true sets this for the frame it reads,
// so the picture is the model — no transform gizmo, dimension arrows, measure
// or rounding handles, selection tint or outline — while the selection itself,
// which is the user's, stays as it was.
// ---------------------------------------------------------------------------

import { create } from 'zustand';

export const useCapture = create<{ clean: boolean }>(() => ({ clean: false }));

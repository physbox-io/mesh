/**
 * Whether a gizmo handle currently has the pointer.
 *
 * A click on one of `TransformControls`' handles lands on a mesh with no R3F
 * handlers, which R3F reports to the canvas as a *miss* — and the canvas
 * answers a miss by clearing the selection, which takes the gizmo away
 * underneath the drag using it. `App.tsx` asks here first.
 *
 * A module variable rather than store state because it is read inside an event
 * handler on the same tick it is written, before any render could carry it.
 * Its own file so `TransformGizmo.tsx` exports only a component and keeps hot
 * reload.
 */
let busy = false;

export const setGizmoBusy = (value: boolean) => { busy = value; };
export const isGizmoBusy = () => busy;

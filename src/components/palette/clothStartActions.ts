import { useStore } from '../../store/useStore';
import { framingForBounds, gridCellForBounds } from '../../utils/frameScene';

/**
 * Frames the camera on a dress form, as loading a scene frames it: the form's
 * geoms come from a worker a moment later, so its bounds are taken from its
 * height and stance rather than from what is drawn yet. Left at the default
 * view (a part of 160 mm), a person stood gigantic in it.
 */
export function frameForm(form: { pos?: number[]; bodyForm?: { height: number } }) {
  const [x, y] = form.pos ?? [0, 0, 0], h = form.bodyForm?.height ?? 1.7;
  const bounds = { min: [x - 0.25 * h, y - 0.15 * h, 0] as [number, number, number], max: [x + 0.25 * h, y + 0.15 * h, h] as [number, number, number] };
  useStore.getState().setCameraOverride(framingForBounds(bounds));
  useStore.setState({ gridCellSizeMm: gridCellForBounds(bounds) });
}

/** Adds a node to the scene (one undo step), selected unless told not to. */
export function addClothNode(node: Parameters<ReturnType<typeof useStore.getState>['addHardwareComponentNode']>[0], select = true) {
  useStore.getState().addHardwareComponentNode(node, { select });
}

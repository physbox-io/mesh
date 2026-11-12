// Geoms a builder makes from a body's own parameters. Such a body's geoms are
// replaced whenever its parameters change, so an edit to one of them would be
// silently lost: the inspector offers the parameters instead.

import type { SceneGeom, SceneNode } from '../types/scene';

/** Whether this body's geoms are rebuilt from parameters of its own (a dress form's measurements). */
export const rebuildsGeoms = (node: SceneNode): boolean => !!node.bodyForm;

/** Whether an edit to this geom would be overwritten by the next rebuild. */
export const geomIsRebuilt = (node: SceneNode, geom: SceneGeom | undefined): boolean => !!geom?.internal && rebuildsGeoms(node);

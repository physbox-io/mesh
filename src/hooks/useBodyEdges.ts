import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import type { SceneNode } from '../types/scene';
import { bodyEdges, bodyUp, whyNotRoundable, type BodyEdges } from '../utils/edgeRoundBase';
import { csgSourceGeoms, meshChecksum } from '../utils/csg';
import { findNodeById } from '../utils/sceneTree';

/**
 * What the unrounded shape depends on, cheaply. Not the program itself: a
 * lattice body's program is megabytes of polyhedron, and this runs on every
 * render of a panel whose body is being rewritten as a size slider moves.
 */
function shapeKey(node: SceneNode): string {
  return JSON.stringify([
    node.id,
    node.csgFn ?? null,
    csgSourceGeoms(node).map((g) => [
      g.type, g.type === 'mesh' ? meshChecksum(g) : g.size, g.pos, g.quat, g.euler, g.fromto, g.csg ?? null, g.role ?? null, g.thread?.pitch ?? null,
    ]),
  ]);
}

/**
 * The edges a body offers for rounding, loaded when it changes shape.
 *
 * Dragging a rounding's size rewrites the body's roundings on every step, but
 * the edges of the unrounded part have not moved, so nothing reloads.
 * bodyEdges caches by program, so the viewport tool and the panel share one
 * compile.
 */
export function useBodyEdges(node: SceneNode | null): { edges: BodyEdges | null; error: string | null; loading: boolean } {
  const why = whyNotRoundable(node);
  const key = node && !why ? shapeKey(node) : null;
  const nodeId = node?.id ?? null;
  const [state, setState] = useState<{ key: string | null; edges: BodyEdges | null; error: string | null }>({ key: null, edges: null, error: null });

  useEffect(() => {
    if (!key || !nodeId) return;
    let live = true;
    const nodes = useStore.getState().sceneGraph.nodes;
    const current = findNodeById(nodes, nodeId);
    if (!current) return;
    bodyEdges(current, bodyUp(nodes, nodeId))
      .then((edges) => { if (live) setState({ key, edges, error: null }); })
      .catch((err) => { if (live) setState({ key, edges: null, error: err instanceof Error ? err.message : String(err) }); });
    return () => { live = false; };
  }, [key, nodeId]);

  if (why) return { edges: null, error: why, loading: false };
  const fresh = state.key === key;
  return { edges: fresh ? state.edges : null, error: fresh ? state.error : null, loading: !fresh };
}

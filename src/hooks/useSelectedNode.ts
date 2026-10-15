import { useMemo } from 'react';
import { useStore } from '../store/useStore';
import type { SceneNode } from '../types/scene';
import { findNodeById } from '../utils/sceneTree';

/** The selected body, looked up anywhere in the tree; null when nothing is selected. */
export function useSelectedNode(): SceneNode | null {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const sceneGraph = useStore((s) => s.sceneGraph);
  return useMemo(
    () => (selectedNodeId ? findNodeById(sceneGraph.nodes, selectedNodeId) : null),
    [selectedNodeId, sceneGraph],
  );
}

import type { SceneNode } from '../types/scene';

// Helper to find a node by ID in hierarchy
/** Whether a body sits at the top of the scene rather than inside another. */
export function isTopLevel(nodes: SceneNode[], id: string): boolean {
  return nodes.some((n) => n.id === id);
}

export function findNodeById(nodes: SceneNode[], targetId: string): SceneNode | null {
  for (const node of nodes) {
    if (node.id === targetId) return node;
    if (node.children) {
      const res = findNodeById(node.children, targetId);
      if (res) return res;
    }
  }
  return null;
}

// Helper to get recursive world position of a node
export function getNodeWorldPos(nodes: SceneNode[], targetId: string, currentOffset: [number, number, number] = [0, 0, 0]): [number, number, number] | null {
  for (const node of nodes) {
    const nodeWorld: [number, number, number] = [
      currentOffset[0] + node.pos[0],
      currentOffset[1] + node.pos[1],
      currentOffset[2] + node.pos[2]
    ];
    if (node.id === targetId) return nodeWorld;
    if (node.children) {
      const childResult = getNodeWorldPos(node.children, targetId, nodeWorld);
      if (childResult) return childResult;
    }
  }
  return null;
}

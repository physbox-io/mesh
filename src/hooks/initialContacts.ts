import { getPhysicsWorkerClient, type PhysicsState } from '../store/useStore';
import { compileToMJCF } from '../utils/mjcf';
import type { ContactHistory } from '../workers/physicsWorkerProtocol';

/** A worker that has not answered by now is not going to; the box check answers instead. */
const CONTACT_TIMEOUT_MS = 8000;

/**
 * The contacts MuJoCo generates for the scene as authored, before anything has
 * moved: one headless step on a model of its own, so the live simulation is
 * left alone. The contacts of a step are found at its start, from the pose the
 * scene was written in.
 *
 * Null when the worker cannot run the scene (a compile error, a dead worker),
 * so the caller can fall back to the graph.
 */
export async function initialContacts(
  store: Pick<PhysicsState, 'sceneGraph' | 'gravityZ' | 'floorFriction' | 'windX' | 'windY' | 'density' | 'floorBounce'>,
): Promise<ContactHistory[] | null> {
  const { sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce } = store;
  const client = getPhysicsWorkerClient();
  const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce, {
    meshFiles: client.meshFiles,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CONTACT_TIMEOUT_MS); });
  try {
    const result = await Promise.race([client.runHeadless(xml, sceneGraph, 1, 1), timeout]);
    if (!result || !result.ok) return null;
    return result.trajectory[0]?.contacts ?? [];
  } finally {
    clearTimeout(timer);
  }
}

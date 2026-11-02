import type { SceneGraph } from '../types/scene';
import type { MeshFileSink } from './meshVfs';
import { contactArenaXml } from './contactArena';
import { compiledSlide, needsEllipticCone } from './contactFriction';
import { SMALL_BODY_INERTIA_FLOOR, hasSubMillimetreMovingBody } from './incomingBodyCheck';
import { FLOOR_CONTACT, PRINT_CONTACT_TIME } from './contactClasses';
import { prepareScene } from './mjcfPrepare';
import { collectMeshAssets, meshAssetsXml } from './mjcfMeshAssets';
import { constraintsXml } from './mjcfConstraints';
import { buildNode } from './mjcfBody';

/*
 * The scene graph compiled to MuJoCo's MJCF. The graph, not the XML, is the
 * source of truth; this is the one place it becomes a model. In passes:
 *
 * - mjcfPrepare: a copy of the scene, resolved to the geoms that simulate
 *   (booleans, convex pieces, contact classes, body masses, wedges), its names
 *   final and its breakable members split.
 * - mjcfMeshAssets: the <asset> block, and which meshes get exact inertia.
 * - mjcfConstraints: actuators, tendons, equalities, contact exclusions.
 * - mjcfBody: the bodies themselves, last, since the constraints pass gives
 *   some joints a clutch or moves their friction.
 */

export interface MjcfOptions {
  /**
   * Let bodies that have come to rest sleep (`<flag sleep="enable"/>`): MuJoCo
   * stops integrating and colliding a resting island until something touches
   * it. Asked for only while a scene has shattered, where a settled heap of
   * shards is most of the step, so no other scene changes behaviour.
   */
  sleep?: boolean;
  /**
   * Emit meshes as binary files in the worker's VFS rather than as inline
   * vertex text, where the sink says so. See utils/meshVfs.ts. Left out, every
   * mesh is inline exactly as before, which is what the tests, the exported
   * presets and the native app's golden XML rely on.
   */
  meshFiles?: MeshFileSink;
  /**
   * Filled in by the compile: the triangles of every mesh the model holds,
   * which is most of what it costs the engine's heap (utils/denseMesh.ts).
   */
  stats?: { meshTriangles: number };
}

export const compileToMJCF = (
  scene: SceneGraph,
  gravityZ: number = -9.81,
  floorFriction: number = 1.0,
  windX: number = 0,
  windY: number = 0,
  density: number = 0,
  floorBounce: number = 0.0,
  opts: MjcfOptions = {},
) => {
  if (!Array.isArray(scene?.nodes)) {
    throw new Error('compileToMJCF: scene.nodes must be an array (got a malformed SceneGraph)');
  }
  const { nodes, breaks } = prepareScene(scene);
  const printFidelity = scene.simFidelity === 'print';

  const meshes = collectMeshAssets(nodes);
  if (opts.stats) opts.stats.meshTriangles = meshes.reduce((n, g) => n + g.faces!.length / 3, 0);
  const assetXml = meshAssetsXml(meshes, opts.meshFiles);
  // Before the bodies: it writes into their joints.
  const extras = constraintsXml(nodes, breaks);

  // Contact time constant. MuJoCo will not go below twice the timestep, and at
  // 0.002 s a part resting under gravity sinks about g*t^2 = 0.04 mm into what
  // it rests on — against 4 mm at the standard 0.02. That is the difference
  // between a 0.2 mm clearance meaning something and meaning nothing.
  const contactTime = printFidelity ? PRINT_CONTACT_TIME : 0.02;

  return `
<mujoco model="dynamic_scene">
  <!-- integrator="implicitfast": joint damping and velocity-actuator gains are
       integrated implicitly rather than explicitly. With the default Euler
       integrator a velocity actuator is only stable while kv < 2*I/timestep, so
       a small-but-stiff joint silently detonates: the gear presets (kv=20 on a
       0.0018 kg.m^2 hub) hit "Nan, Inf or huge value in QACC" within 15ms and
       simply never turned. This costs nothing and removes a whole class of
       "the preset does nothing" failure that depends on a body's scale. -->
${breaks.numerics.length ? `  <!-- A floor on rotational inertia, for scenes with breakable members and
       joint blobs. A 1.8 mm strand has almost none about its own axis, and
       MuJoCo softens a weld by the inverse inertia of what it holds: a pasta
       cantilever with a 7 g tip drooped 48 mm and swung, where 1e-8 holds it
       to 0.35 mm. Far below anything a part bigger than a strand has. -->
  <compiler boundinertia="1e-8" />
` : hasSubMillimetreMovingBody(nodes) ? `  <!-- A floor on rotational inertia for a moving part under 1 mm: MuJoCo
       refuses one below 1e-15 kg.m^2, and a 0.2 mm cube has 1e-17. -->
  <compiler boundinertia="${SMALL_BODY_INERTIA_FLOOR}" />
` : ''}${contactArenaXml(nodes)}  <option integrator="implicitfast"${needsEllipticCone(nodes, floorFriction) ? ' cone="elliptic"' : ''} timestep="0.001" gravity="0 0 ${gravityZ}" wind="${windX} ${windY} 0" density="${density}" iterations="50" tolerance="1e-10" ls_iterations="50" ls_tolerance="1e-12"${opts.sleep ? '><flag sleep="enable" /></option>' : ' />'}${assetXml}
  <default>
    <geom solref="${contactTime} 1" solimp="0.99 0.9999 0.0001 0.5 2" />
  </default>
  <worldbody>
    <light directional="true" pos="-0.3 0.3 1.5" dir="0.3 -0.3 -1.5" diffuse="0.8 0.8 0.8" />
    <geom name="floor" type="plane" size="0.5 0.5 0.1" pos="0 0 0" rgba="0.9 0.9 0.9 1" friction="${compiledSlide(floorFriction)} 0.005 0.0001" solref="${contactTime} ${Math.max(0, 1 - floorBounce).toFixed(3)}" solimp="0.99 0.9999 0.0001 0.5 2"${printFidelity ? ` contype="${FLOOR_CONTACT}" conaffinity="${FLOOR_CONTACT}"` : ''} />
    
    ${nodes.map(buildNode).join('\n')}
  </worldbody>
${extras.actuator}${extras.tendon}${extras.equality}${extras.contact}
</mujoco>
  `.trim();
};

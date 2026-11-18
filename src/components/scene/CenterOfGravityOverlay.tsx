import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { useViewQuality } from '../../store/viewQualityStore';
import { analyzeStability } from '../../utils/balancePart';
import { resolveWaterSurfaceAt } from '../../utils/hydrostatics';
import { findNodeById } from '../../utils/sceneTree';
import { metresPerPixel } from '../../utils/cameraScale';
import { bodyPoseOf } from './bodyPose';
import type { FrameFlagWindow } from '../../types/sceneLayer';

/** MuJoCo world Z-up [x, y, z] -> Three.js Y-up [x, z, -y]. */
function toThree(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, z, -y);
}

/**
 * 3D Centre of Gravity (CoG) marker, gravity plumb line, and floor support
 * polygon for the selected body when toggled on in Balance & Ballast.
 */
export function CenterOfGravityOverlay() {
  const showCog = useViewQuality((s) => s.showCenterOfGravity);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const sceneGraph = useStore((s) => s.sceneGraph);
  const waterLevel = useStore((s) => s.waterLevel);
  const isPlaying = useStore((s) => s.isPlaying);
  const { camera, size } = useThree();

  const node = useMemo(
    () => (showCog && selectedNodeId ? findNodeById(sceneGraph.nodes, selectedNodeId) : null),
    [showCog, selectedNodeId, sceneGraph.nodes],
  );

  const effectiveWaterZ = useMemo(
    () => (node ? resolveWaterSurfaceAt(sceneGraph.nodes, node, waterLevel) : null),
    [sceneGraph.nodes, node, waterLevel],
  );

  const report = useMemo(() => {
    if (!node || node.hardwarePart || node.simulation) return null;
    const hasSolid = (node.geoms ?? []).some(
      (g) => g.type !== 'plane' && !g.csgDerived && g.csg !== 'difference',
    );
    if (!hasSolid) return null;
    return analyzeStability(node, effectiveWaterZ ?? 0);
  }, [node, effectiveWaterZ]);

  const cogGroupRef = useRef<THREE.Group>(null);
  const dropDotRef = useRef<THREE.Mesh>(null);

  const plumbGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    return geo;
  }, []);

  const plumbMat = useMemo(
    () =>
      new THREE.LineDashedMaterial({
        color: '#f59e0b',
        dashSize: 0.004,
        gapSize: 0.003,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
        toneMapped: false,
      }),
    [],
  );

  const plumbLineObj = useMemo(() => {
    const line = new THREE.Line(plumbGeo, plumbMat);
    line.renderOrder = 996;
    line.raycast = () => null;
    return line;
  }, [plumbGeo, plumbMat]);

  useEffect(() => {
    return () => {
      plumbGeo.dispose();
      plumbMat.dispose();
    };
  }, [plumbGeo, plumbMat]);

  useFrame(() => {
    if (!report || !node || !cogGroupRef.current) return;
    if ((window as FrameFlagWindow).DISABLE_USEFRAME) return;

    // Track live MuJoCo body pose when available, falling back to authored world CoM
    let worldX = report.comWorld[0];
    let worldY = report.comWorld[1];
    let worldZ = report.comWorld[2];
    const pose = bodyPoseOf(node.id, node.pos);
    if (pose.live) {
      const localCom = new THREE.Vector3(...report.comLocal);
      localCom.applyMatrix3(pose.rot).add(pose.pos);
      worldX = localCom.x;
      worldY = localCom.y;
      worldZ = localCom.z;
    }

    const cogThree = toThree(worldX, worldY, worldZ);
    cogGroupRef.current.position.copy(cogThree);

    // Keep screen-space size crisp regardless of zoom or orthographic/perspective view
    const dist = camera.position.distanceTo(cogThree);
    const mpp = metresPerPixel(camera, dist, size.height);
    const radiusM = Math.max(0.0015, mpp * 7.5);
    cogGroupRef.current.scale.setScalar(radiusM);

    const floorZ = isPlaying ? Math.min(0, report.stand.baseZ) : report.stand.baseZ;
    const dropThree = toThree(worldX, worldY, floorZ);
    const posAttr = plumbGeo.getAttribute('position') as THREE.BufferAttribute;
    posAttr.setXYZ(0, cogThree.x, cogThree.y, cogThree.z);
    posAttr.setXYZ(1, dropThree.x, dropThree.y, dropThree.z);
    posAttr.needsUpdate = true;
    plumbLineObj.computeLineDistances();

    if (dropDotRef.current) {
      dropDotRef.current.position.copy(dropThree);
      dropDotRef.current.scale.setScalar(Math.max(0.001, mpp * 4));
    }
  });

  if (!showCog || !node || !report) return null;

  const stands = report.stand.stands;
  const accentColor = stands ? '#10b981' : '#f59e0b';
  const initialCogThree = toThree(report.comWorld[0], report.comWorld[1], report.comWorld[2]);
  const initialDropThree = toThree(report.comWorld[0], report.comWorld[1], report.stand.baseZ);

  const supportLoop =
    !isPlaying && report.stand.supportPolygon.length >= 3
      ? [...report.stand.supportPolygon, report.stand.supportPolygon[0]].map(([px, py]) =>
          toThree(px, py, report.stand.baseZ),
        )
      : null;

  return (
    <group>
      {/* Gravity plumb line from CoG straight down to the base plane */}
      <primitive object={plumbLineObj} />

      {/* Projected plumb point on the base plane */}
      <mesh ref={dropDotRef} position={initialDropThree} raycast={() => null} renderOrder={997}>
        <sphereGeometry args={[1, 14, 14]} />
        <meshBasicMaterial color={accentColor} depthTest={false} toneMapped={false} />
      </mesh>

      {/* Floor support polygon when paused */}
      {supportLoop && (
        <Line
          points={supportLoop}
          color={accentColor}
          lineWidth={1.5}
          transparent
          opacity={0.75}
          depthTest={false}
          renderOrder={995}
        />
      )}

      {/* 3D Centre of Gravity marker (unit radius, scaled to crisp pixel size in useFrame) */}
      <group ref={cogGroupRef} position={initialCogThree}>
        {/* High-contrast dark outer ring + amber core + crosshair axes */}
        <mesh raycast={() => null} renderOrder={998}>
          <sphereGeometry args={[1.0, 18, 18]} />
          <meshBasicMaterial color="#0f172a" depthTest={false} toneMapped={false} />
        </mesh>
        <mesh raycast={() => null} renderOrder={999}>
          <sphereGeometry args={[0.72, 16, 16]} />
          <meshBasicMaterial color="#f59e0b" depthTest={false} toneMapped={false} />
        </mesh>
        <Line
          points={[
            [-1.8, 0, 0],
            [1.8, 0, 0],
          ]}
          color="#f59e0b"
          lineWidth={1.5}
          depthTest={false}
          renderOrder={999}
        />
        <Line
          points={[
            [0, -1.8, 0],
            [0, 1.8, 0],
          ]}
          color="#f59e0b"
          lineWidth={1.5}
          depthTest={false}
          renderOrder={999}
        />
        <Line
          points={[
            [0, 0, -1.8],
            [0, 0, 1.8],
          ]}
          color="#f59e0b"
          lineWidth={1.5}
          depthTest={false}
          renderOrder={999}
        />
        <Html center style={{ pointerEvents: 'none', transform: 'translate(0, -20px)' }}>
          <span className="px-1.5 py-0.5 rounded bg-slate-900/90 border border-amber-400/60 text-[9px] font-mono font-bold text-amber-300 shadow whitespace-nowrap">
            CoG ({(report.comWorld[0] * 1000).toFixed(0)}, {(report.comWorld[1] * 1000).toFixed(0)}, {(report.comWorld[2] * 1000).toFixed(0)} mm)
          </span>
        </Html>
      </group>
    </group>
  );
}

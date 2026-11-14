import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { BackgroundId } from '../../types/scene';
import {
  buildConcreteSidewalkTextures,
  buildCuttingMatTexture,
  buildEquirectSkybox,
  buildGraffitiBrickWallTextures,
  buildGraniteTextures,
  buildMeadowGroundTextures,
  buildPegboardTexture,
  buildTileableBrickTextures,
  buildWoodTextures,
  buildWovenRugTextures,
} from '../../utils/backgroundTextures';
import {
  BACKGROUND_LIGHTING,
  buildCoffeeTableGeometries,
  buildMeadowGeometries,
  buildMountainGeometries,
  buildUrbanGeometries,
  buildWorkbenchGeometries,
} from '../../utils/backgroundScenery';

const NOOP_RAYCAST: THREE.Object3D['raycast'] = () => null;
const SCENERY_USER_DATA = Object.freeze({ isBackground: true, tracedScenery: true });
const ROOT_USER_DATA = Object.freeze({ isBackground: true });

/**
 * Realistic-scale 3D background world (skybox, PBR lighting environment, and
 * non-interactive metre-scale terrain / architecture / tabletop props) for
 * viewport inspection and path-traced renders.
 *
 * Every mesh stubs `raycast` so background clicks still clear the selection,
 * carries `userData.isBackground` so STL/3MF exports skip it, and carries
 * `userData.tracedScenery` so Render mode (`PathTracedView`) traces it.
 */
export function EnvironmentBackground({ preset }: { preset: Exclude<BackgroundId, 'studio'> }) {
  const getThree = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const lighting = BACKGROUND_LIGHTING[preset];

  const skybox = useMemo(() => buildEquirectSkybox(preset), [preset]);

  useLayoutEffect(() => {
    const { scene } = getThree();
    const prevIntensity = scene.environmentIntensity;
    scene.environmentIntensity = lighting.environmentIntensity;
    invalidate();
    return () => {
      scene.environmentIntensity = prevIntensity;
      skybox.background.dispose();
      skybox.environment.dispose();
      invalidate();
    };
  }, [getThree, skybox, lighting.environmentIntensity, invalidate]);

  return (
    <>
      <primitive object={skybox.background} attach="background" />
      <primitive object={skybox.environment} attach="environment" />
      <hemisphereLight args={[lighting.hemiSkyColor, lighting.hemiGroundColor, lighting.hemiIntensity]} />
      <group userData={ROOT_USER_DATA}>
        {preset === 'meadow' && <MeadowScenery />}
        {preset === 'mountains' && <MountainsScenery />}
        {preset === 'urban' && <UrbanScenery />}
        {preset === 'workbench' && <WorkbenchScenery />}
        {preset === 'coffee_table' && <CoffeeTableScenery />}
      </group>
    </>
  );
}

function MeadowScenery() {
  const invalidate = useThree((s) => s.invalidate);
  const assets = useMemo(() => ({
    geos: buildMeadowGeometries(),
    tex: buildMeadowGroundTextures(),
  }), []);

  useEffect(() => {
    invalidate();
    return () => {
      assets.geos.terrain.dispose();
      assets.geos.foliage.dispose();
      assets.geos.stones.dispose();
      assets.tex.map.dispose();
      assets.tex.normalMap.dispose();
    };
  }, [assets, invalidate]);

  return (
    <>
      <mesh
        geometry={assets.geos.terrain}
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          map={assets.tex.map}
          normalMap={assets.tex.normalMap}
          normalScale={new THREE.Vector2(0.42, 0.42)}
          roughness={0.86}
          metalness={0}
        />
      </mesh>
      <mesh
        geometry={assets.geos.foliage}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          roughness={0.7}
          metalness={0}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh
        geometry={assets.geos.stones}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          roughness={0.8}
          metalness={0.02}
        />
      </mesh>
    </>
  );
}

function MountainsScenery() {
  const invalidate = useThree((s) => s.invalidate);
  const assets = useMemo(() => ({
    geos: buildMountainGeometries(),
    tex: buildGraniteTextures(),
  }), []);

  useEffect(() => {
    invalidate();
    return () => {
      assets.geos.terrain.dispose();
      assets.geos.scree.dispose();
      assets.tex.map.dispose();
      assets.tex.normalMap.dispose();
    };
  }, [assets, invalidate]);

  return (
    <>
      <mesh
        geometry={assets.geos.terrain}
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          map={assets.tex.map}
          normalMap={assets.tex.normalMap}
          normalScale={new THREE.Vector2(0.68, 0.68)}
          roughness={0.82}
          metalness={0.03}
        />
      </mesh>
      <mesh
        geometry={assets.geos.scree}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          roughness={0.78}
          metalness={0.04}
        />
      </mesh>
    </>
  );
}

function UrbanScenery() {
  const invalidate = useThree((s) => s.invalidate);
  const assets = useMemo(() => ({
    geos: buildUrbanGeometries(),
    brickTex: buildTileableBrickTextures(),
    wallTex: buildGraffitiBrickWallTextures('center'),
    leftWallTex: buildGraffitiBrickWallTextures('left_alley'),
    rightWallTex: buildGraffitiBrickWallTextures('right_wing'),
    sidewalkTex: buildConcreteSidewalkTextures(),
  }), []);

  useEffect(() => {
    invalidate();
    return () => {
      assets.geos.sidewalk.dispose();
      assets.geos.brickWalls.dispose();
      assets.geos.graffitiWall.dispose();
      assets.geos.leftGraffitiWall.dispose();
      assets.geos.rightGraffitiWall.dispose();
      assets.geos.matteProps.dispose();
      assets.geos.metalProps.dispose();
      assets.brickTex.map.dispose();
      assets.brickTex.normalMap.dispose();
      assets.wallTex.map.dispose();
      assets.wallTex.normalMap.dispose();
      assets.leftWallTex.map.dispose();
      assets.leftWallTex.normalMap.dispose();
      assets.rightWallTex.map.dispose();
      assets.rightWallTex.normalMap.dispose();
      assets.sidewalkTex.map.dispose();
      assets.sidewalkTex.normalMap.dispose();
    };
  }, [assets, invalidate]);

  return (
    <>
      <mesh
        geometry={assets.geos.sidewalk}
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          map={assets.sidewalkTex.map}
          normalMap={assets.sidewalkTex.normalMap}
          normalScale={new THREE.Vector2(0.65, 0.65)}
          roughness={0.88}
          metalness={0.02}
        />
      </mesh>
      <mesh
        geometry={assets.geos.brickWalls}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          map={assets.brickTex.map}
          normalMap={assets.brickTex.normalMap}
          normalScale={new THREE.Vector2(0.85, 0.85)}
          roughness={0.84}
          metalness={0.02}
        />
      </mesh>
      <mesh
        geometry={assets.geos.graffitiWall}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          map={assets.wallTex.map}
          normalMap={assets.wallTex.normalMap}
          normalScale={new THREE.Vector2(0.85, 0.85)}
          roughness={0.76}
          metalness={0.03}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </mesh>
      <mesh
        geometry={assets.geos.leftGraffitiWall}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          map={assets.leftWallTex.map}
          normalMap={assets.leftWallTex.normalMap}
          normalScale={new THREE.Vector2(0.85, 0.85)}
          roughness={0.76}
          metalness={0.03}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </mesh>
      <mesh
        geometry={assets.geos.rightGraffitiWall}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          map={assets.rightWallTex.map}
          normalMap={assets.rightWallTex.normalMap}
          normalScale={new THREE.Vector2(0.85, 0.85)}
          roughness={0.76}
          metalness={0.03}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </mesh>
      <mesh
        geometry={assets.geos.matteProps}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          roughness={0.86}
          metalness={0.02}
        />
      </mesh>
      <mesh
        geometry={assets.geos.metalProps}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          roughness={0.26}
          metalness={0.85}
        />
      </mesh>
    </>
  );
}

function WorkbenchScenery() {
  const invalidate = useThree((s) => s.invalidate);
  const assets = useMemo(() => ({
    geos: buildWorkbenchGeometries(),
    oakTex: buildWoodTextures('butcher_oak'),
    matTex: buildCuttingMatTexture(),
    pegTex: buildPegboardTexture(),
  }), []);

  useEffect(() => {
    invalidate();
    return () => {
      assets.geos.oakWood.dispose();
      assets.geos.cuttingMat.dispose();
      assets.geos.pegboard.dispose();
      assets.geos.matteProps.dispose();
      assets.geos.metalProps.dispose();
      assets.oakTex.map.dispose();
      assets.oakTex.normalMap.dispose();
      assets.matTex.dispose();
      assets.pegTex.dispose();
    };
  }, [assets, invalidate]);

  return (
    <>
      <mesh
        geometry={assets.geos.oakWood}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshPhysicalMaterial
          vertexColors
          map={assets.oakTex.map}
          normalMap={assets.oakTex.normalMap}
          normalScale={new THREE.Vector2(0.45, 0.45)}
          roughness={0.42}
          metalness={0.02}
          clearcoat={0.18}
          clearcoatRoughness={0.32}
        />
      </mesh>
      <mesh
        geometry={assets.geos.cuttingMat}
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          map={assets.matTex}
          roughness={0.82}
          metalness={0.0}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </mesh>
      <mesh
        geometry={assets.geos.pegboard}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          map={assets.pegTex}
          roughness={0.72}
          metalness={0.04}
        />
      </mesh>
      <mesh
        geometry={assets.geos.matteProps}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          roughness={0.74}
          metalness={0.06}
        />
      </mesh>
      <mesh
        geometry={assets.geos.metalProps}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          roughness={0.22}
          metalness={0.88}
        />
      </mesh>
    </>
  );
}

function CoffeeTableScenery() {
  const invalidate = useThree((s) => s.invalidate);
  const assets = useMemo(() => ({
    geos: buildCoffeeTableGeometries(),
    walnutTex: buildWoodTextures('walnut'),
    rugTex: buildWovenRugTextures(),
    floorTex: buildWoodTextures('oak_floor'),
  }), []);

  useEffect(() => {
    invalidate();
    return () => {
      assets.geos.walnutWood.dispose();
      assets.geos.rug.dispose();
      assets.geos.oakFloor.dispose();
      assets.geos.ceramicProps.dispose();
      assets.geos.matteProps.dispose();
      assets.walnutTex.map.dispose();
      assets.walnutTex.normalMap.dispose();
      assets.rugTex.map.dispose();
      assets.rugTex.normalMap.dispose();
      assets.floorTex.map.dispose();
      assets.floorTex.normalMap.dispose();
    };
  }, [assets, invalidate]);

  return (
    <>
      <mesh
        geometry={assets.geos.walnutWood}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshPhysicalMaterial
          vertexColors
          map={assets.walnutTex.map}
          normalMap={assets.walnutTex.normalMap}
          normalScale={new THREE.Vector2(0.35, 0.35)}
          roughness={0.3}
          metalness={0.02}
          clearcoat={0.28}
          clearcoatRoughness={0.24}
        />
      </mesh>
      <mesh
        geometry={assets.geos.rug}
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          map={assets.rugTex.map}
          normalMap={assets.rugTex.normalMap}
          normalScale={new THREE.Vector2(0.75, 0.75)}
          roughness={0.94}
          metalness={0}
        />
      </mesh>
      <mesh
        geometry={assets.geos.oakFloor}
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshPhysicalMaterial
          map={assets.floorTex.map}
          normalMap={assets.floorTex.normalMap}
          normalScale={new THREE.Vector2(0.38, 0.38)}
          roughness={0.44}
          metalness={0.01}
          clearcoat={0.2}
          clearcoatRoughness={0.3}
        />
      </mesh>
      <mesh
        geometry={assets.geos.ceramicProps}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshPhysicalMaterial
          vertexColors
          roughness={0.08}
          metalness={0}
          clearcoat={0.92}
          clearcoatRoughness={0.05}
        />
      </mesh>
      <mesh
        geometry={assets.geos.matteProps}
        castShadow
        receiveShadow
        raycast={NOOP_RAYCAST}
        userData={SCENERY_USER_DATA}
      >
        <meshStandardMaterial
          vertexColors
          roughness={0.86}
          metalness={0}
        />
      </mesh>
    </>
  );
}

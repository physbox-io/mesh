export const pendulumXML = `
<mujoco model="pendulum">
  <option timestep="0.001" gravity="0 0 -9.81" />
  
  <worldbody>
    <light directional="true" pos="-0.3 0.3 1.5" dir="0.3 -0.3 -1.5" diffuse="0.8 0.8 0.8" />
    <geom name="floor" type="plane" size="0.5 0.5 0.1" rgba="0.2 0.2 0.2 1" />
    
    <geom name="base_plate" type="box" size="0.06 0.06 0.01" pos="0 0 0.01" rgba="0.3 0.3 0.35 1" />
    <geom name="stand_post" type="cylinder" size="0.01 0.28" pos="0 0 0.29" rgba="0.4 0.4 0.45 1" />
    <geom name="stand_axle" type="cylinder" size="0.008 0.04" pos="0 0 0.58" euler="90 0 0" rgba="0.5 0.5 0.55 1" />

    <body name="pole" pos="0 0 0.58">
      <joint name="hinge" type="hinge" axis="0 1 0" pos="0 0 0" damping="0.001" />
      <geom name="pole_geom" type="capsule" fromto="0 0 0 0.22 0 0" size="0.005" rgba="0.7 0.7 0.7 1" />
      <geom name="pole_bob_geom" type="sphere" size="0.018" pos="0.22 0 0" rgba="0.3 0.5 0.85 1" />
      
      <body name="pole2" pos="0.22 0 0">
        <joint name="hinge2" type="hinge" axis="0 1 0" pos="0 0 0" damping="0.001" />
        <geom name="pole2_geom" type="capsule" fromto="0 0 0 0.22 0 0" size="0.005" rgba="0.6 0.6 0.6 1" />
        <geom name="bob_geom" type="sphere" size="0.022" pos="0.22 0 0" rgba="0.2 0.6 1.0 1" />
      </body>
    </body>
  </worldbody>
</mujoco>
`;

export interface MeshData {
  vertices: number[];
  faces: number[];
  renderVertices: number[];
}

export function generatePyramidMeshData(w: number, d: number, h: number): MeshData {
  const hw = w / 2;
  const hd = d / 2;
  
  // Three.js Y-up (X=right, Y=up, Z=depth)
  const vertices = [
    -hw, 0,  hd,  // 0: front-left
     hw, 0,  hd,  // 1: front-right
     hw, 0, -hd,  // 2: back-right
    -hw, 0, -hd,  // 3: back-left
     0,  h,   0   // 4: apex
  ];
  
  const faces = [
    0, 1, 4, // front side (CCW looking outward)
    1, 2, 4, // right side (CCW looking outward)
    2, 3, 4, // back side (CCW looking outward)
    3, 0, 4, // left side (CCW looking outward)
    0, 2, 1, // base tri 1 (pointing down -Y)
    0, 3, 2  // base tri 2 (pointing down -Y)
  ];
  
  // Z-up: mapping (x, y, z) -> (x, -z, y)
  const renderVertices = [
    -hw, -hd, 0,
     hw, -hd, 0,
     hw,  hd, 0,
    -hw,  hd, 0,
     0,   0,  h
  ];
  
  return { vertices, faces, renderVertices };
}

export function generateConeMeshData(r: number, h: number, segments: number = 16): MeshData {
  const vertices: number[] = [];
  const renderVertices: number[] = [];
  const faces: number[] = [];
  
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const x = r * Math.cos(theta);
    const z = r * Math.sin(theta);
    vertices.push(x, 0, z);
    renderVertices.push(x, -z, 0);
  }
  
  vertices.push(0, h, 0);
  renderVertices.push(0, 0, h);
  
  const apexIndex = segments;
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    faces.push(i, next, apexIndex); // CCW looking outward
  }
  
  for (let i = 1; i < segments - 1; i++) {
    faces.push(0, i, i + 1); // pointing down -Y
  }
  
  return { vertices, faces, renderVertices };
}

export function generateTorusMeshData(
  R: number, // Major radius
  r: number, // Minor (tube) radius
  radialSegments: number = 24,
  tubularSegments: number = 16
): MeshData {
  const vertices: number[] = [];
  const renderVertices: number[] = [];
  const faces: number[] = [];

  for (let i = 0; i <= radialSegments; i++) {
    const u = (i / radialSegments) * Math.PI * 2;
    const cosU = Math.cos(u);
    const sinU = Math.sin(u);

    for (let j = 0; j <= tubularSegments; j++) {
      const v = (j / tubularSegments) * Math.PI * 2;
      const cosV = Math.cos(v);
      const sinV = Math.sin(v);

      const x = (R + r * cosV) * cosU;
      const y = r * sinV;
      const z = (R + r * cosV) * sinU;

      vertices.push(x, y, z);
      renderVertices.push(x, -z, y);
    }
  }

  const stride = tubularSegments + 1;
  for (let i = 0; i < radialSegments; i++) {
    for (let j = 0; j < tubularSegments; j++) {
      const a = i * stride + j;
      const b = i * stride + j + 1;
      const c = (i + 1) * stride + j;
      const d = (i + 1) * stride + j + 1;

      faces.push(a, b, d);
      faces.push(a, d, c);
    }
  }

  return { vertices, faces, renderVertices };
}

export function generateTubeMeshData(
  innerRadius: number,
  outerRadius: number,
  height: number,
  segments: number = 24
): MeshData {
  const vertices: number[] = [];
  const renderVertices: number[] = [];
  const faces: number[] = [];
  
  const hh = height / 2;
  
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    // Outer top
    vertices.push(outerRadius * cosT, hh, outerRadius * sinT);
    renderVertices.push(outerRadius * cosT, -outerRadius * sinT, hh);

    // Outer bottom
    vertices.push(outerRadius * cosT, -hh, outerRadius * sinT);
    renderVertices.push(outerRadius * cosT, -outerRadius * sinT, -hh);

    // Inner top
    vertices.push(innerRadius * cosT, hh, innerRadius * sinT);
    renderVertices.push(innerRadius * cosT, -innerRadius * sinT, hh);

    // Inner bottom
    vertices.push(innerRadius * cosT, -hh, innerRadius * sinT);
    renderVertices.push(innerRadius * cosT, -innerRadius * sinT, -hh);
  }

  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;

    const ot_curr = i * 4;
    const ob_curr = i * 4 + 1;
    const it_curr = i * 4 + 2;
    const ib_curr = i * 4 + 3;

    const ot_next = next * 4;
    const ob_next = next * 4 + 1;
    const it_next = next * 4 + 2;
    const ib_next = next * 4 + 3;

    // Outer wall faces (looking outward)
    faces.push(ot_curr, ob_curr, ob_next);
    faces.push(ot_curr, ob_next, ot_next);

    // Inner wall faces (looking inward)
    faces.push(it_curr, ib_next, ib_curr);
    faces.push(it_curr, it_next, ib_next);

    // Top cap (outer top to inner top, looking up)
    faces.push(ot_curr, it_curr, it_next);
    faces.push(ot_curr, it_next, ot_next);

    // Bottom cap (outer bottom to inner bottom, looking down)
    faces.push(ob_curr, ib_next, ib_curr);
    faces.push(ob_curr, ob_next, ib_next);
  }

  return { vertices, faces, renderVertices };
}

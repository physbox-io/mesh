import {
  createLattice, vertexAt, addFace, orientFaces, serializeCage, toSceneGeom,
  setCrease, DEFAULT_UNIT, type Lattice,
} from '../src/utils/latticeMesh';
import WebSocket from 'ws';
import * as fs from 'node:fs';

// Scale: 0.1 mm per grid unit.
const mm = (v: number) => Math.round(v * 10);

export function generateTrefoilSculpture(): { lattice: Lattice; geom: ReturnType<typeof toSceneGeom> } {
  const lattice = createLattice(DEFAULT_UNIT);

  const N = 96; // 96 segments for a smooth, high-fidelity trefoil path
  const R = 18; // mm radius multiplier
  const H = 24; // mm vertical wave height
  const widthMm = 11; // ribbon width
  const thickMm = 4.5; // ribbon thickness

  // 1. Sample center curve points:
  const points: [number, number, number][] = [];
  const tangents: [number, number, number][] = [];

  for (let i = 0; i < N; i++) {
    const u = (i / N) * Math.PI * 2;
    // Harmonic Trefoil Knot parametric equations:
    const kx = R * (Math.sin(u) + 2 * Math.sin(2 * u));
    const ky = R * (Math.cos(u) - 2 * Math.cos(2 * u));
    const kz = -H * Math.sin(3 * u);

    // Stand it vertically upright (rotate 90 deg around X: X->X, Y->Z, Z->-Y):
    const x = kx;
    const y = kz;
    const z = -ky;
    points.push([x, y, z]);

    // Analytical derivative (tangent):
    const dkx = R * (Math.cos(u) + 4 * Math.cos(2 * u));
    const dky = R * (-Math.sin(u) - 4 * Math.sin(2 * u));
    const dkz = -3 * H * Math.cos(3 * u);

    const dx = dkx;
    const dy = dkz;
    const dz = -dky;
    const len = Math.hypot(dx, dy, dz);
    tangents.push([dx / len, dy / len, dz / len]);
  }

  // 2. Parallel Transport Frame (Bishop Frame) around the closed knot:
  // Initial normal:
  const t0 = tangents[0];
  let vInit = [0, 0, 1];
  if (Math.abs(t0[2]) > 0.9) vInit = [1, 0, 0];
  // Project vInit perpendicular to t0:
  const dot0 = vInit[0] * t0[0] + vInit[1] * t0[1] + vInit[2] * t0[2];
  let n0 = [vInit[0] - dot0 * t0[0], vInit[1] - dot0 * t0[1], vInit[2] - dot0 * t0[2]];
  const l0 = Math.hypot(...n0);
  n0 = [n0[0] / l0, n0[1] / l0, n0[2] / l0];

  const normals: [number, number, number][] = [n0 as [number, number, number]];

  for (let i = 0; i < N - 1; i++) {
    const T1 = tangents[i];
    const T2 = tangents[i + 1];
    const N1 = normals[i];

    // Axis of rotation between T1 and T2:
    const ax = T1[1] * T2[2] - T1[2] * T2[1];
    const ay = T1[2] * T2[0] - T1[0] * T2[2];
    const az = T1[0] * T2[1] - T1[1] * T2[0];
    const aLen = Math.hypot(ax, ay, az);
    const cosAngle = Math.max(-1, Math.min(1, T1[0] * T2[0] + T1[1] * T2[1] + T1[2] * T2[2]));

    let N2: [number, number, number];
    if (aLen < 1e-6) {
      N2 = [...N1];
    } else {
      // Rodrigues rotation formula:
      const kx = ax / aLen, ky = ay / aLen, kz = az / aLen;
      const sinA = aLen; // roughly sin(angle)
      const cosA = cosAngle;
      const kDotN = kx * N1[0] + ky * N1[1] + kz * N1[2];

      N2 = [
        N1[0] * cosA + (ky * N1[2] - kz * N1[1]) * sinA + kx * kDotN * (1 - cosA),
        N1[1] * cosA + (kz * N1[0] - kx * N1[2]) * sinA + ky * kDotN * (1 - cosA),
        N1[2] * cosA + (kx * N1[1] - ky * N1[0]) * sinA + kz * kDotN * (1 - cosA),
      ];
    }
    const nLen = Math.hypot(...N2);
    normals.push([N2[0] / nLen, N2[1] / nLen, N2[2] / nLen]);
  }

  // Calculate closure holonomy angle between normals[N-1] transported to 0:
  const lastN = normals[N - 1];
  const lastB = [
    tangents[N - 1][1] * lastN[2] - tangents[N - 1][2] * lastN[1],
    tangents[N - 1][2] * lastN[0] - tangents[N - 1][0] * lastN[2],
    tangents[N - 1][0] * lastN[1] - tangents[N - 1][1] * lastN[0],
  ];
  const endDotN = lastN[0] * normals[0][0] + lastN[1] * normals[0][1] + lastN[2] * normals[0][2];
  const endDotB = lastB[0] * normals[0][0] + lastB[1] * normals[0][1] + lastB[2] * normals[0][2];
  const totalHolonomy = Math.atan2(endDotB, endDotN);

  // Generate sections with smooth twist correction for seamless closure:
  const sectionVerts: number[][] = [];
  const hw = widthMm / 2;
  const ht = thickMm / 2;
  const corners = [[-hw, -ht], [hw, -ht], [hw, ht], [-hw, ht]];

  for (let i = 0; i < N; i++) {
    const [cx, cy, cz] = points[i];
    const T = tangents[i];
    const N_vec = normals[i];
    const B_vec = [
      T[1] * N_vec[2] - T[2] * N_vec[1],
      T[2] * N_vec[0] - T[0] * N_vec[2],
      T[0] * N_vec[1] - T[1] * N_vec[0],
    ];

    // Smooth twist distributing the holonomy so section 0 and section N-1 match seamlessly:
    const twist = -(i / N) * totalHolonomy;
    const cosT = Math.cos(twist);
    const sinT = Math.sin(twist);

    // Frame vectors for the ribbon profile:
    const ux = N_vec[0] * cosT + B_vec[0] * sinT;
    const uy = N_vec[1] * cosT + B_vec[1] * sinT;
    const uz = N_vec[2] * cosT + B_vec[2] * sinT;

    const vx = -N_vec[0] * sinT + B_vec[0] * cosT;
    const vy = -N_vec[1] * sinT + B_vec[1] * cosT;
    const vz = -N_vec[2] * sinT + B_vec[2] * cosT;

    const vIndices: number[] = [];
    for (const [du, dv] of corners) {
      const px = cx + ux * du + vx * dv;
      const py = cy + uy * du + vy * dv;
      const pz = cz + uz * du + vz * dv;
      vIndices.push(vertexAt(lattice, mm(px), mm(py), mm(pz)));
    }
    sectionVerts.push(vIndices);
  }

  // Connect sections with quads:
  for (let i = 0; i < N; i++) {
    const next = (i + 1) % N;
    const s0 = sectionVerts[i];
    const s1 = sectionVerts[next];

    addFace(lattice, [s0[0], s0[1], s1[1], s1[0]]);
    addFace(lattice, [s0[1], s0[2], s1[2], s1[1]]);
    addFace(lattice, [s0[2], s0[3], s1[3], s1[2]]);
    addFace(lattice, [s0[3], s0[0], s1[0], s1[3]]);
  }

  orientFaces(lattice);

  // Crease the longitudinal edges for crisp, defined ribbon rails:
  for (let i = 0; i < N; i++) {
    const next = (i + 1) % N;
    const s0 = sectionVerts[i];
    const s1 = sectionVerts[next];
    for (let c = 0; c < 4; c++) {
      setCrease(lattice, s0[c], s1[c], true);
    }
  }

  const geom = toSceneGeom(lattice, 2, 0);
  return { lattice, geom };
}

// Inner Gyroscopic Mobius Ring:
export function generateInnerRing(): { lattice: Lattice; geom: ReturnType<typeof toSceneGeom> } {
  const lattice = createLattice(DEFAULT_UNIT);

  const N = 48;
  const R = 23; // 23 mm radius
  const widthMm = 7;
  const thickMm = 3.5;

  const sectionVerts: number[][] = [];
  const corners = [
    [-widthMm / 2, -thickMm / 2],
    [widthMm / 2, -thickMm / 2],
    [widthMm / 2, thickMm / 2],
    [-widthMm / 2, thickMm / 2],
  ];

  for (let i = 0; i < N; i++) {
    const u = (i / N) * Math.PI * 2;
    // Circular loop tilted 45 degrees in XZ:
    const lx = R * Math.cos(u);
    const ly = R * Math.sin(u);
    const lz = 0;

    // Tilt 40 deg around Y:
    const tilt = 0.7;
    const cx = lx * Math.cos(tilt) - lz * Math.sin(tilt);
    const cy = ly;
    const cz = lx * Math.sin(tilt) + lz * Math.cos(tilt);

    // Tangent:
    const tlx = -R * Math.sin(u);
    const tly = R * Math.cos(u);
    const tlz = 0;
    const tx = tlx * Math.cos(tilt) - tlz * Math.sin(tilt);
    const ty = tly;
    const tz = tlx * Math.sin(tilt) + tlz * Math.cos(tilt);
    const tLen = Math.hypot(tx, ty, tz);
    const [Tnx, Tny, Tnz] = [tx / tLen, ty / tLen, tz / tLen];

    // Radial vector:
    const rx = cx / R;
    const ry = cy / R;
    const rz = cz / R;

    // Normal perpendicular to T:
    const dot = rx * Tnx + ry * Tny + rz * Tnz;
    const nx = rx - dot * Tnx;
    const ny = ry - dot * Tny;
    const nz = rz - dot * Tnz;
    const nLen = Math.hypot(nx, ny, nz);
    const [Nx, Ny, Nz] = [nx / nLen, ny / nLen, nz / nLen];

    // Binormal = T x N:
    const Bx = Tny * Nz - Tnz * Ny;
    const By = Tnz * Nx - Tnx * Nz;
    const Bz = Tnx * Ny - Tny * Nx;

    // 360 degree full twist:
    const twist = u * 2;
    const cosT = Math.cos(twist);
    const sinT = Math.sin(twist);

    const ux = Nx * cosT + Bx * sinT;
    const uy = Ny * cosT + By * sinT;
    const uz = Nz * cosT + Bz * sinT;

    const vx = -Nx * sinT + Bx * cosT;
    const vy = -Ny * sinT + By * cosT;
    const vz = -Nz * sinT + Bz * cosT;

    const vIndices: number[] = [];
    for (const [du, dv] of corners) {
      const px = cx + ux * du + vx * dv;
      const py = cy + uy * du + vy * dv;
      const pz = cz + uz * du + vz * dv;
      vIndices.push(vertexAt(lattice, mm(px), mm(py), mm(pz)));
    }
    sectionVerts.push(vIndices);
  }

  for (let i = 0; i < N; i++) {
    const next = (i + 1) % N;
    const s0 = sectionVerts[i];
    const s1 = sectionVerts[next];
    addFace(lattice, [s0[0], s0[1], s1[1], s1[0]]);
    addFace(lattice, [s0[1], s0[2], s1[2], s1[1]]);
    addFace(lattice, [s0[2], s0[3], s1[3], s1[2]]);
    addFace(lattice, [s0[3], s0[0], s1[0], s1[3]]);
  }

  orientFaces(lattice);

  for (let i = 0; i < N; i++) {
    const next = (i + 1) % N;
    const s0 = sectionVerts[i];
    const s1 = sectionVerts[next];
    for (let c = 0; c < 4; c++) {
      setCrease(lattice, s0[c], s1[c], true);
    }
  }

  const geom = toSceneGeom(lattice, 2, 0);
  return { lattice, geom };
}

// Generate base pedestal:
export function generatePedestal(): { lattice: Lattice; geom: ReturnType<typeof toSceneGeom> } {
  const lattice = createLattice(DEFAULT_UNIT);

  // Grand 12-sided stepped exhibition plinth:
  // Base tier: z from 0 to 10 mm, radius 72 mm
  // Top tier: z from 10 to 20 mm, radius 62 mm
  const R1 = 72;
  const R2 = 62;
  const sides = 12;

  const ringAt = (radius: number, z: number) => {
    const verts: number[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const x = radius * Math.cos(a);
      const y = radius * Math.sin(a);
      verts.push(vertexAt(lattice, mm(x), mm(y), mm(z)));
    }
    return verts;
  };

  const b0 = ringAt(R1, 0);
  const b1 = ringAt(R1, 10);
  const t0 = ringAt(R2, 10);
  const t1 = ringAt(R2, 20);

  // Bottom cap:
  addFace(lattice, [...b0].reverse());

  // Lower ring walls:
  for (let s = 0; s < sides; s++) {
    const sn = (s + 1) % sides;
    addFace(lattice, [b0[s], b1[s], b1[sn], b0[sn]]);
  }

  // Stepped shoulder:
  for (let s = 0; s < sides; s++) {
    const sn = (s + 1) % sides;
    addFace(lattice, [b1[s], t0[s], t0[sn], b1[sn]]);
  }

  // Upper ring walls:
  for (let s = 0; s < sides; s++) {
    const sn = (s + 1) % sides;
    addFace(lattice, [t0[s], t1[s], t1[sn], t0[sn]]);
  }

  // Top cap:
  addFace(lattice, t1);

  orientFaces(lattice);

  // Crease all horizontal rims and vertical facets for crisp architectural stonework:
  for (const r of [b0, b1, t0, t1]) {
    for (let s = 0; s < sides; s++) {
      setCrease(lattice, r[s], r[(s + 1) % sides], true);
    }
  }
  for (let s = 0; s < sides; s++) {
    setCrease(lattice, b0[s], b1[s], true);
    setCrease(lattice, t0[s], t1[s], true);
  }

  const geom = toSceneGeom(lattice, 1, 0);
  return { lattice, geom };
}

async function main() {
  console.log('Generating art pieces with Lattice...');
  const ribbon = generateTrefoilSculpture();
  const pedestal = generatePedestal();

  // 1. Mathematically exact grounding for pedestal:
  let minPedZ = Infinity, maxPedZ = -Infinity;
  for (let i = 2; i < pedestal.geom.renderVertices.length; i += 3) {
    minPedZ = Math.min(minPedZ, pedestal.geom.renderVertices[i]);
    maxPedZ = Math.max(maxPedZ, pedestal.geom.renderVertices[i]);
  }
  const pedestalZ = -minPedZ;
  const pedestalTopZ = pedestalZ + maxPedZ;

  // 2. Mathematically exact placement of outer sculpture resting 1mm atop plinth:
  let minSculptZ = Infinity, maxSculptZ = -Infinity;
  for (let i = 2; i < ribbon.geom.renderVertices.length; i += 3) {
    minSculptZ = Math.min(minSculptZ, ribbon.geom.renderVertices[i]);
    maxSculptZ = Math.max(maxSculptZ, ribbon.geom.renderVertices[i]);
  }
  const sculptZ = pedestalTopZ - minSculptZ + 0.001;

  console.log('Pedestal top in world Z:', pedestalTopZ);
  console.log('Sculpture bottom in world Z:', sculptZ + minSculptZ);
  console.log('Sculpture top in world Z:', sculptZ + maxSculptZ);

  const bodies = [
    {
      id: 'pedestal_plinth',
      name: 'Basalt Exhibition Plinth',
      type: 'body',
      pos: [0, 0, pedestalZ],
      joints: [],
      isLattice: true,
      latticeCage: serializeCage(pedestal.lattice),
      latticeSubdiv: 1,
      latticeOrigin: pedestal.geom.origin,
      geoms: [
        {
          name: 'pedestal_mesh',
          type: 'mesh',
          size: [1],
          rgba: [0.15, 0.17, 0.20, 1.0], // deep dark obsidian / basalt
          mass: 15,
          condim: 3,
          dynamic: false,
          latticeGeom: true,
          vertices: pedestal.geom.vertices,
          renderVertices: pedestal.geom.renderVertices,
          faces: pedestal.geom.faces,
        },
      ],
    },
    {
      id: 'trefoil_sculpture',
      name: 'Astraea: The Celestial Knot',
      type: 'body',
      pos: [0, 0, sculptZ],
      joints: [],
      isLattice: true,
      latticeCage: serializeCage(ribbon.lattice),
      latticeSubdiv: 2,
      latticeOrigin: ribbon.geom.origin,
      geoms: [
        {
          name: 'trefoil_mesh',
          type: 'mesh',
          size: [1],
          rgba: [0.96, 0.78, 0.24, 1.0], // gleaming 24k polished gold
          mass: 3,
          condim: 3,
          dynamic: false,
          latticeGeom: true,
          vertices: ribbon.geom.vertices,
          renderVertices: ribbon.geom.renderVertices,
          faces: ribbon.geom.faces,
        },
      ],
    },
    {
      id: 'celestial_core',
      name: 'Oculus: Core of Light',
      type: 'body',
      pos: [0, 0, sculptZ + 0.015], // nested at the focal heart
      joints: [],
      geoms: [
        {
          name: 'orb_sphere',
          type: 'sphere',
          size: [0.012], // 12mm radius glowing sphere
          rgba: [0.18, 0.90, 0.98, 0.95], // radiant luminous cyan crystal
          mass: 0.5,
          condim: 3,
          dynamic: false,
        },
      ],
    },
  ];

  console.log('Sending BUILD_SCENE to Mesh over WebSocket relay...');
  const ws = new WebSocket('ws://localhost:3142');

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.send(JSON.stringify({ event: 'HELLO_PEER', peer_id: 'art_builder' }));

  const call = (cmd: string, payload: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = Math.random().toString(36).substring(2, 10);
      const timer = setTimeout(() => {
        reject(new Error(`Call ${cmd} (${id}) timed out after 30s`));
      }, 30000);
      const handler = (raw: WebSocket.Data) => {
        const str = raw.toString();
        try {
          const msg = JSON.parse(str);
          if (msg.id === id) {
            clearTimeout(timer);
            ws.off('message', handler);
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.data);
          }
        } catch (e) {
          console.error('Parse error:', e);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ event: 'FORWARD_CMD', id, port: 5175, cmd, payload }));
    });

  const res = await call('BUILD_SCENE', { bodies });
  console.log('BUILD_SCENE result:', res);

  // Position camera for an exquisite, tight beauty shot:
  await call('SET_CAMERA', {
    position: [0.10, -0.14, sculptZ + 0.035],
    target: [0, 0, sculptZ + 0.015],
  });
  console.log('Camera positioned.');

  // Take a screenshot:
  const shot = await call('SCREENSHOT', {});
  console.log('Screenshot captured. ok:', shot?.ok);
  if (shot?.dataUrl) {
    const b64 = shot.dataUrl.split(',')[1];
    const outPath = '/home/boab/.gemini/antigravity/brain/5001533d-ddd9-4919-a1cb-83bc34f05217/lattice_art.png';
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    console.log('Saved screenshot to:', outPath);
  }

  ws.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

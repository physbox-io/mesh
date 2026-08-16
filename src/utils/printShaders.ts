import * as THREE from 'three';

// -------------------------------------------------------------
// GPU-Accelerated Shaders for High-Poly 3D Print Meshes & Inspection
// -------------------------------------------------------------

export const PrintShaderUniforms = {
  uShadingMode: { value: 0 }, // 0: Standard PBR, 1: Studio Clay, 2: SLA Resin, 3: Bronze, 4: Overhang Heatmap
  uOverhangThreshold: { value: 45.0 }, // Degrees from vertical
  uEnableSlice: { value: false },
  uSliceZ: { value: 0.1 }, // meters
  uBaseColor: { value: new THREE.Color(0.85, 0.85, 0.88) },
  uRoughness: { value: 0.35 },
  uMetallic: { value: 0.1 }
};

export const PrintMeshVertexShader = `
  varying vec3 vNormalView;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const PrintMeshFragmentShader = `
  uniform int uShadingMode;
  uniform float uOverhangThreshold;
  uniform bool uEnableSlice;
  uniform float uSliceZ;
  uniform vec3 uBaseColor;
  uniform float uRoughness;
  uniform float uMetallic;

  varying vec3 vNormalView;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    // 1. Dynamic Hardware Z-Slicing Plane
    if (uEnableSlice && vWorldPos.z > uSliceZ) {
      discard;
    }

    vec3 nView = normalize(vNormalView);
    vec3 nWorld = normalize(vWorldNormal);

    // 2. Overhang Heatmap Mode (>45 deg support requirement)
    if (uShadingMode == 4) {
      // In Z-up coordinate system, downward vector is (0, 0, -1)
      float downDot = -nWorld.z; 
      float radThreshold = radians(uOverhangThreshold);
      float thresholdSin = sin(radThreshold);

      vec3 color;
      if (nWorld.z >= 0.0) {
        // Safe upward facing surface (slate grey-blue)
        color = vec3(0.32, 0.42, 0.52);
      } else {
        if (downDot > thresholdSin) {
          // Critical Overhang: Exceeds printable threshold (Warning Red / Crimson)
          float severity = clamp((downDot - thresholdSin) / (1.0 - thresholdSin + 0.01), 0.0, 1.0);
          color = mix(vec3(1.0, 0.15, 0.1), vec3(0.85, 0.0, 0.25), severity);
        } else {
          // Moderate overhang (Green to Yellow)
          float safeRatio = clamp(downDot / max(thresholdSin, 0.01), 0.0, 1.0);
          color = mix(vec3(0.2, 0.75, 0.3), vec3(0.9, 0.8, 0.2), safeRatio);
        }
      }

      // Add directional contour lighting
      vec3 lightDir = normalize(vec3(0.5, 0.5, 1.0));
      float diff = max(dot(nWorld, lightDir), 0.0) * 0.4 + 0.6;
      gl_FragColor = vec4(color * diff, 1.0);
      return;
    }

    // 3. Studio Sculptor's Clay MatCap
    if (uShadingMode == 1) {
      vec3 clayDark = vec3(0.32, 0.18, 0.14);
      vec3 clayMid  = vec3(0.78, 0.48, 0.38);
      vec3 clayHigh = vec3(0.96, 0.85, 0.78);
      
      float t = nView.z * 0.5 + 0.5;
      float spec = pow(max(dot(nView, normalize(vec3(0.5, 0.5, 0.8))), 0.0), 16.0);
      float rim = pow(1.0 - max(nView.z, 0.0), 2.5) * 0.15;
      vec3 color = mix(clayDark, clayMid, t) + clayHigh * spec + rim;
      gl_FragColor = vec4(color, 1.0);
      return;
    }

    // 4. SLA Tough Grey Resin MatCap
    if (uShadingMode == 2) {
      vec3 resinDark = vec3(0.15, 0.16, 0.18);
      vec3 resinMid  = vec3(0.55, 0.58, 0.62);
      vec3 resinHigh = vec3(0.92, 0.94, 0.98);

      float t = nView.z * 0.5 + 0.5;
      float spec1 = pow(max(dot(nView, normalize(vec3(0.3, 0.6, 0.7))), 0.0), 32.0);
      float spec2 = pow(max(dot(nView, normalize(vec3(-0.5, -0.2, 0.8))), 0.0), 12.0) * 0.3;
      vec3 color = mix(resinDark, resinMid, t) + resinHigh * (spec1 + spec2);
      gl_FragColor = vec4(color, 1.0);
      return;
    }

    // 5. Polished Cast Bronze MatCap
    if (uShadingMode == 3) {
      vec3 bronzeDark = vec3(0.18, 0.09, 0.04);
      vec3 bronzeMid  = vec3(0.82, 0.52, 0.22);
      vec3 bronzeHigh = vec3(1.0, 0.92, 0.75);

      float t = nView.z * 0.5 + 0.5;
      float spec = pow(max(dot(nView, normalize(vec3(0.4, 0.4, 0.9))), 0.0), 48.0);
      vec3 color = mix(bronzeDark, bronzeMid, t) + bronzeHigh * spec * 1.5;
      gl_FragColor = vec4(color, 1.0);
      return;
    }

    // 6. Standard Lit / Diffuse
    vec3 lightDir = normalize(vec3(0.4, 0.6, 0.8));
    float diff = max(dot(nWorld, lightDir), 0.0);
    vec3 ambient = 0.2 * uBaseColor;
    vec3 diffuse = diff * uBaseColor;
    gl_FragColor = vec4(ambient + diffuse, 1.0);
  }
`;

export function createPrintInspectionMaterial(options: {
  shadingMode?: number;
  overhangThreshold?: number;
  enableSlice?: boolean;
  sliceZ?: number;
  baseColor?: string | THREE.Color;
} = {}): THREE.ShaderMaterial {
  const color = options.baseColor instanceof THREE.Color ? options.baseColor : new THREE.Color(options.baseColor || '#d4d4d8');

  return new THREE.ShaderMaterial({
    vertexShader: PrintMeshVertexShader,
    fragmentShader: PrintMeshFragmentShader,
    uniforms: {
      uShadingMode: { value: options.shadingMode ?? 0 },
      uOverhangThreshold: { value: options.overhangThreshold ?? 45.0 },
      uEnableSlice: { value: options.enableSlice ?? false },
      uSliceZ: { value: options.sliceZ ?? 0.1 },
      uBaseColor: { value: color },
      uRoughness: { value: 0.35 },
      uMetallic: { value: 0.1 }
    },
    side: THREE.DoubleSide
  });
}

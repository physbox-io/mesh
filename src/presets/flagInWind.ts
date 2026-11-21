import type { SceneGraph, SceneNode } from '../types/scene';
import type { ClothEdge, UV } from '../types/cloth';

/**
 * Coastal Flagpole Aeroacoustics Showcase (`flag_in_wind`):
 *
 * Pairs an ultralight 55 g/m² marine ripstop nylon `physbox.io` ensign (0.92 × 0.56 m,
 * bright ~2.8 kHz trailing-edge whip-crackle & ~5.3 kHz weave rustle) above a
 * heavy 400 g/m² cotton duck canvas regatta burgee (0.46 × 0.26 m, warm ~500 Hz
 * thwack & ~2.2 kHz rustle) on a hollow Ø54 mm anodized aluminum mast with a
 * taut Ø6 mm stainless halyard stay and hinged brass halyard shackle.
 *
 * UV mapping note (`ClothLayer.tsx` + `clothPrintTexture.ts`):
 * For `tile: false, scale: 1` on `0.92 × 0.56 m`, `ClothLayer` normalizes both axes
 * isotropically by `span = max(0.92, 0.56) = 0.92` (`tu ∈ [0, 1]`, `tv ∈ [180/920, 740/920]`)
 * onto a square `CanvasTexture` (`flipY = true`). Using a square `920 × 920` `viewBox`
 * with the `920 × 560` flag artwork placed in `x ∈ [0, 920], y ∈ [180, 740]` (center `y = 460`)
 * yields an exact 1:1 unstretched aspect ratio, right-side up (`y = 180` at `+Z` top) and
 * hoist-to-fly left-to-right readable from the default camera (`[1.45, -3.15, 2.05]`).
 */

const PHYSBOX_ENSIGN_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="920" height="920" viewBox="0 0 920 920">',
  '<defs>',
  '<linearGradient id="pb-bg" x1="58" y1="180" x2="920" y2="740" gradientUnits="userSpaceOnUse">',
  '<stop offset="0" stop-color="#ffffff"/>',
  '<stop offset="0.55" stop-color="#f8f9fb"/>',
  '<stop offset="1" stop-color="#eef3f9"/>',
  '</linearGradient>',
  '<radialGradient id="pb-glow-l" cx="210" cy="460" r="290" gradientUnits="userSpaceOnUse">',
  '<stop offset="0" stop-color="#89184f" stop-opacity="0.085"/>',
  '<stop offset="1" stop-color="#89184f" stop-opacity="0"/>',
  '</radialGradient>',
  '<radialGradient id="pb-glow-r" cx="760" cy="460" r="320" gradientUnits="userSpaceOnUse">',
  '<stop offset="0" stop-color="#0284c7" stop-opacity="0.085"/>',
  '<stop offset="1" stop-color="#26dfc3" stop-opacity="0"/>',
  '</radialGradient>',
  '<linearGradient id="pb-trim" x1="58" y1="0" x2="920" y2="0" gradientUnits="userSpaceOnUse">',
  '<stop offset="0" stop-color="#620f43"/>',
  '<stop offset="0.48" stop-color="#4f46e5"/>',
  '<stop offset="1" stop-color="#26dfc3"/>',
  '</linearGradient>',
  '<pattern id="pb-grid" width="56" height="56" patternUnits="userSpaceOnUse">',
  '<path d="M 56 0 L 0 0 0 56" fill="none" stroke="#0f172a" stroke-opacity="0.05" stroke-width="1.2"/>',
  '<path d="M 28 0 L 28 56 M 0 28 L 56 28" fill="none" stroke="#0f172a" stroke-opacity="0.025" stroke-width="0.8"/>',
  '</pattern>',
  // Canonical physbox.io isometric phi-cube vector mark (`physbox_static/assets/physbox_logo2.svg`)
  '<clipPath id="pb-sil"><path clip-rule="evenodd" d="M 118.00 54.27 L 118.00 23.35 L 34.08 72.25 L 34.07 192.75 L 141.00 255.19 L 154.03 247.50 L 154.03 193.00 A 61.712 61.712 0 0 0 195.84 103.75 L 220.75 89.69 L 221.00 89.56 L 221.12 89.75 L 221.12 177.25 L 221.00 177.54 L 164.01 210.75 L 164.01 241.50 L 164.25 241.65 L 247.95 192.75 L 247.94 72.25 L 141.00 9.86 L 127.99 17.50 L 127.99 72.00 A 61.712 61.712 0 0 0 88.25 100.51 L 63.33 86.50 L 63.18 86.25 L 118.00 54.27 Z M 61.38 89.75 L 86.25 103.88 A 61.712 61.712 0 0 0 127.99 193.00 L 127.99 216.00 L 127.75 216.42 L 60.97 177.50 L 60.90 89.75 L 61.00 89.56 L 61.38 89.75 Z M 154.48 48.75 L 218.84 86.25 L 218.69 86.50 L 193.75 100.48 A 61.712 61.712 0 0 0 154.03 72.00 L 154.03 49.00 L 154.25 48.61 L 154.48 48.75 Z M 172.75 116.78 A 35.696 35.696 0 0 1 154.25 165.67 L 154.03 165.25 L 154.03 127.50 L 154.21 127.25 L 172.75 116.78 Z M 108.75 117.24 L 109.00 116.73 L 109.25 116.77 L 127.81 127.25 L 127.99 127.50 L 127.99 165.25 L 127.98 165.50 A 35.696 35.696 0 0 1 108.75 117.24 Z M 127.25 99.59 L 127.75 99.38 L 127.98 99.50 L 127.99 99.75 L 127.99 122.50 L 127.98 122.75 L 127.75 122.86 L 110.97 113.25 A 35.696 35.696 0 0 1 127.25 99.59 Z M 154.56 99.50 A 35.696 35.696 0 0 1 171.06 113.25 L 154.25 122.87 L 154.03 122.50 L 154.03 99.75 L 154.25 99.37 L 154.56 99.50 Z"/></clipPath>',
  '<clipPath id="pb-f-top"><path d="M 141.011 9.854 L 247.947 72.161 L 141.011 132.523 L 34.075 72.161 Z"/></clipPath>',
  '<clipPath id="pb-f-left"><path d="M 34.075 72.161 L 141.011 132.523 L 141.011 255.192 L 34.075 192.885 Z"/></clipPath>',
  '<clipPath id="pb-f-right"><path d="M 141.011 132.523 L 247.947 72.161 L 247.947 192.885 L 141.011 255.192 Z"/></clipPath>',
  '<linearGradient id="pb-g-hex-left" gradientUnits="userSpaceOnUse" x1="-79.957" y1="85.394" x2="-3.020" y2="3.226"><stop offset="0.0000" stop-color="#4e0639"/><stop offset="0.1250" stop-color="#51083a"/><stop offset="0.2500" stop-color="#550b3c"/><stop offset="0.3750" stop-color="#5a0d40"/><stop offset="0.5000" stop-color="#620f43"/><stop offset="0.6250" stop-color="#6c1246"/><stop offset="0.7500" stop-color="#751449"/><stop offset="0.8750" stop-color="#7f164c"/><stop offset="1.0000" stop-color="#89184f"/></linearGradient>',
  '<linearGradient id="pb-g-hex-right" gradientUnits="userSpaceOnUse" x1="-17.086" y1="13.615" x2="116.047" y2="-92.470"><stop offset="0.0000" stop-color="#912e77"/><stop offset="0.1250" stop-color="#824682"/><stop offset="0.2500" stop-color="#745d8d"/><stop offset="0.3750" stop-color="#667497"/><stop offset="0.5000" stop-color="#598aa1"/><stop offset="0.6250" stop-color="#4da0ab"/><stop offset="0.7500" stop-color="#3fb7b5"/><stop offset="0.8750" stop-color="#32cbbc"/><stop offset="1.0000" stop-color="#26dfc3"/></linearGradient>',
  '<linearGradient id="pb-g-hex-top" gradientUnits="userSpaceOnUse" x1="-10.055" y1="6.992" x2="132.636" y2="-92.236"><stop offset="0.0000" stop-color="#ad0963"/><stop offset="0.1250" stop-color="#a8146a"/><stop offset="0.2500" stop-color="#a12472"/><stop offset="0.3750" stop-color="#93397e"/><stop offset="0.5000" stop-color="#81518a"/><stop offset="0.6250" stop-color="#6f6a94"/><stop offset="0.7500" stop-color="#5e819c"/><stop offset="0.8750" stop-color="#5295a4"/><stop offset="1.0000" stop-color="#46a8ac"/></linearGradient>',
  '<linearGradient id="pb-g-ring-left" gradientUnits="userSpaceOnUse" x1="-40.971" y1="42.621" x2="-5.096" y2="5.301"><stop offset="0.0000" stop-color="#640d41"/><stop offset="0.1250" stop-color="#670e42"/><stop offset="0.2500" stop-color="#6b0f44"/><stop offset="0.3750" stop-color="#6e1045"/><stop offset="0.5000" stop-color="#721147"/><stop offset="0.6250" stop-color="#751248"/><stop offset="0.7500" stop-color="#78134a"/><stop offset="0.8750" stop-color="#7b144c"/><stop offset="1.0000" stop-color="#7e144d"/></linearGradient>',
  '<linearGradient id="pb-g-ring-right" gradientUnits="userSpaceOnUse" x1="-20.652" y1="21.105" x2="43.903" y2="-44.866"><stop offset="0.0000" stop-color="#7c4f8a"/><stop offset="0.1250" stop-color="#745d90"/><stop offset="0.2500" stop-color="#6d6a95"/><stop offset="0.3750" stop-color="#66789b"/><stop offset="0.5000" stop-color="#5e85a1"/><stop offset="0.6250" stop-color="#5593a6"/><stop offset="0.7500" stop-color="#4d9fab"/><stop offset="0.8750" stop-color="#45abb0"/><stop offset="1.0000" stop-color="#3db7b4"/></linearGradient>',
  '<linearGradient id="pb-g-ring-top" gradientUnits="userSpaceOnUse" x1="18.114" y1="-11.212" x2="94.923" y2="-58.756"><stop offset="0.0000" stop-color="#ac146b"/><stop offset="0.1250" stop-color="#a51f71"/><stop offset="0.2500" stop-color="#9f2a77"/><stop offset="0.3750" stop-color="#98347d"/><stop offset="0.5000" stop-color="#903f82"/><stop offset="0.6250" stop-color="#874b88"/><stop offset="0.7500" stop-color="#7e578e"/><stop offset="0.8750" stop-color="#756493"/><stop offset="1.0000" stop-color="#6d7098"/></linearGradient>',
  '<linearGradient id="pb-g-stem-left" gradientUnits="userSpaceOnUse" x1="-74.550" y1="110.456" x2="-17.469" y2="25.882"><stop offset="0.0000" stop-color="#530a3a"/><stop offset="0.1250" stop-color="#5a0c3d"/><stop offset="0.2500" stop-color="#600d3f"/><stop offset="0.3750" stop-color="#660f41"/><stop offset="0.5000" stop-color="#6c1043"/><stop offset="0.6250" stop-color="#711146"/><stop offset="0.7500" stop-color="#761248"/><stop offset="0.8750" stop-color="#7b134b"/><stop offset="1.0000" stop-color="#81144d"/></linearGradient>',
  '<linearGradient id="pb-g-stem-right" gradientUnits="userSpaceOnUse" x1="-68.193" y1="83.742" x2="-0.246" y2="0.302"><stop offset="0.0000" stop-color="#9f1867"/><stop offset="0.1250" stop-color="#96256f"/><stop offset="0.2500" stop-color="#8c3376"/><stop offset="0.3750" stop-color="#83407e"/><stop offset="0.5000" stop-color="#7c4e86"/><stop offset="0.6250" stop-color="#745c8e"/><stop offset="0.7500" stop-color="#6d6a94"/><stop offset="0.8750" stop-color="#65799b"/><stop offset="1.0000" stop-color="#5d88a1"/></linearGradient>',
  '<linearGradient id="pb-g-stem-top" gradientUnits="userSpaceOnUse" x1="26.537" y1="-18.872" x2="93.675" y2="-66.620"><stop offset="0.0000" stop-color="#a42676"/><stop offset="0.1250" stop-color="#9c307b"/><stop offset="0.2500" stop-color="#943a80"/><stop offset="0.3750" stop-color="#8b4586"/><stop offset="0.5000" stop-color="#81528b"/><stop offset="0.6250" stop-color="#785e90"/><stop offset="0.7500" stop-color="#706a95"/><stop offset="0.8750" stop-color="#67769a"/><stop offset="1.0000" stop-color="#5e819e"/></linearGradient>',
  '<linearGradient id="pb-g-c-ul" gradientUnits="userSpaceOnUse" x1="141.011" y1="132.523" x2="34.075" y2="72.161"><stop offset="0.0000" stop-color="#6eadbc"/><stop offset="0.0833" stop-color="#6d87a9"/><stop offset="0.1667" stop-color="#6d87a9"/><stop offset="0.2500" stop-color="#9779a4"/><stop offset="0.3333" stop-color="#9773a4"/><stop offset="0.4167" stop-color="#9e639c"/><stop offset="0.5000" stop-color="#a15699"/><stop offset="0.5833" stop-color="#9e5294"/><stop offset="0.6667" stop-color="#ba2075"/><stop offset="0.7500" stop-color="#bc1e74"/><stop offset="0.8333" stop-color="#b31e70"/><stop offset="0.9167" stop-color="#b61d6f"/><stop offset="1.0000" stop-color="#b01c6c"/></linearGradient>',
  '<linearGradient id="pb-g-c-ur" gradientUnits="userSpaceOnUse" x1="141.011" y1="132.523" x2="247.947" y2="72.161"><stop offset="0.0000" stop-color="#6aadbb"/><stop offset="0.0833" stop-color="#6996af"/><stop offset="0.1667" stop-color="#6896af"/><stop offset="0.2500" stop-color="#50c3bd"/><stop offset="0.3333" stop-color="#50c3bd"/><stop offset="0.4167" stop-color="#4ec6be"/><stop offset="0.5000" stop-color="#4bcdc0"/><stop offset="0.5833" stop-color="#50c2bc"/><stop offset="0.6667" stop-color="#3cd0c0"/><stop offset="0.7500" stop-color="#3acebf"/><stop offset="0.8333" stop-color="#35d0bd"/><stop offset="0.9167" stop-color="#35d0bc"/><stop offset="1.0000" stop-color="#36d4be"/></linearGradient>',
  '<linearGradient id="pb-g-c-b" gradientUnits="userSpaceOnUse" x1="141.011" y1="132.523" x2="141.011" y2="255.192"><stop offset="0.0000" stop-color="#4ccac4"/><stop offset="0.0833" stop-color="#4cc0bf"/><stop offset="0.1667" stop-color="#55b0b7"/><stop offset="0.2500" stop-color="#6296ae"/><stop offset="0.3333" stop-color="#7085a6"/><stop offset="0.4167" stop-color="#7d749c"/><stop offset="0.5000" stop-color="#865b95"/><stop offset="0.5833" stop-color="#964e8f"/><stop offset="0.6667" stop-color="#a13c84"/><stop offset="0.7500" stop-color="#b4267a"/><stop offset="0.8333" stop-color="#c21670"/><stop offset="0.9167" stop-color="#bc1269"/><stop offset="1.0000" stop-color="#cd106e"/></linearGradient>',
  '</defs>',
  // Editorial physbox.io backdrop + drafting grid across active 920×560 flag band (y ∈ [180, 740])
  '<rect width="920" height="920" fill="url(#pb-bg)"/>',
  '<rect x="58" y="180" width="862" height="560" fill="url(#pb-glow-l)"/>',
  '<rect x="58" y="180" width="862" height="560" fill="url(#pb-glow-r)"/>',
  '<rect x="58" y="180" width="862" height="560" fill="url(#pb-grid)"/>',
  // Upper & lower fly hem brand accent bars
  '<rect x="58" y="180" width="862" height="12" fill="url(#pb-trim)"/>',
  '<rect x="58" y="728" width="862" height="12" fill="url(#pb-trim)"/>',
  // Reinforced hoist canvas header strip on mast edge (x = 0..58)
  '<rect x="0" y="0" width="58" height="920" fill="#e9eef5"/>',
  '<line x1="49" y1="0" x2="49" y2="920" stroke="#cbd5e1" stroke-width="2" stroke-dasharray="10,7"/>',
  '<line x1="58" y1="0" x2="58" y2="920" stroke="#cbd5e1" stroke-width="3"/>',
  // Canonical PhysBox isometric phi-cube mark centered vertically on y = 460 (340 + 0.905 * 132.523 = 459.93)
  '<g transform="translate(94, 340) scale(0.905)">',
  '<g clip-path="url(#pb-sil)">',
  '<g clip-path="url(#pb-f-top)">',
  '<rect x="0" y="0" width="283" height="263" fill="url(#pb-g-hex-top)"/>',
  '<path d="M 79.299 132.523 A 61.712 61.712 0 1 1 202.723 132.523 A 61.712 61.712 0 1 1 79.299 132.523 Z M 105.315 132.523 A 35.696 35.696 0 1 0 176.707 132.523 A 35.696 35.696 0 1 0 105.315 132.523 Z" fill-rule="evenodd" fill="url(#pb-g-ring-top)"/>',
  '<rect x="127.990" y="0" width="26.042" height="263" fill="url(#pb-g-stem-top)"/>',
  '</g>',
  '<g clip-path="url(#pb-f-left)">',
  '<rect x="0" y="0" width="283" height="263" fill="url(#pb-g-hex-left)"/>',
  '<path d="M 79.299 132.523 A 61.712 61.712 0 1 1 202.723 132.523 A 61.712 61.712 0 1 1 79.299 132.523 Z M 105.315 132.523 A 35.696 35.696 0 1 0 176.707 132.523 A 35.696 35.696 0 1 0 105.315 132.523 Z" fill-rule="evenodd" fill="url(#pb-g-ring-left)"/>',
  '<rect x="127.990" y="0" width="26.042" height="263" fill="url(#pb-g-stem-left)"/>',
  '</g>',
  '<g clip-path="url(#pb-f-right)">',
  '<rect x="0" y="0" width="283" height="263" fill="url(#pb-g-hex-right)"/>',
  '<path d="M 79.299 132.523 A 61.712 61.712 0 1 1 202.723 132.523 A 61.712 61.712 0 1 1 79.299 132.523 Z M 105.315 132.523 A 35.696 35.696 0 1 0 176.707 132.523 A 35.696 35.696 0 1 0 105.315 132.523 Z" fill-rule="evenodd" fill="url(#pb-g-ring-right)"/>',
  '<rect x="127.990" y="0" width="26.042" height="263" fill="url(#pb-g-stem-right)"/>',
  '</g>',
  '<path d="M 141.011 132.523 L 34.075 72.161" stroke="url(#pb-g-c-ul)" stroke-width="2.80" fill="none"/>',
  '<path d="M 141.011 132.523 L 247.947 72.161" stroke="url(#pb-g-c-ur)" stroke-width="2.80" fill="none"/>',
  '<path d="M 141.011 132.523 L 141.011 255.192" stroke="url(#pb-g-c-b)" stroke-width="2.40" fill="none"/>',
  '<path d="M 118.00 54.27 L 118.00 23.35 L 34.08 72.25 L 34.07 192.75 L 141.00 255.19 L 154.03 247.50 L 154.03 193.00 A 61.712 61.712 0 0 0 195.84 103.75 L 220.75 89.69 L 221.00 89.56 L 221.12 89.75 L 221.12 177.25 L 221.00 177.54 L 164.01 210.75 L 164.01 241.50 L 164.25 241.65 L 247.95 192.75 L 247.94 72.25 L 141.00 9.86 L 127.99 17.50 L 127.99 72.00 A 61.712 61.712 0 0 0 88.25 100.51 L 63.33 86.50 L 63.18 86.25 L 118.00 54.27 Z" fill="none" stroke="#000000" stroke-width="2.00" stroke-opacity="0.3535"/>',
  '<path d="M 61.38 89.75 L 86.25 103.88 A 61.712 61.712 0 0 0 127.99 193.00 L 127.99 216.00 L 127.75 216.42 L 60.97 177.50 L 60.90 89.75 L 61.00 89.56 L 61.38 89.75 Z M 154.48 48.75 L 218.84 86.25 L 218.69 86.50 L 193.75 100.48 A 61.712 61.712 0 0 0 154.03 72.00 L 154.03 49.00 L 154.25 48.61 L 154.48 48.75 Z M 172.75 116.78 A 35.696 35.696 0 0 1 154.25 165.67 L 154.03 165.25 L 154.03 127.50 L 154.21 127.25 L 172.75 116.78 Z M 108.75 117.24 L 109.00 116.73 L 109.25 116.77 L 127.81 127.25 L 127.99 127.50 L 127.99 165.25 L 127.98 165.50 A 35.696 35.696 0 0 1 108.75 117.24 Z M 127.25 99.59 L 127.75 99.38 L 127.98 99.50 L 127.99 99.75 L 127.99 122.50 L 127.98 122.75 L 127.75 122.86 L 110.97 113.25 A 35.696 35.696 0 0 1 127.25 99.59 Z M 154.56 99.50 A 35.696 35.696 0 0 1 171.06 113.25 L 154.25 122.87 L 154.03 122.50 L 154.03 99.75 L 154.25 99.37 L 154.56 99.50 Z" fill="none" stroke="#000000" stroke-width="2.00" stroke-opacity="0.2424"/>',
  '</g>',
  '</g>',
  // physbox.io wordmark (`--text-primary: #0f172a`, `--primary: #4f46e5` dot)
  '<text x="364" y="490" font-family="Outfit,Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="90" font-weight="800" letter-spacing="-2" fill="#0f172a">physbox<tspan fill="#4f46e5">.</tspan>io</text>',
  '</svg>',
].join('');

const REGATTA_BURGEE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100">',
  '<rect width="100" height="100" fill="#f5efe2"/>',
  '<polygon points="0,0 100,50 0,100 0,80 68,50 0,20" fill="#17355e"/>',
  '<polygon points="28,39 44,50 28,61 16,50" fill="#c82829"/>',
  '<rect x="0" y="0" width="8" height="100" fill="#e7decb"/>',
  '</svg>',
].join('');

function rectFlagEdges(w: number, h: number): ClothEdge[] {
  const hw = w / 2;
  const hh = h / 2;
  const c: UV[] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  const ids = ['bottom', 'fly', 'top', 'hoist'];
  return ids.map((id, i) => ({ id, pts: [c[i], c[(i + 1) % 4]] }));
}

function taperedBurgeeEdges(w: number, hoistH: number, tipH: number): ClothEdge[] {
  const hw = w / 2;
  const h0 = hoistH / 2;
  const h1 = tipH / 2;
  return [
    { id: 'bottom', pts: [[-hw, -h0], [hw, -h1]] },
    { id: 'fly', pts: [[hw, -h1], [hw, h1]] },
    { id: 'top', pts: [[hw, h1], [-hw, h0]] },
    { id: 'hoist', pts: [[-hw, h0], [-hw, -h0]] },
  ];
}

function buildFlagInWindScene(): SceneGraph {
  const plinth: SceneNode = {
    id: 'flagpole_plinth',
    name: 'flagpole_plinth',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'stone',
    joints: [],
    geoms: [
      {
        name: 'plinth_granite_base',
        type: 'box',
        size: [0.19, 0.19, 0.045],
        pos: [0, 0, 0.045],
        rgba: [0.42, 0.44, 0.48, 1],
      },
      {
        name: 'plinth_granite_tier',
        type: 'box',
        size: [0.135, 0.135, 0.03],
        pos: [0, 0, 0.12],
        rgba: [0.49, 0.51, 0.55, 1],
      },
      {
        name: 'plinth_bronze_collar',
        type: 'cylinder',
        size: [0.062, 0.015],
        pos: [0, 0, 0.165],
        rgba: [0.64, 0.49, 0.24, 1],
      },
    ],
    children: [],
  };

  // At 0.56 m hoist height and 0.04 m spacing, `resample` divides `hoist` into 14 equal segments;
  // `at: 0.5` selects the exact midpoint vertex 7/14 at local v = 0 (world z = ensignCenterZ).
  const ensignCenterZ = 2.20;
  const ensignTopZ = ensignCenterZ + 0.28;
  const ensignMidZ = ensignCenterZ;
  const ensignBotZ = ensignCenterZ - 0.28;

  const burgeeCenterZ = 1.41;
  const burgeeTopZ = burgeeCenterZ + 0.13;
  const burgeeBotZ = burgeeCenterZ - 0.13;

  const flagpole: SceneNode = {
    id: 'flagpole',
    name: 'flagpole',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'softMetal',
    joints: [],
    geoms: [
      // Main Ø54 mm hollow anodized aluminum mast (z = 0.18..2.55 m, L/D = 43.9)
      {
        name: 'mast_main',
        type: 'cylinder',
        size: [0.027, 1.185],
        pos: [0, 0, 1.365],
        rgba: [0.80, 0.83, 0.88, 1],
      },
      // Stepped Ø64 mm lower mast sleeve (z = 0.18..0.62 m, L/D = 6.88)
      {
        name: 'mast_base_sleeve',
        type: 'cylinder',
        size: [0.032, 0.22],
        pos: [0, 0, 0.40],
        rgba: [0.71, 0.75, 0.80, 1],
      },
      // 3 mm wall internal hollow bore for 3D structural tube modes & cavity FIR
      {
        name: 'mast_hollow_bore',
        type: 'cylinder',
        size: [0.024, 1.16],
        pos: [0, 0, 1.365],
        csg: 'difference',
      },
      // Taut Ø6 mm stainless halyard stay (z = 0.70..2.54 m, L/D = 307 -> crisp coastal Strouhal hum)
      {
        name: 'halyard_stay',
        type: 'capsule',
        fromto: [0, -0.036, 0.70, 0, -0.034, 2.54],
        size: [0.003],
        rgba: [0.86, 0.88, 0.91, 1],
      },
      // Masthead brass truck, spun brass finial ball, horn cleat & halyard hardware
      {
        name: 'mast_truck',
        type: 'cylinder',
        size: [0.033, 0.012],
        pos: [0, 0, 2.562],
        rgba: [0.85, 0.68, 0.24, 1],
        role: 'visual',
      },
      {
        name: 'mast_finial_ball',
        type: 'sphere',
        size: [0.040],
        pos: [0, 0, 2.608],
        rgba: [0.94, 0.79, 0.30, 1],
        role: 'visual',
      },
      {
        name: 'halyard_belay_cleat',
        type: 'capsule',
        fromto: [-0.036, 0, 0.65, -0.036, 0, 0.76],
        size: [0.0045],
        rgba: [0.85, 0.68, 0.24, 1],
        role: 'visual',
      },
      {
        name: 'hoist_halyard_line',
        type: 'capsule',
        fromto: [0.032, 0, 0.72, 0.032, 0, 2.54],
        size: [0.0018],
        rgba: [0.92, 0.90, 0.84, 1],
        role: 'visual',
      },
      ...[ensignTopZ, ensignMidZ, ensignBotZ, burgeeTopZ, burgeeBotZ].map((z, idx) => ({
        name: `hoist_snap_hook_${idx + 1}`,
        type: 'sphere' as const,
        size: [0.0045],
        pos: [0.032, 0, z],
        rgba: [0.90, 0.74, 0.26, 1],
        role: 'visual' as const,
      })),
    ],
    children: [
      {
        id: 'halyard_shackle',
        name: 'halyard_shackle',
        type: 'body',
        pos: [-0.039, 0, 1.18],
        deformMaterial: 'steel',
        joints: [
          {
            name: 'halyard_shackle_hinge',
            type: 'hinge',
            axis: [0, 1, 0],
            pos: [0, 0, 0],
            stiffness: 0.0035,
            damping: 0.00025,
            limited: true,
            range: [-30, 22],
          },
        ],
        geoms: [
          {
            name: 'shackle_drop_lanyard',
            type: 'capsule',
            fromto: [0, 0, 0, 0, 0, -0.185],
            size: [0.002],
            mass: 0.002,
            rgba: [0.88, 0.89, 0.92, 1],
            contype: 0,
            conaffinity: 0,
          },
          // 7.5 mm clear of the Ø54 mm mast at t = 0 (ncon === 0), swings downwind to clink on the mast
          {
            name: 'shackle_brass_clew',
            type: 'box',
            size: [0.0045, 0.012, 0.017],
            pos: [0, 0, -0.20],
            density: 8500,
            solref: [0.004, 0.18],
            rgba: [0.92, 0.75, 0.26, 1],
          },
        ],
        children: [],
      },
    ],
  };

  // Upper main signal ensign: 0.92 m × 0.56 m ultralight 55 g/m² marine ripstop nylon (`physbox.io` flag)
  const ensignFlag: SceneNode = {
    id: 'ensign_flag',
    name: 'ensign_flag',
    type: 'body',
    pos: [0.036 + 0.46, 0, ensignCenterZ],
    geoms: [],
    joints: [],
    children: [],
    cloth: {
      material: 'ripstop',
      spacing: 0.04,
      sewTime: 0.05,
      pattern: { svg: PHYSBOX_ENSIGN_SVG, scale: 1, tile: false },
      pieces: [
        {
          name: 'ensign',
          rgba: [0.973, 0.976, 0.984, 1],
          edges: rectFlagEdges(0.92, 0.56),
          placement: { kind: 'plane', origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] },
          trims: [
            {
              kind: 'stud',
              along: 'hoist',
              spacing: 0.135,
              size: 0.014,
              offset: 0.012,
              rgba: [0.90, 0.74, 0.26, 1],
            },
          ],
        },
      ],
      ties: [
        { name: 'ensign_hoist_top', piece: 'ensign', edge: 'hoist', at: 0, to: 'flagpole', anchor: [0.035, 0, ensignTopZ] },
        { name: 'ensign_hoist_mid', piece: 'ensign', edge: 'hoist', at: 0.5, to: 'flagpole', anchor: [0.035, 0, ensignMidZ] },
        { name: 'ensign_hoist_bot', piece: 'ensign', edge: 'bottom', at: 0, to: 'flagpole', anchor: [0.035, 0, ensignBotZ] },
      ],
    },
  };

  // Lower regatta burgee pennant: 0.46 m × 0.26 m heavy 400 g/m² cotton duck canvas
  const burgeePennant: SceneNode = {
    id: 'burgee_pennant',
    name: 'burgee_pennant',
    type: 'body',
    pos: [0.036 + 0.23, 0, burgeeCenterZ],
    geoms: [],
    joints: [],
    children: [],
    cloth: {
      material: 'canvas',
      spacing: 0.044,
      sewTime: 0.05,
      pattern: { svg: REGATTA_BURGEE_SVG, scale: 1, tile: false },
      pieces: [
        {
          name: 'burgee',
          rgba: [0.96, 0.94, 0.89, 1],
          edges: taperedBurgeeEdges(0.46, 0.26, 0.08),
          placement: { kind: 'plane', origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] },
          trims: [
            {
              kind: 'stud',
              along: 'hoist',
              spacing: 0.11,
              size: 0.012,
              offset: 0.01,
              rgba: [0.88, 0.72, 0.26, 1],
            },
          ],
        },
      ],
      ties: [
        { name: 'burgee_hoist_top', piece: 'burgee', edge: 'hoist', at: 0, to: 'flagpole', anchor: [0.035, 0, burgeeTopZ] },
        { name: 'burgee_hoist_bot', piece: 'burgee', edge: 'bottom', at: 0, to: 'flagpole', anchor: [0.035, 0, burgeeBotZ] },
      ],
    },
  };

  return {
    nodes: [plinth, flagpole, ensignFlag, burgeePennant],
  };
}

let cachedNodes: SceneNode[] | undefined;

export const flagInWindPreset: SceneGraph = {
  get nodes() {
    cachedNodes ??= buildFlagInWindScene().nodes;
    return cachedNodes;
  },
  set nodes(v: SceneNode[]) {
    cachedNodes = v;
  },
} as SceneGraph;

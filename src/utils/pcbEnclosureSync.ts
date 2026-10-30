// ---------------------------------------------------------------------------
// Electro-Mechanical PCB + Enclosure + Front-Panel Co-Design Sync
//
// Bridges Volt's PCB layout / mechanical board specification with Mesh's 3D
// CSG enclosure modelling and Etch's 2D laser/CNC faceplate cutting workflow.
//
// Units convention:
//   - User-facing specifications (`PcbMechanicalSpec`, `PcbEnclosureOptions`,
//     2D SVG exports) are in millimetres (mm).
//   - `SceneNode` and `SceneGeom` positions/sizes are in metres (m), Z-up.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { HardwareBore, SceneGeom, SceneNode } from '../types/scene';
import { hardwareCutGeoms, CLEARANCE_HOLES, INSERTS } from './hardwareCuts';
import { boxGeom, cylinderGeom, ringGeom, mm, visual } from './hardwareGeometry';
import { buildEtchHandoffUrl, etchBaseUrl } from './etchHandoff';
import { voltBaseUrl } from './voltHandoff';
import { toBase64Url } from './shareLink';
import { CSG_DEFAULT_SECTORS, cutGeometry, sourcePositiveBounds } from './csg';

export type PcbBoardColor = 'green' | 'black' | 'blue' | 'red' | 'white';
export type PcbFastenerSize = 'M2' | 'M2.5' | 'M3' | 'M4';
export type PcbEnclosureFace = 'top' | 'front' | 'back' | 'left' | 'right';
export type PcbCutoutShape = 'circle' | 'rect' | 'rounded_rect' | 'd_shaft';

export type PcbComponentKind =
  | 'ic'
  | 'capacitor'
  | 'resistor'
  | 'inductor'
  | 'potentiometer'
  | 'toggle_switch'
  | 'pushbutton'
  | 'audio_jack_35mm'
  | 'audio_jack_635mm'
  | 'usb_c'
  | 'barrel_jack'
  | 'led_3mm'
  | 'led_5mm'
  | 'pin_header'
  | 'oled_display'
  | 'heatsink'
  | 'custom';

export interface PcbMountingHole {
  id: string;
  /** Board-centred X coordinate in mm, in [-widthMm/2..+widthMm/2]. */
  xMm: number;
  /** Board-centred Y coordinate in mm, in [-depthMm/2..+depthMm/2]. */
  yMm: number;
  drillMm: number;
  padDiameterMm?: number;
  fastener?: PcbFastenerSize;
}

export interface PcbPanelMountSpec {
  face: PcbEnclosureFace;
  cutoutShape: PcbCutoutShape;
  diameterMm?: number;
  widthMm?: number;
  heightMm?: number;
  cornerRadiusMm?: number;
  shaftFlatMm?: number;
  zOffsetMm?: number;
  clearanceMm?: number;
  /** Alias supporting uppercase C from external specs. */
  ClearanceMm?: number;
  showDialTicks?: boolean;
}

export interface PcbComponent3D {
  id: string;
  ref: string;
  label?: string;
  kind: PcbComponentKind;
  xMm: number;
  yMm: number;
  rotDeg?: number;
  side?: 'top' | 'bottom';
  widthMm: number;
  depthMm: number;
  heightMm: number;
  panelMount?: PcbPanelMountSpec;
}

export interface PcbMechanicalSpec {
  name: string;
  widthMm: number;
  depthMm: number;
  thicknessMm: number;
  cornerRadiusMm?: number;
  color?: PcbBoardColor;
  mountingHoles: PcbMountingHole[];
  components: PcbComponent3D[];
}

export interface PcbEnclosureOptions {
  /** Clearance around PCB X and Y edges to inner walls (mm). Default 2.0. */
  boardClearanceMm: number;
  /** Standoff boss height rising from floor to bottom of PCB (mm). Default 5.0. */
  standoffHeightMm: number;
  /** Enclosure wall, floor, and lid thickness (mm). Default 2.5. */
  wallThicknessMm: number;
  /** Clearance above tallest top-side component to inside of lid (mm). Default 3.0. */
  topClearanceMm: number;
  /** Whether to generate a separate removable top lid node. Default true. */
  includeLid: boolean;
  /** Fastener bore style in mounting bosses ('insert' | 'tapped' | 'clearance'). Default 'insert'. */
  boreType: HardwareBore;
  /** Corner screw size for lid attachment. Default 'M3'. */
  lidFastenerSize: PcbFastenerSize;
  /** Optional RGBA colour for base enclosure. */
  enclosureColor?: [number, number, number, number];
  /** Optional RGBA colour for lid. */
  lidColor?: [number, number, number, number];
  /** World-space position of the assembly in metres [x, y, z]. */
  pos?: [number, number, number];
}

export interface PanelCutoutSummary {
  componentId: string;
  ref: string;
  label?: string;
  face: PcbEnclosureFace;
  shape: PcbCutoutShape;
  /** 2D horizontal coordinate on the target face (mm, centred). */
  xMm: number;
  /** 2D vertical coordinate on the target face (mm, centred). */
  yMm: number;
  widthMm: number;
  heightMm: number;
  diameterMm?: number;
  targetBody: 'base' | 'lid';
  geomName: string;
}

export interface PcbClearanceIssue {
  severity: 'error' | 'warning';
  code: 'wall_collision' | 'lid_collision' | 'floor_collision' | 'boss_keepout' | 'hole_out_of_bounds';
  componentId?: string;
  holeId?: string;
  message: string;
  clearanceMm: number;
}

export interface PcbClearanceCheck {
  ok: boolean;
  minWallClearanceMm: number;
  minTopClearanceMm: number;
  minBottomClearanceMm: number;
  minBossClearanceMm: number;
  innerDimensionsMm: [number, number, number];
  outerDimensionsMm: [number, number, number];
  issues: PcbClearanceIssue[];
}

export interface FaceplateSvgOptions {
  /** The enclosure the panel belongs to; its size and screw holes follow it. */
  enclosure?: Partial<PcbEnclosureOptions>;
  /** Overrides the panel's plan size: board plus this all round. */
  marginMm?: number;
  includeLabels?: boolean;
  includeDialTicks?: boolean;
  includeBoardOutline?: boolean;
  thicknessMm?: number;
}

export interface FaceplateSvgResult {
  svg: string;
  widthMm: number;
  heightMm: number;
  cutoutCount: number;
  etchUrl?: string;
}

export const DEFAULT_PCB_ENCLOSURE_OPTIONS: PcbEnclosureOptions = {
  boardClearanceMm: 2.0,
  standoffHeightMm: 5.0,
  wallThicknessMm: 2.5,
  topClearanceMm: 3.0,
  includeLid: true,
  boreType: 'insert',
  lidFastenerSize: 'M3',
  enclosureColor: [0.22, 0.25, 0.30, 1],
  lidColor: [0.28, 0.32, 0.38, 1],
};

/** FR4 fibreglass laminate density in kg/m³. */
export const FR4_DENSITY = 1850;
/** Average electronic component package density in kg/m³. */
const COMPONENT_DENSITY = 1500;
/** Copper pad/annular ring RGBA. */
const COPPER_RGBA: [number, number, number, number] = [0.84, 0.62, 0.28, 1];

export const PCB_BOARD_COLORS: Record<PcbBoardColor, [number, number, number, number]> = {
  green: [0.07, 0.42, 0.22, 1],
  black: [0.12, 0.13, 0.15, 1],
  blue: [0.10, 0.32, 0.58, 1],
  red: [0.62, 0.14, 0.14, 1],
  white: [0.90, 0.91, 0.92, 1],
};

// ---------------------------------------------------------------------------
// Built-in PCB Mechanical Preset Catalogue
// ---------------------------------------------------------------------------

export const PCB_PRESETS: Record<string, PcbMechanicalSpec> = {
  arduino_uno: {
    name: 'Arduino Uno R3',
    // 2700 x 2100 mil. Holes from Arduino's drawing (UNO R3 datasheet A000066,
    // 5.4 Board Outline & Mounting Holes), in mil from the bottom-left corner
    // with the USB and power jacks on the left: (600, 2000), (2600, 1400),
    // (2600, 300), (550, 100); Ø3.2 mm. Centred here on the board.
    widthMm: 68.58,
    depthMm: 53.34,
    thicknessMm: 1.6,
    cornerRadiusMm: 1.5,
    color: 'blue',
    mountingHoles: [
      { id: 'mh_tl', xMm: -19.05, yMm: 24.13, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
      { id: 'mh_tr', xMm: 31.75, yMm: 8.89, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
      { id: 'mh_br', xMm: 31.75, yMm: -19.05, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
      { id: 'mh_bl', xMm: -20.32, yMm: -24.13, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
    ],
    components: [
      {
        id: 'usb_port',
        ref: 'J1',
        label: 'USB',
        kind: 'usb_c',
        xMm: -29.0,
        yMm: 9.5,
        widthMm: 10.5,
        depthMm: 9.0,
        heightMm: 3.5,
        panelMount: {
          face: 'left',
          cutoutShape: 'rounded_rect',
          widthMm: 9.5,
          heightMm: 3.8,
          cornerRadiusMm: 1.2,
          ClearanceMm: 0.4,
        },
      },
      {
        id: 'dc_barrel',
        ref: 'J2',
        label: '9V-12V DC',
        kind: 'barrel_jack',
        xMm: -28.0,
        yMm: -12.5,
        widthMm: 13.0,
        depthMm: 9.0,
        heightMm: 11.0,
        panelMount: {
          face: 'left',
          cutoutShape: 'circle',
          diameterMm: 9.5,
          ClearanceMm: 0.5,
        },
      },
      {
        id: 'mcu_atmega',
        ref: 'U1',
        label: 'ATMEGA328P',
        kind: 'ic',
        xMm: 6.0,
        yMm: -7.0,
        widthMm: 35.0,
        depthMm: 7.5,
        heightMm: 4.2,
      },
      {
        id: 'header_digital',
        ref: 'J3',
        label: 'DIGITAL',
        kind: 'pin_header',
        xMm: 7.5,
        yMm: 22.0,
        widthMm: 38.0,
        depthMm: 2.5,
        heightMm: 8.5,
      },
      {
        id: 'header_analog',
        ref: 'J4',
        label: 'ANALOG',
        kind: 'pin_header',
        xMm: 6.0,
        yMm: -22.0,
        widthMm: 36.0,
        depthMm: 2.5,
        heightMm: 8.5,
      },
      {
        id: 'reset_btn',
        ref: 'SW1',
        label: 'RESET',
        kind: 'pushbutton',
        xMm: -28.0,
        yMm: 21.0,
        widthMm: 6.0,
        depthMm: 6.0,
        heightMm: 5.0,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 4.5,
          ClearanceMm: 0.3,
        },
      },
      {
        id: 'led_on',
        ref: 'D1',
        label: 'ON',
        kind: 'led_3mm',
        xMm: 18.0,
        yMm: 10.0,
        widthMm: 3.0,
        depthMm: 3.0,
        heightMm: 4.5,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 3.2,
          ClearanceMm: 0.2,
        },
      },
    ],
  },

  raspberry_pi_hat: {
    name: 'Raspberry Pi HAT',
    widthMm: 65.0,
    depthMm: 56.0,
    thicknessMm: 1.6,
    cornerRadiusMm: 3.0,
    color: 'green',
    mountingHoles: [
      { id: 'mh_1', xMm: -29.0, yMm: 24.5, drillMm: 2.75, padDiameterMm: 5.5, fastener: 'M2.5' },
      { id: 'mh_2', xMm: 29.0, yMm: 24.5, drillMm: 2.75, padDiameterMm: 5.5, fastener: 'M2.5' },
      { id: 'mh_3', xMm: -29.0, yMm: -24.5, drillMm: 2.75, padDiameterMm: 5.5, fastener: 'M2.5' },
      { id: 'mh_4', xMm: 29.0, yMm: -24.5, drillMm: 2.75, padDiameterMm: 5.5, fastener: 'M2.5' },
    ],
    components: [
      {
        id: 'gpio_40pin',
        ref: 'J1',
        label: 'GPIO 40P',
        kind: 'pin_header',
        xMm: 0.0,
        yMm: 21.5,
        widthMm: 51.0,
        depthMm: 5.0,
        heightMm: 8.5,
        panelMount: {
          face: 'top',
          cutoutShape: 'rect',
          widthMm: 52.0,
          heightMm: 6.0,
          ClearanceMm: 0.4,
        },
      },
      {
        id: 'eeprom_ic',
        ref: 'U1',
        label: 'EEPROM',
        kind: 'ic',
        xMm: -10.0,
        yMm: 0.0,
        widthMm: 6.0,
        depthMm: 5.0,
        heightMm: 1.8,
      },
      {
        id: 'driver_ic',
        ref: 'U2',
        label: 'DAC',
        kind: 'ic',
        xMm: 8.0,
        yMm: 0.0,
        widthMm: 10.0,
        depthMm: 10.0,
        heightMm: 2.2,
      },
      {
        id: 'led_pwr',
        ref: 'D1',
        label: 'PWR',
        kind: 'led_3mm',
        xMm: -16.0,
        yMm: -16.0,
        widthMm: 3.0,
        depthMm: 3.0,
        heightMm: 4.5,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 3.2,
          ClearanceMm: 0.2,
        },
      },
      {
        id: 'led_act',
        ref: 'D2',
        label: 'ACT',
        kind: 'led_3mm',
        xMm: -8.0,
        yMm: -16.0,
        widthMm: 3.0,
        depthMm: 3.0,
        heightMm: 4.5,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 3.2,
          ClearanceMm: 0.2,
        },
      },
      {
        id: 'usbc_aux',
        ref: 'J2',
        label: 'USB-C',
        kind: 'usb_c',
        xMm: 12.0,
        yMm: -23.0,
        widthMm: 9.0,
        depthMm: 7.5,
        heightMm: 3.2,
        panelMount: {
          face: 'front',
          cutoutShape: 'rounded_rect',
          widthMm: 9.4,
          heightMm: 3.6,
          cornerRadiusMm: 1.2,
          ClearanceMm: 0.3,
        },
      },
    ],
  },

  eurorack_3u_10hp: {
    name: 'Eurorack 3U 10HP Synth Module',
    widthMm: 50.5,
    depthMm: 128.5,
    thicknessMm: 1.6,
    cornerRadiusMm: 1.0,
    color: 'black',
    mountingHoles: [
      { id: 'mh_tl', xMm: -17.5, yMm: 58.0, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
      { id: 'mh_tr', xMm: 17.5, yMm: 58.0, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
      { id: 'mh_bl', xMm: -17.5, yMm: -58.0, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
      { id: 'mh_br', xMm: 17.5, yMm: -58.0, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
    ],
    components: [
      {
        id: 'pot_freq',
        ref: 'RV1',
        label: 'FREQ',
        kind: 'potentiometer',
        xMm: 0.0,
        yMm: 40.0,
        widthMm: 9.5,
        depthMm: 11.0,
        heightMm: 15.0,
        panelMount: {
          face: 'top',
          cutoutShape: 'd_shaft',
          diameterMm: 7.2,
          shaftFlatMm: 5.5,
          ClearanceMm: 0.2,
          showDialTicks: true,
        },
      },
      {
        id: 'pot_res',
        ref: 'RV2',
        label: 'RES',
        kind: 'potentiometer',
        xMm: -12.0,
        yMm: 14.0,
        widthMm: 9.5,
        depthMm: 11.0,
        heightMm: 15.0,
        panelMount: {
          face: 'top',
          cutoutShape: 'd_shaft',
          diameterMm: 7.2,
          shaftFlatMm: 5.5,
          ClearanceMm: 0.2,
          showDialTicks: true,
        },
      },
      {
        id: 'pot_drive',
        ref: 'RV3',
        label: 'DRIVE',
        kind: 'potentiometer',
        xMm: 12.0,
        yMm: 14.0,
        widthMm: 9.5,
        depthMm: 11.0,
        heightMm: 15.0,
        panelMount: {
          face: 'top',
          cutoutShape: 'd_shaft',
          diameterMm: 7.2,
          shaftFlatMm: 5.5,
          ClearanceMm: 0.2,
          showDialTicks: true,
        },
      },
      {
        id: 'sw_mode',
        ref: 'SW1',
        label: 'MODE',
        kind: 'toggle_switch',
        xMm: 0.0,
        yMm: -6.0,
        widthMm: 7.0,
        depthMm: 12.0,
        heightMm: 14.0,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 6.3,
          ClearanceMm: 0.2,
        },
      },
      {
        id: 'led_clip',
        ref: 'D1',
        label: 'CLIP',
        kind: 'led_3mm',
        xMm: -14.0,
        yMm: -6.0,
        widthMm: 3.0,
        depthMm: 3.0,
        heightMm: 6.0,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 3.2,
          ClearanceMm: 0.2,
        },
      },
      {
        id: 'jack_in',
        ref: 'J1',
        label: 'IN',
        kind: 'audio_jack_35mm',
        xMm: -13.0,
        yMm: -26.0,
        widthMm: 9.0,
        depthMm: 11.0,
        heightMm: 11.5,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 6.2,
          ClearanceMm: 0.2,
        },
      },
      {
        id: 'jack_cv',
        ref: 'J2',
        label: 'CV',
        kind: 'audio_jack_35mm',
        xMm: 13.0,
        yMm: -26.0,
        widthMm: 9.0,
        depthMm: 11.0,
        heightMm: 11.5,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 6.2,
          ClearanceMm: 0.2,
        },
      },
      {
        id: 'jack_gate',
        ref: 'J3',
        label: 'GATE',
        kind: 'audio_jack_35mm',
        xMm: -13.0,
        yMm: -42.0,
        widthMm: 9.0,
        depthMm: 11.0,
        heightMm: 11.5,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 6.2,
          ClearanceMm: 0.2,
        },
      },
      {
        id: 'jack_out',
        ref: 'J4',
        label: 'OUT',
        kind: 'audio_jack_35mm',
        xMm: 13.0,
        yMm: -42.0,
        widthMm: 9.0,
        depthMm: 11.0,
        heightMm: 11.5,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 6.2,
          ClearanceMm: 0.2,
        },
      },
      {
        id: 'ic_tl074',
        ref: 'U1',
        label: 'TL074',
        kind: 'ic',
        xMm: 0.0,
        yMm: 27.0,
        widthMm: 19.0,
        depthMm: 6.5,
        heightMm: 3.5,
      },
    ],
  },

  guitar_pedal_1590b: {
    name: '1590B Stompbox Guitar Pedal',
    widthMm: 50.0,
    depthMm: 100.0,
    thicknessMm: 1.6,
    cornerRadiusMm: 2.0,
    color: 'red',
    mountingHoles: [
      { id: 'mh_tl', xMm: -20.5, yMm: 44.5, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
      { id: 'mh_tr', xMm: 20.5, yMm: 44.5, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
      { id: 'mh_bl', xMm: -20.5, yMm: -44.5, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
      { id: 'mh_br', xMm: 20.5, yMm: -44.5, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
    ],
    components: [
      {
        id: 'pot_gain',
        ref: 'RV1',
        label: 'GAIN',
        kind: 'potentiometer',
        xMm: -13.0,
        yMm: 28.0,
        widthMm: 9.5,
        depthMm: 11.0,
        heightMm: 15.0,
        panelMount: {
          face: 'top',
          cutoutShape: 'd_shaft',
          diameterMm: 7.2,
          shaftFlatMm: 5.5,
          ClearanceMm: 0.2,
          showDialTicks: true,
        },
      },
      {
        id: 'pot_tone',
        ref: 'RV2',
        label: 'TONE',
        kind: 'potentiometer',
        xMm: 0.0,
        yMm: 14.0,
        widthMm: 9.5,
        depthMm: 11.0,
        heightMm: 15.0,
        panelMount: {
          face: 'top',
          cutoutShape: 'd_shaft',
          diameterMm: 7.2,
          shaftFlatMm: 5.5,
          ClearanceMm: 0.2,
          showDialTicks: true,
        },
      },
      {
        id: 'pot_level',
        ref: 'RV3',
        label: 'LEVEL',
        kind: 'potentiometer',
        xMm: 13.0,
        yMm: 28.0,
        widthMm: 9.5,
        depthMm: 11.0,
        heightMm: 15.0,
        panelMount: {
          face: 'top',
          cutoutShape: 'd_shaft',
          diameterMm: 7.2,
          shaftFlatMm: 5.5,
          ClearanceMm: 0.2,
          showDialTicks: true,
        },
      },
      {
        id: 'led_status',
        ref: 'D1',
        label: 'ON',
        kind: 'led_5mm',
        xMm: 0.0,
        yMm: -4.0,
        widthMm: 5.0,
        depthMm: 5.0,
        heightMm: 7.0,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 5.2,
          ClearanceMm: 0.2,
        },
      },
      {
        id: 'footswitch_3pdt',
        ref: 'SW1',
        label: 'BYPASS',
        kind: 'pushbutton',
        xMm: 0.0,
        yMm: -28.0,
        widthMm: 17.0,
        depthMm: 17.0,
        heightMm: 16.0,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 12.2,
          ClearanceMm: 0.3,
        },
      },
      {
        id: 'jack_input',
        ref: 'J1',
        label: 'IN',
        kind: 'audio_jack_635mm',
        xMm: 17.0,
        yMm: -2.0,
        widthMm: 14.0,
        depthMm: 12.0,
        heightMm: 12.5,
        panelMount: {
          face: 'right',
          cutoutShape: 'circle',
          diameterMm: 9.8,
          ClearanceMm: 0.3,
        },
      },
      {
        id: 'jack_output',
        ref: 'J2',
        label: 'OUT',
        kind: 'audio_jack_635mm',
        xMm: -17.0,
        yMm: -2.0,
        widthMm: 14.0,
        depthMm: 12.0,
        heightMm: 12.5,
        panelMount: {
          face: 'left',
          cutoutShape: 'circle',
          diameterMm: 9.8,
          ClearanceMm: 0.3,
        },
      },
      {
        id: 'dc_9v',
        ref: 'J3',
        label: '9V DC',
        kind: 'barrel_jack',
        xMm: 0.0,
        yMm: 43.0,
        widthMm: 9.0,
        depthMm: 12.0,
        heightMm: 11.0,
        panelMount: {
          face: 'back',
          cutoutShape: 'circle',
          diameterMm: 9.5,
          ClearanceMm: 0.4,
        },
      },
      {
        id: 'opamp_jrc4558',
        ref: 'U1',
        label: 'JRC4558',
        kind: 'ic',
        xMm: 0.0,
        yMm: -14.0,
        widthMm: 9.5,
        depthMm: 6.5,
        heightMm: 3.5,
      },
    ],
  },

  proto_50x50: {
    name: '50x50 Sensor / MCU Node',
    widthMm: 50.0,
    depthMm: 50.0,
    thicknessMm: 1.6,
    cornerRadiusMm: 2.0,
    color: 'white',
    mountingHoles: [
      { id: 'mh_tl', xMm: -21.0, yMm: 21.0, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
      { id: 'mh_tr', xMm: 21.0, yMm: 21.0, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
      { id: 'mh_bl', xMm: -21.0, yMm: -21.0, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
      { id: 'mh_br', xMm: 21.0, yMm: -21.0, drillMm: 3.2, padDiameterMm: 6.0, fastener: 'M3' },
    ],
    components: [
      {
        id: 'oled_096',
        ref: 'DS1',
        label: 'OLED',
        kind: 'oled_display',
        xMm: 0.0,
        yMm: 6.0,
        widthMm: 26.0,
        depthMm: 16.0,
        heightMm: 4.5,
        panelMount: {
          face: 'top',
          cutoutShape: 'rect',
          widthMm: 24.0,
          heightMm: 14.0,
          ClearanceMm: 0.4,
        },
      },
      {
        id: 'usbc_conn',
        ref: 'J1',
        label: 'USB-C',
        kind: 'usb_c',
        xMm: 0.0,
        yMm: -20.5,
        widthMm: 9.0,
        depthMm: 7.5,
        heightMm: 3.2,
        panelMount: {
          face: 'front',
          cutoutShape: 'rounded_rect',
          widthMm: 9.2,
          heightMm: 3.6,
          cornerRadiusMm: 1.2,
          ClearanceMm: 0.3,
        },
      },
      {
        id: 'btn_select',
        ref: 'SW1',
        label: 'SELECT',
        kind: 'pushbutton',
        xMm: -10.0,
        yMm: -11.0,
        widthMm: 6.0,
        depthMm: 6.0,
        heightMm: 5.0,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 4.5,
          ClearanceMm: 0.3,
        },
      },
      {
        id: 'led_pwr',
        ref: 'D1',
        label: 'PWR',
        kind: 'led_3mm',
        xMm: 10.0,
        yMm: -11.0,
        widthMm: 3.0,
        depthMm: 3.0,
        heightMm: 4.5,
        panelMount: {
          face: 'top',
          cutoutShape: 'circle',
          diameterMm: 3.2,
          ClearanceMm: 0.2,
        },
      },
      {
        id: 'mcu_esp32',
        ref: 'U1',
        label: 'MCU',
        kind: 'ic',
        xMm: 0.0,
        yMm: -11.0,
        widthMm: 7.0,
        depthMm: 7.0,
        heightMm: 2.0,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// URL Fragment & JSON Handoff Codec (Volt <-> Mesh)
// ---------------------------------------------------------------------------

const PCB_HANDOFF_VERSION = '1';

function fromBase64UrlString(data: string): Uint8Array {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function validatePcbSpec(raw: unknown): PcbMechanicalSpec {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid PCB specification: expected an object.');
  }
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : 'Custom PCB';
  const widthMm = Number(obj.widthMm);
  const depthMm = Number(obj.depthMm);
  const thicknessMm = obj.thicknessMm !== undefined ? Number(obj.thicknessMm) : 1.6;
  if (!Number.isFinite(widthMm) || widthMm <= 0 || !Number.isFinite(depthMm) || depthMm <= 0) {
    throw new Error('Invalid PCB specification: widthMm and depthMm must be positive numbers.');
  }
  const mountingHoles = Array.isArray(obj.mountingHoles)
    ? (obj.mountingHoles as PcbMountingHole[]).map((h, i) => ({
        id: h.id || `mh_${i + 1}`,
        xMm: Number(h.xMm) || 0,
        yMm: Number(h.yMm) || 0,
        drillMm: Number(h.drillMm) > 0 ? Number(h.drillMm) : 3.2,
        ...(h.padDiameterMm !== undefined ? { padDiameterMm: Number(h.padDiameterMm) } : {}),
        ...(h.fastener ? { fastener: h.fastener } : {}),
      }))
    : [];
  const components = Array.isArray(obj.components)
    ? (obj.components as PcbComponent3D[]).map((c, i) => ({
        ...c,
        id: c.id || `comp_${i + 1}`,
        ref: c.ref || `U${i + 1}`,
        kind: c.kind || 'custom',
        xMm: Number(c.xMm) || 0,
        yMm: Number(c.yMm) || 0,
        widthMm: Number(c.widthMm) > 0 ? Number(c.widthMm) : 5,
        depthMm: Number(c.depthMm) > 0 ? Number(c.depthMm) : 5,
        heightMm: Number(c.heightMm) > 0 ? Number(c.heightMm) : 3,
      }))
    : [];
  return {
    name,
    widthMm,
    depthMm,
    thicknessMm: Number.isFinite(thicknessMm) && thicknessMm > 0 ? thicknessMm : 1.6,
    ...(obj.cornerRadiusMm !== undefined ? { cornerRadiusMm: Number(obj.cornerRadiusMm) } : {}),
    ...(obj.color ? { color: obj.color as PcbBoardColor } : {}),
    mountingHoles,
    components,
  };
}

/**
 * Encodes a `PcbMechanicalSpec` into a URL fragment (`#v=1&pcb=<base64url>`),
 * a full URL when `baseUrl` is provided, or a JSON string when `format === 'json'`.
 */
export function encodePcbHandoff(
  spec: PcbMechanicalSpec,
  options?: { format?: 'fragment' | 'json' | 'url'; baseUrl?: string },
): string {
  const validated = validatePcbSpec(spec);
  const json = JSON.stringify(validated);
  if (options?.format === 'json') return json;

  const bytes = new TextEncoder().encode(json);
  const params = new URLSearchParams({
    v: PCB_HANDOFF_VERSION,
    pcb: toBase64Url(bytes),
    name: validated.name,
  });
  const fragment = `#${params.toString()}`;
  if (options?.format === 'url' || options?.baseUrl) {
    const base = (options?.baseUrl ?? voltBaseUrl(safeLocation())).replace(/#.*$/, '');
    return `${base}${fragment}`;
  }
  return fragment;
}

/**
 * Decodes a `PcbMechanicalSpec` from a Volt/Mesh URL, a `#v=1&pcb=...` fragment,
 * a raw JSON string, or a base64url payload.
 */
export function decodePcbHandoff(input: string): PcbMechanicalSpec {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    throw new Error('Empty PCB handoff payload.');
  }

  // 1. Direct JSON object string
  if (trimmed.startsWith('{')) {
    return validatePcbSpec(JSON.parse(trimmed));
  }

  // 2. Full URL or URL fragment / query parameters
  let paramString = trimmed;
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx >= 0) {
    paramString = trimmed.slice(hashIdx + 1);
  } else if (trimmed.includes('?')) {
    paramString = trimmed.slice(trimmed.indexOf('?') + 1);
  }

  if (paramString.includes('pcb=')) {
    const params = new URLSearchParams(paramString);
    const pcbData = params.get('pcb');
    if (!pcbData) {
      throw new Error('Missing pcb parameter in handoff link.');
    }
    const json = new TextDecoder().decode(fromBase64UrlString(pcbData));
    return validatePcbSpec(JSON.parse(json));
  }

  // 3. Raw base64url string
  const json = new TextDecoder().decode(fromBase64UrlString(trimmed));
  return validatePcbSpec(JSON.parse(json));
}

function safeLocation(): { hostname: string; protocol: string } {
  if (typeof window !== 'undefined' && window.location) {
    return window.location;
  }
  return { hostname: 'localhost', protocol: 'http:' };
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'pcb'
  );
}

// ---------------------------------------------------------------------------
// 3D PCB SceneNode Builder
// ---------------------------------------------------------------------------

function componentColor(kind: PcbComponentKind): [number, number, number, number] {
  switch (kind) {
    case 'ic':
      return [0.16, 0.17, 0.19, 1];
    case 'capacitor':
      return [0.22, 0.35, 0.62, 1];
    case 'resistor':
      return [0.76, 0.62, 0.42, 1];
    case 'inductor':
      return [0.28, 0.28, 0.32, 1];
    case 'potentiometer':
      return [0.18, 0.46, 0.28, 1];
    case 'toggle_switch':
    case 'pushbutton':
      return [0.72, 0.75, 0.79, 1];
    case 'audio_jack_35mm':
    case 'audio_jack_635mm':
      return [0.20, 0.22, 0.25, 1];
    case 'usb_c':
      return [0.75, 0.78, 0.82, 1];
    case 'barrel_jack':
      return [0.15, 0.16, 0.18, 1];
    case 'led_3mm':
    case 'led_5mm':
      return [0.92, 0.22, 0.20, 0.95];
    case 'pin_header':
      return [0.20, 0.20, 0.22, 1];
    case 'oled_display':
      return [0.08, 0.14, 0.24, 1];
    case 'heatsink':
      return [0.66, 0.69, 0.74, 1];
    default:
      return [0.35, 0.38, 0.42, 1];
  }
}

function effectiveFootprintMm(comp: PcbComponent3D): [number, number] {
  const rot = (((comp.rotDeg ?? 0) % 360) + 360) % 360;
  if (Math.abs(rot - 90) < 1e-3 || Math.abs(rot - 270) < 1e-3) {
    return [comp.depthMm, comp.widthMm];
  }
  return [comp.widthMm, comp.depthMm];
}

function buildComponentGeoms(nodeId: string, comp: PcbComponent3D, boardThicknessMm: number): SceneGeom[] {
  const side = comp.side ?? 'top';
  const sign = side === 'bottom' ? -1 : 1;
  const boardSurfaceZMm = sign * (boardThicknessMm / 2);
  const [wMm, dMm] = effectiveFootprintMm(comp);
  const hMm = Math.max(0.5, comp.heightMm);
  const xM = mm(comp.xMm);
  const yM = mm(comp.yMm);
  const rgba = componentColor(comp.kind);
  const baseName = `${nodeId}_comp_${comp.id}`;
  const geoms: SceneGeom[] = [];

  if (comp.kind === 'potentiometer') {
    const bodyHMm = Math.min(hMm * 0.45, 6.5);
    const shaftHMm = Math.max(2.0, hMm - bodyHMm);
    const bodyZMm = boardSurfaceZMm + sign * (bodyHMm / 2);
    const shaftZMm = boardSurfaceZMm + sign * (bodyHMm + shaftHMm / 2);
    const shaftRadiusMm = (comp.panelMount?.diameterMm ?? 6.0) / 2;

    geoms.push(
      boxGeom(
        `${baseName}_body`,
        [mm(wMm / 2), mm(dMm / 2), mm(bodyHMm / 2)],
        [xM, yM, mm(bodyZMm)],
        rgba,
        COMPONENT_DENSITY,
      ),
    );
    geoms.push(
      visual(
        cylinderGeom(
          `${baseName}_shaft`,
          mm(shaftRadiusMm),
          mm(shaftHMm),
          mm(shaftZMm),
          [0.78, 0.80, 0.84, 1],
          { pos: [xM, yM, mm(shaftZMm)] },
        ),
      ),
    );
    return geoms;
  }

  if (comp.kind === 'led_3mm' || comp.kind === 'led_5mm') {
    const radiusMm = comp.kind === 'led_5mm' ? 2.5 : 1.5;
    const zCenterMm = boardSurfaceZMm + sign * (hMm / 2);
    const cyl = cylinderGeom(`${baseName}_lens`, mm(radiusMm), mm(hMm), mm(zCenterMm), rgba, {
      pos: [xM, yM, mm(zCenterMm)],
      mass: +(Math.PI * mm(radiusMm) * mm(radiusMm) * mm(hMm) * COMPONENT_DENSITY).toFixed(7),
    });
    geoms.push(cyl);
    return geoms;
  }

  if (comp.kind === 'toggle_switch' || comp.kind === 'pushbutton') {
    const bodyHMm = hMm * 0.55;
    const actuatorHMm = hMm * 0.45;
    const bodyZMm = boardSurfaceZMm + sign * (bodyHMm / 2);
    const actZMm = boardSurfaceZMm + sign * (bodyHMm + actuatorHMm / 2);
    const actRadiusMm = (comp.panelMount?.diameterMm ?? Math.min(wMm, dMm) * 0.5) / 2;

    geoms.push(
      boxGeom(
        `${baseName}_housing`,
        [mm(wMm / 2), mm(dMm / 2), mm(bodyHMm / 2)],
        [xM, yM, mm(bodyZMm)],
        [0.24, 0.26, 0.30, 1],
        COMPONENT_DENSITY,
      ),
    );
    geoms.push(
      visual(
        cylinderGeom(`${baseName}_actuator`, mm(actRadiusMm), mm(actuatorHMm), mm(actZMm), rgba, {
          pos: [xM, yM, mm(actZMm)],
        }),
      ),
    );
    return geoms;
  }

  // Standard box body (IC, USB-C, barrel jack, audio jack, OLED, headers, passives)
  const zCenterMm = boardSurfaceZMm + sign * (hMm / 2);
  geoms.push(
    boxGeom(
      baseName,
      [mm(wMm / 2), mm(dMm / 2), mm(hMm / 2)],
      [xM, yM, mm(zCenterMm)],
      rgba,
      COMPONENT_DENSITY,
    ),
  );

  if (comp.kind === 'oled_display') {
    const glassHMm = 0.8;
    const glassZMm = boardSurfaceZMm + sign * (hMm + glassHMm / 2);
    geoms.push(
      visual(
        boxGeom(
          `${baseName}_screen`,
          [mm((wMm * 0.88) / 2), mm((dMm * 0.82) / 2), mm(glassHMm / 2)],
          [xM, yM, mm(glassZMm)],
          [0.05, 0.72, 0.92, 1],
        ),
      ),
    );
  }

  return geoms;
}

/**
 * Builds a 3D `SceneNode` representing the populated PCB assembly in metres (Z-up):
 * - FR4 substrate `boxGeom` weighed at FR4 density (1850 kg/m³),
 * - Copper mounting ring visual geoms (`ringGeom`) at every mounting hole,
 * - 3D component body/shaft/screen geoms positioned on top (`+thickness/2`) or
 *   bottom (`-thickness/2`) of the board.
 */
export function buildPcbNode(
  spec: PcbMechanicalSpec,
  options?: { id?: string; pos?: [number, number, number] },
): SceneNode {
  const valid = validatePcbSpec(spec);
  const id = options?.id ?? `pcb_${slugify(valid.name)}`;
  const pos: [number, number, number] = options?.pos ? [...options.pos] : [0, 0, 0];
  const boardRgba = PCB_BOARD_COLORS[valid.color ?? 'green'] ?? PCB_BOARD_COLORS.green;

  const substrateGeom = boxGeom(
    `${id}_substrate`,
    [mm(valid.widthMm / 2), mm(valid.depthMm / 2), mm(valid.thicknessMm / 2)],
    [0, 0, 0],
    boardRgba,
    FR4_DENSITY,
  );

  const ringGeoms: SceneGeom[] = valid.mountingHoles.map((hole) => {
    const innerR = mm(hole.drillMm / 2);
    const outerR = mm(Math.max(hole.drillMm + 1.2, hole.padDiameterMm ?? hole.drillMm * 1.8) / 2);
    const h = mm(valid.thicknessMm + 0.12);
    const hx = mm(hole.xMm);
    const hy = mm(hole.yMm);
    const ring = ringGeom(`${id}_pad_${hole.id}`, outerR, innerR, h, 0, COPPER_RGBA);
    // Offset mesh vertices to the hole's (hx, hy) position in the board frame
    if (ring.renderVertices) {
      for (let i = 0; i < ring.renderVertices.length; i += 3) {
        ring.renderVertices[i] = +(ring.renderVertices[i] + hx).toFixed(7);
        ring.renderVertices[i + 1] = +(ring.renderVertices[i + 1] + hy).toFixed(7);
      }
    }
    if (ring.vertices) {
      for (let i = 0; i < ring.vertices.length; i += 3) {
        ring.vertices[i] = +(ring.vertices[i] + hx).toFixed(7);
        ring.vertices[i + 2] = +(ring.vertices[i + 2] - hy).toFixed(7);
      }
    }
    return visual(ring);
  });

  const componentGeoms: SceneGeom[] = valid.components.flatMap((comp) =>
    buildComponentGeoms(id, comp, valid.thicknessMm),
  );

  const geoms = [substrateGeom, ...ringGeoms, ...componentGeoms];

  return {
    id,
    name: valid.name,
    type: 'body',
    pos,
    width: mm(valid.widthMm),
    depth: mm(valid.depthMm),
    height: mm(valid.thicknessMm),
    joints: [{ name: `${id}_free`, type: 'free' }],
    geoms,
    children: [],
  };
}

// ---------------------------------------------------------------------------
// Enclosure, Standoffs & Panel Cutout Generator
// ---------------------------------------------------------------------------

function normalizeFastener(hole: PcbMountingHole): PcbFastenerSize {
  if (hole.fastener && INSERTS[hole.fastener]) return hole.fastener;
  if (hole.drillMm <= 2.3) return 'M2';
  if (hole.drillMm <= 2.9) return 'M2.5';
  if (hole.drillMm <= 3.6) return 'M3';
  return 'M4';
}

function cutoutClearanceMm(pm: PcbPanelMountSpec): number {
  const c = pm.clearanceMm ?? pm.ClearanceMm;
  return c !== undefined && Number.isFinite(c) ? Math.max(0, c) : 0.3;
}

function cutoutDimensionsMm(comp: PcbComponent3D, pm: PcbPanelMountSpec): {
  widthMm: number;
  heightMm: number;
  diameterMm?: number;
} {
  const fit = cutoutClearanceMm(pm);
  if (pm.cutoutShape === 'circle' || pm.cutoutShape === 'd_shaft') {
    const d = (pm.diameterMm ?? Math.min(comp.widthMm, comp.depthMm)) + fit;
    return { widthMm: d, heightMm: d, diameterMm: d };
  }
  const w = (pm.widthMm ?? comp.widthMm) + fit;
  const h = (pm.heightMm ?? comp.heightMm) + fit;
  return { widthMm: w, heightMm: h };
}

function faceNormalVector(face: PcbEnclosureFace): [number, number, number] {
  switch (face) {
    case 'top':
      return [0, 0, 1];
    case 'front':
      return [0, -1, 0];
    case 'back':
      return [0, 1, 0];
    case 'left':
      return [-1, 0, 0];
    case 'right':
      return [1, 0, 0];
  }
}

function buildPanelCutoutGeom(
  nodeId: string,
  comp: PcbComponent3D,
  pm: PcbPanelMountSpec,
  atM: [number, number, number],
  wallThicknessMm: number,
): { geom: SceneGeom; widthMm: number; heightMm: number; diameterMm?: number } {
  const dims = cutoutDimensionsMm(comp, pm);
  const normal = faceNormalVector(pm.face);
  const nVec = new THREE.Vector3(...normal).normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), nVec);
  const mjQuat = [quat.w, quat.x, quat.y, quat.z].map((v) => +v.toFixed(9));

  const cutLenMm = wallThicknessMm + 3.0;
  const geomName = `${nodeId}_cutout_${comp.id}`;

  if (pm.cutoutShape === 'circle' || pm.cutoutShape === 'd_shaft') {
    const radiusM = mm((dims.diameterMm ?? dims.widthMm) / 2);
    const geom: SceneGeom = {
      name: geomName,
      type: 'cylinder',
      size: [radiusM, mm(cutLenMm / 2)],
      pos: atM.map((v) => +v.toFixed(6)),
      quat: mjQuat,
      csg: 'difference',
      cutAt: atM.map((v) => +v.toFixed(6)),
      cutNormal: [...normal],
      cutDepth: 0,
      rgba: [0.9, 0.25, 0.35, 1],
    };
    return { geom, ...dims };
  }

  // For side walls, local +Z of the cutter points outward along `normal`.
  // When `normal` is [0, ±1, 0] or [±1, 0, 0], we want the box's horizontal
  // cross-section axis to align with the wall's horizontal axis and the other
  // axis to align with world Z.
  const uAxis =
    pm.face === 'top'
      ? new THREE.Vector3(1, 0, 0)
      : pm.face === 'front' || pm.face === 'back'
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
  const xAfterQuat = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  const yAfterQuat = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const twist = Math.atan2(uAxis.dot(yAfterQuat), uAxis.dot(xAfterQuat));
  if (Math.abs(twist) > 1e-9) {
    quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), twist));
  }
  const boxQuat = [quat.w, quat.x, quat.y, quat.z].map((v) => +v.toFixed(9));

  const geom: SceneGeom = {
    name: geomName,
    type: 'box',
    size: [mm(dims.widthMm / 2), mm(dims.heightMm / 2), mm(cutLenMm / 2)],
    pos: atM.map((v) => +v.toFixed(6)),
    quat: boxQuat,
    csg: 'difference',
    cutAt: atM.map((v) => +v.toFixed(6)),
    cutNormal: [...normal],
    cutDepth: 0,
    ...(Math.abs(twist) > 1e-9 ? { cutTwist: +twist.toFixed(9) } : {}),
    rgba: [0.9, 0.25, 0.35, 1],
  };
  return { geom, ...dims };
}

/**
 * Where the lid's screws go. Each is a boss hanging from the top of the base's
 * walls in an inside corner, fused into both walls, with an insert sunk into its
 * top; the lid's clearance holes sit over them. A boss standing on the floor
 * would go through the board, which is only `boardClearanceMm` from the walls,
 * so the boss stops short of it instead. Centred mm, base frame.
 */
interface LidScrewLayout {
  fastener: PcbFastenerSize;
  /** Boss centres, [tag, x, y], mm. */
  corners: [string, number, number][];
  bossRadiusMm: number;
  /** How far the boss hangs below the top of the walls. */
  bossLengthMm: number;
  insertDepthMm: number;
}

function lidScrewLayout(innerWidthMm: number, innerDepthMm: number, opts: PcbEnclosureOptions): LidScrewLayout {
  const fastener = opts.lidFastenerSize;
  const [, insertDepthMm, bossOuterMm] = INSERTS[fastener] ?? INSERTS.M3;
  const bossRadiusMm = bossOuterMm / 2;
  // Far enough in that the boss stays 0.3 mm inside the outer faces.
  const inset = Math.max(bossRadiusMm - opts.wallThicknessMm + 0.3, 0.5);
  const cx = innerWidthMm / 2 - inset;
  const cy = innerDepthMm / 2 - inset;
  return {
    fastener,
    corners: [['tl', -cx, cy], ['tr', cx, cy], ['bl', -cx, -cy], ['br', cx, -cy]],
    bossRadiusMm,
    bossLengthMm: insertDepthMm + 1.5,
    insertDepthMm,
  };
}

/** Room a lid boss needs between its foot and anything below it. */
const LID_BOSS_GAP_MM = 0.5;

/**
 * Computes electro-mechanical clearance checks between the PCB components,
 * mounting bosses, and enclosure walls/lid/floor.
 */
export function evaluatePcbClearance(
  spec: PcbMechanicalSpec,
  options?: Partial<PcbEnclosureOptions>,
): PcbClearanceCheck {
  const opts: PcbEnclosureOptions = { ...DEFAULT_PCB_ENCLOSURE_OPTIONS, ...options };
  const innerWidthMm = +(spec.widthMm + 2 * opts.boardClearanceMm).toFixed(4);
  const innerDepthMm = +(spec.depthMm + 2 * opts.boardClearanceMm).toFixed(4);

  const topComps = spec.components.filter((c) => (c.side ?? 'top') === 'top');
  const bottomComps = spec.components.filter((c) => c.side === 'bottom');
  const maxTopCompMm = topComps.length ? Math.max(...topComps.map((c) => c.heightMm)) : 4.0;
  const maxBottomCompMm = bottomComps.length ? Math.max(...bottomComps.map((c) => c.heightMm)) : 0;

  // The lid's screw bosses hang over the board's corners, so the board needs
  // their length (and a gap) above it as well as room for its components.
  const lidScrews = opts.includeLid ? lidScrewLayout(innerWidthMm, innerDepthMm, opts) : null;
  const roomAboveBoardMm = Math.max(
    maxTopCompMm + opts.topClearanceMm,
    lidScrews ? lidScrews.bossLengthMm + LID_BOSS_GAP_MM : 0,
  );
  const innerHeightMm = +(
    opts.standoffHeightMm +
    spec.thicknessMm +
    roomAboveBoardMm
  ).toFixed(4);

  const outerWidthMm = +(innerWidthMm + 2 * opts.wallThicknessMm).toFixed(4);
  const outerDepthMm = +(innerDepthMm + 2 * opts.wallThicknessMm).toFixed(4);
  const outerHeightMm = +(
    innerHeightMm +
    opts.wallThicknessMm +
    (opts.includeLid ? opts.wallThicknessMm : 0)
  ).toFixed(4);

  const issues: PcbClearanceIssue[] = [];
  let minWallClearanceMm = opts.boardClearanceMm;
  let minTopClearanceMm = opts.topClearanceMm;
  let minBottomClearanceMm = opts.standoffHeightMm - maxBottomCompMm;
  let minBossClearanceMm = Infinity;

  // 1. Check mounting holes inside board outline
  for (const hole of spec.mountingHoles) {
    const r = hole.drillMm / 2;
    const edgeX = spec.widthMm / 2 - Math.abs(hole.xMm) - r;
    const edgeY = spec.depthMm / 2 - Math.abs(hole.yMm) - r;
    const minEdge = Math.min(edgeX, edgeY);
    if (minEdge < 0) {
      issues.push({
        severity: 'error',
        code: 'hole_out_of_bounds',
        holeId: hole.id,
        message: `Mounting hole ${hole.id} extends outside PCB edge by ${Math.abs(minEdge).toFixed(2)} mm.`,
        clearanceMm: +minEdge.toFixed(3),
      });
    }
  }

  // 2. Check component clearances to walls, lid, floor, and mounting bosses
  for (const comp of spec.components) {
    const [wMm, dMm] = effectiveFootprintMm(comp);
    const side = comp.side ?? 'top';
    const pmFace = comp.panelMount?.face;

    // Wall clearance along X and Y (ignore wall that an edge connector intentionally pierces)
    const rightClearance =
      pmFace === 'right' ? opts.boardClearanceMm : innerWidthMm / 2 - (comp.xMm + wMm / 2);
    const leftClearance =
      pmFace === 'left' ? opts.boardClearanceMm : innerWidthMm / 2 - (-comp.xMm + wMm / 2);
    const backClearance =
      pmFace === 'back' ? opts.boardClearanceMm : innerDepthMm / 2 - (comp.yMm + dMm / 2);
    const frontClearance =
      pmFace === 'front' ? opts.boardClearanceMm : innerDepthMm / 2 - (-comp.yMm + dMm / 2);

    const compWallClearance = Math.min(rightClearance, leftClearance, backClearance, frontClearance);
    minWallClearanceMm = Math.min(minWallClearanceMm, compWallClearance);

    if (compWallClearance < 0) {
      issues.push({
        severity: 'error',
        code: 'wall_collision',
        componentId: comp.id,
        message: `Component ${comp.ref} (${comp.label || comp.kind}) collides with enclosure wall by ${Math.abs(compWallClearance).toFixed(2)} mm.`,
        clearanceMm: +compWallClearance.toFixed(3),
      });
    }

    // Vertical clearance to lid or floor
    if (side === 'top') {
      const topRoom = innerHeightMm - opts.standoffHeightMm - spec.thicknessMm - comp.heightMm;
      minTopClearanceMm = Math.min(minTopClearanceMm, topRoom);
      if (topRoom < 0 && pmFace !== 'top') {
        issues.push({
          severity: 'error',
          code: 'lid_collision',
          componentId: comp.id,
          message: `Component ${comp.ref} exceeds lid clearance by ${Math.abs(topRoom).toFixed(2)} mm.`,
          clearanceMm: +topRoom.toFixed(3),
        });
      }
    } else {
      const bottomRoom = opts.standoffHeightMm - comp.heightMm;
      minBottomClearanceMm = Math.min(minBottomClearanceMm, bottomRoom);
      if (bottomRoom < 0) {
        issues.push({
          severity: 'error',
          code: 'floor_collision',
          componentId: comp.id,
          message: `Bottom component ${comp.ref} exceeds standoff height (${opts.standoffHeightMm.toFixed(1)} mm) by ${Math.abs(bottomRoom).toFixed(2)} mm.`,
          clearanceMm: +bottomRoom.toFixed(3),
        });
      }
    }

    // Mounting boss / fastener keep-out check
    for (const hole of spec.mountingHoles) {
      const fastener = normalizeFastener(hole);
      const bossOuterMm = INSERTS[fastener]?.[2] ?? hole.padDiameterMm ?? hole.drillMm * 2;
      const keepoutRadiusMm = Math.max(bossOuterMm, hole.padDiameterMm ?? 0) / 2;

      // Closest point on component rectangle [comp.xMm ± wMm/2, comp.yMm ± dMm/2] to hole center
      const dx = Math.max(0, Math.abs(hole.xMm - comp.xMm) - wMm / 2);
      const dy = Math.max(0, Math.abs(hole.yMm - comp.yMm) - dMm / 2);
      const distToEdge = Math.hypot(dx, dy);
      const clearance = distToEdge - keepoutRadiusMm;
      minBossClearanceMm = Math.min(minBossClearanceMm, clearance);

      if (clearance < 0) {
        issues.push({
          severity: 'error',
          code: 'boss_keepout',
          componentId: comp.id,
          holeId: hole.id,
          message: `Component ${comp.ref} overlaps mounting boss ${hole.id} keep-out zone by ${Math.abs(clearance).toFixed(2)} mm.`,
          clearanceMm: +clearance.toFixed(3),
        });
      }
    }

    // A top-side component under one of the lid's hanging screw bosses
    if (lidScrews && side === 'top') {
      const underBossMm = roomAboveBoardMm - lidScrews.bossLengthMm - comp.heightMm;
      for (const [tag, bx, by] of lidScrews.corners) {
        const dx = Math.max(0, Math.abs(bx - comp.xMm) - wMm / 2);
        const dy = Math.max(0, Math.abs(by - comp.yMm) - dMm / 2);
        if (Math.hypot(dx, dy) >= lidScrews.bossRadiusMm || underBossMm >= 0) continue;
        minTopClearanceMm = Math.min(minTopClearanceMm, underBossMm);
        issues.push({
          severity: 'error',
          code: 'lid_collision',
          componentId: comp.id,
          message: `Component ${comp.ref} is under the lid screw boss in the ${tag} corner and ${Math.abs(underBossMm).toFixed(2)} mm too tall for it; raise topClearanceMm or move the part.`,
          clearanceMm: +underBossMm.toFixed(3),
        });
      }
    }
  }

  if (!Number.isFinite(minBossClearanceMm)) minBossClearanceMm = 10.0;

  return {
    ok: issues.every((i) => i.severity !== 'error'),
    minWallClearanceMm: +minWallClearanceMm.toFixed(3),
    minTopClearanceMm: +minTopClearanceMm.toFixed(3),
    minBottomClearanceMm: +minBottomClearanceMm.toFixed(3),
    minBossClearanceMm: +minBossClearanceMm.toFixed(3),
    innerDimensionsMm: [innerWidthMm, innerDepthMm, innerHeightMm],
    outerDimensionsMm: [outerWidthMm, outerDepthMm, outerHeightMm],
    issues,
  };
}

/**
 * Generates a complete CSG-enabled enclosure base, optional removable lid,
 * and populated 3D PCB node with integrated mounting bosses (`insert_boss`)
 * and subtracted panel cutouts (`csg: 'difference'`).
 */
export function generatePcbEnclosure(
  spec: PcbMechanicalSpec,
  options?: Partial<PcbEnclosureOptions>,
): {
  baseNode: SceneNode;
  lidNode?: SceneNode;
  pcbNode: SceneNode;
  cutouts: PanelCutoutSummary[];
  clearanceReport: PcbClearanceCheck;
} {
  const valid = validatePcbSpec(spec);
  const opts: PcbEnclosureOptions = { ...DEFAULT_PCB_ENCLOSURE_OPTIONS, ...options };
  const clearanceReport = evaluatePcbClearance(valid, opts);

  const [innerWidthMm, innerDepthMm, innerHeightMm] = clearanceReport.innerDimensionsMm;
  const [outerWidthMm, outerDepthMm] = clearanceReport.outerDimensionsMm;
  const baseHeightMm = opts.wallThicknessMm + innerHeightMm;

  const slug = slugify(valid.name);
  const baseId = `enclosure_${slug}_base`;
  const lidId = `enclosure_${slug}_lid`;
  const pcbId = `pcb_${slug}`;

  const worldOrigin: [number, number, number] = opts.pos
    ? [...opts.pos]
    : [0, 0, mm(baseHeightMm / 2)];

  // In `baseNode` local coordinates, the box is centred at Z = 0:
  //   bottom of floor = -baseHeightMm / 2
  //   top of floor    = -baseHeightMm / 2 + wallThicknessMm = (wallThicknessMm - innerHeightMm) / 2
  //   top of walls    = +baseHeightMm / 2
  const floorTopZMm = -baseHeightMm / 2 + opts.wallThicknessMm;
  const pcbBottomZMm = floorTopZMm + opts.standoffHeightMm;
  const pcbCenterZMm = pcbBottomZMm + valid.thicknessMm / 2;
  const pcbTopZMm = pcbBottomZMm + valid.thicknessMm;

  const baseRgba = opts.enclosureColor ?? [0.22, 0.25, 0.30, 1];
  const lidRgba = opts.lidColor ?? [0.28, 0.32, 0.38, 1];
  const ABS_DENSITY = 1050;

  // 1. The shell: a floor and four walls. It is built up rather than hollowed
  // out of a block, because every `difference` comes off after every `union`,
  // so a cavity cutter would take the standoffs and screw bosses with it.
  const wallHalfMm = opts.wallThicknessMm / 2;
  // Walls start halfway into the floor, so the pieces overlap rather than touch.
  const wallHeightMm = innerHeightMm + wallHalfMm;
  const wallCenterZMm = baseHeightMm / 2 - wallHeightMm / 2;
  const shellBox = (part: string, halfMm: number[], posMm: number[]) =>
    boxGeom(`${baseId}_${part}`, halfMm.map(mm), posMm.map(mm), baseRgba, ABS_DENSITY);
  const shellGeoms: SceneGeom[] = [
    shellBox('floor', [outerWidthMm / 2, outerDepthMm / 2, wallHalfMm], [0, 0, -baseHeightMm / 2 + wallHalfMm]),
    shellBox('wall_left', [wallHalfMm, outerDepthMm / 2, wallHeightMm / 2], [-outerWidthMm / 2 + wallHalfMm, 0, wallCenterZMm]),
    shellBox('wall_right', [wallHalfMm, outerDepthMm / 2, wallHeightMm / 2], [outerWidthMm / 2 - wallHalfMm, 0, wallCenterZMm]),
    shellBox('wall_front', [outerWidthMm / 2, wallHalfMm, wallHeightMm / 2], [0, -outerDepthMm / 2 + wallHalfMm, wallCenterZMm]),
    shellBox('wall_back', [outerWidthMm / 2, wallHalfMm, wallHeightMm / 2], [0, outerDepthMm / 2 - wallHalfMm, wallCenterZMm]),
  ];

  // Screw bosses for the lid, hanging in the inside corners from the top of
  // the walls, each with an insert sunk into its top.
  const lidScrews = opts.includeLid ? lidScrewLayout(innerWidthMm, innerDepthMm, opts) : null;
  const lidBossGeoms: SceneGeom[] = [];
  if (lidScrews) {
    const lengthMm = lidScrews.bossLengthMm;
    for (const [tag, x, y] of lidScrews.corners) {
      lidBossGeoms.push({
        name: `${baseId}_lid_boss_${tag}`,
        type: 'cylinder',
        size: [mm(lidScrews.bossRadiusMm), mm(lengthMm / 2)],
        pos: [mm(x), mm(y), mm(baseHeightMm / 2 - lengthMm / 2)],
        rgba: [...baseRgba],
        density: ABS_DENSITY,
      });
      lidBossGeoms.push(
        ...hardwareCutGeoms(
          { group: `lid_screw_${tag}`, kind: 'insert', size: lidScrews.fastener, at: [mm(x), mm(y), mm(baseHeightMm / 2)], normal: [0, 0, 1] },
          baseId,
        ),
      );
    }
  }

  // 2. Mounting standoff bosses (`insert_boss`) at every `spec.mountingHoles` position
  const standoffGeoms: SceneGeom[] = [];
  valid.mountingHoles.forEach((hole, index) => {
    const fastener = normalizeFastener(hole);
    const group = `standoff_${index + 1}`;
    const hxM = mm(hole.xMm);
    const hyM = mm(hole.yMm);
    const pieces = hardwareCutGeoms(
      {
        group,
        kind: 'insert_boss',
        size: fastener,
        bore: opts.boreType,
        at: [hxM, hyM, mm(floorTopZMm)],
        normal: [0, 0, 1],
      },
      baseId,
    );

    const [, insertDepthMm, bossOuterMm] = INSERTS[fastener] ?? INSERTS.M3;
    const bossRadiusM = mm(bossOuterMm / 2);
    const standoffOverlapMm = Math.min(1.0, opts.wallThicknessMm * 0.5);
    const bossTotalLenMm = opts.standoffHeightMm + standoffOverlapMm;
    const bossCenterZMm = floorTopZMm + (opts.standoffHeightMm - standoffOverlapMm) / 2;

    const boreDepthMm = Math.min(opts.standoffHeightMm - 0.4, insertDepthMm);
    const boreLenMm = boreDepthMm + 1.0;
    const boreCenterZMm = pcbBottomZMm - boreDepthMm / 2 + 0.5;

    for (const piece of pieces) {
      if (piece.hardware?.part === 'boss') {
        piece.size = [bossRadiusM, mm(bossTotalLenMm / 2)];
        piece.pos = [hxM, hyM, mm(bossCenterZMm)];
        piece.quat = [1, 0, 0, 0];
        piece.cutAt = [hxM, hyM, mm(floorTopZMm)];
        piece.cutDepth = mm(opts.standoffHeightMm);
        piece.rgba = [...baseRgba];
      } else if (piece.hardware?.part === 'bore') {
        const radiusM = piece.size?.[0] ?? mm((CLEARANCE_HOLES[fastener] ?? 3.4) / 2);
        piece.size = [radiusM, mm(boreLenMm / 2)];
        piece.pos = [hxM, hyM, mm(boreCenterZMm)];
        piece.quat = [1, 0, 0, 0];
        piece.cutAt = [hxM, hyM, mm(pcbBottomZMm)];
        piece.cutDepth = mm(boreDepthMm);
      }
      standoffGeoms.push(piece);
    }
  });

  // 3. Panel cutouts for every component with `panelMount`
  const baseCutoutGeoms: SceneGeom[] = [];
  const lidCutoutGeoms: SceneGeom[] = [];
  const cutouts: PanelCutoutSummary[] = [];

  for (const comp of valid.components) {
    if (!comp.panelMount) continue;
    const pm = comp.panelMount;
    const side = comp.side ?? 'top';
    const sign = side === 'bottom' ? -1 : 1;
    const boardSurfZMm = side === 'bottom' ? pcbBottomZMm : pcbTopZMm;
    const compCutZMm = boardSurfZMm + sign * (pm.zOffsetMm ?? comp.heightMm / 2);

    if (pm.face === 'top') {
      const targetBody: 'base' | 'lid' = opts.includeLid ? 'lid' : 'base';
      const targetId = opts.includeLid ? lidId : baseId;
      const zFaceMm = opts.includeLid ? opts.wallThicknessMm / 2 : baseHeightMm / 2;
      const { geom, widthMm, heightMm, diameterMm } = buildPanelCutoutGeom(
        targetId,
        comp,
        pm,
        [mm(comp.xMm), mm(comp.yMm), mm(zFaceMm)],
        opts.wallThicknessMm,
      );
      if (opts.includeLid) {
        lidCutoutGeoms.push(geom);
      } else {
        baseCutoutGeoms.push(geom);
      }
      cutouts.push({
        componentId: comp.id,
        ref: comp.ref,
        label: comp.label,
        face: 'top',
        shape: pm.cutoutShape,
        xMm: comp.xMm,
        yMm: comp.yMm,
        widthMm: +widthMm.toFixed(3),
        heightMm: +heightMm.toFixed(3),
        ...(diameterMm !== undefined ? { diameterMm: +diameterMm.toFixed(3) } : {}),
        targetBody,
        geomName: geom.name,
      });
    } else {
      const wallCenterXMm =
        pm.face === 'left'
          ? -(innerWidthMm / 2 + opts.wallThicknessMm / 2)
          : pm.face === 'right'
            ? innerWidthMm / 2 + opts.wallThicknessMm / 2
            : comp.xMm;
      const wallCenterYMm =
        pm.face === 'front'
          ? -(innerDepthMm / 2 + opts.wallThicknessMm / 2)
          : pm.face === 'back'
            ? innerDepthMm / 2 + opts.wallThicknessMm / 2
            : comp.yMm;

      const { geom, widthMm, heightMm, diameterMm } = buildPanelCutoutGeom(
        baseId,
        comp,
        pm,
        [mm(wallCenterXMm), mm(wallCenterYMm), mm(compCutZMm)],
        opts.wallThicknessMm,
      );
      baseCutoutGeoms.push(geom);

      const face2DXMm = pm.face === 'front' || pm.face === 'back' ? comp.xMm : comp.yMm;
      const face2DYMm = compCutZMm - pcbCenterZMm;

      cutouts.push({
        componentId: comp.id,
        ref: comp.ref,
        label: comp.label,
        face: pm.face,
        shape: pm.cutoutShape,
        xMm: +face2DXMm.toFixed(3),
        yMm: +face2DYMm.toFixed(3),
        widthMm: +widthMm.toFixed(3),
        heightMm: +heightMm.toFixed(3),
        ...(diameterMm !== undefined ? { diameterMm: +diameterMm.toFixed(3) } : {}),
        targetBody: 'base',
        geomName: geom.name,
      });
    }
  }

  const baseNode: SceneNode = {
    id: baseId,
    name: `${valid.name} Enclosure Base`,
    type: 'body',
    pos: [...worldOrigin],
    csgEnabled: true,
    csgCollision: 'auto',
    csgSectors: CSG_DEFAULT_SECTORS,
    joints: [{ name: `${baseId}_free`, type: 'free' }],
    geoms: [...shellGeoms, ...lidBossGeoms, ...standoffGeoms, ...baseCutoutGeoms],
    children: [],
  };

  // 4. Optional removable lid node with 4 corner screw clearance holes + top panel cutouts
  let lidNode: SceneNode | undefined;
  if (lidScrews) {
    const lidPlate = boxGeom(
      `${lidId}_plate`,
      [mm(outerWidthMm / 2), mm(outerDepthMm / 2), mm(opts.wallThicknessMm / 2)],
      [0, 0, 0],
      lidRgba,
      ABS_DENSITY,
    );

    // Over the bosses in the base.
    const cornerHoleRadiusM = mm((CLEARANCE_HOLES[lidScrews.fastener] ?? 3.4) / 2);
    const lidCornerHoles: SceneGeom[] = lidScrews.corners.map(([tag, x, y]) => ({
      name: `${lidId}_corner_${tag}`,
      type: 'cylinder',
      size: [cornerHoleRadiusM, mm((opts.wallThicknessMm + 2.0) / 2)],
      pos: [mm(x), mm(y), 0],
      quat: [1, 0, 0, 0],
      csg: 'difference',
      cutAt: [mm(x), mm(y), mm(opts.wallThicknessMm / 2)],
      cutNormal: [0, 0, 1],
      cutDepth: 0,
      rgba: [0.9, 0.25, 0.35, 1],
    }));

    const lidWorldZ = worldOrigin[2] + mm(baseHeightMm / 2 + opts.wallThicknessMm / 2);
    lidNode = {
      id: lidId,
      name: `${valid.name} Enclosure Lid`,
      type: 'body',
      pos: [worldOrigin[0], worldOrigin[1], +lidWorldZ.toFixed(7)],
      csgEnabled: true,
      csgCollision: 'auto',
      csgSectors: CSG_DEFAULT_SECTORS,
      joints: [{ name: `${lidId}_free`, type: 'free' }],
      geoms: [lidPlate, ...lidCornerHoles, ...lidCutoutGeoms],
      children: [],
    };
  }

  // 5. Populated PCB node seated on the standoffs inside the enclosure
  const pcbWorldZ = worldOrigin[2] + mm(pcbCenterZMm);
  const pcbNode = buildPcbNode(valid, {
    id: pcbId,
    pos: [worldOrigin[0], worldOrigin[1], +pcbWorldZ.toFixed(7)],
  });

  return {
    baseNode,
    ...(lidNode ? { lidNode } : {}),
    pcbNode,
    cutouts,
    clearanceReport,
  };
}

/**
 * Applies a PCB's mounting bosses (`insert_boss`) and `panelMount` cutouts
 * onto an existing enclosure/panel `SceneNode`.
 */
export function applyPcbToEnclosureBody(
  host: SceneNode,
  spec: PcbMechanicalSpec,
  options?: Partial<PcbEnclosureOptions>,
): SceneNode {
  const valid = validatePcbSpec(spec);
  const opts: PcbEnclosureOptions = { ...DEFAULT_PCB_ENCLOSURE_OPTIONS, ...options };
  const cloned: SceneNode = JSON.parse(JSON.stringify(host));
  const bounds = sourcePositiveBounds(cloned) ?? {
    min: [mm(-valid.widthMm / 2 - 4), mm(-valid.depthMm / 2 - 4), mm(-10)],
    max: [mm(valid.widthMm / 2 + 4), mm(valid.depthMm / 2 + 4), mm(10)],
  };

  const floorZ = bounds.min[2] + mm(opts.wallThicknessMm);
  const pcbBottomZ = floorZ + mm(opts.standoffHeightMm);
  const pcbTopZ = pcbBottomZ + mm(valid.thicknessMm);

  // Add mounting bosses
  valid.mountingHoles.forEach((hole, index) => {
    const fastener = normalizeFastener(hole);
    const group = `pcb_standoff_${index + 1}`;
    const hxM = mm(hole.xMm);
    const hyM = mm(hole.yMm);
    const pieces = hardwareCutGeoms(
      {
        group,
        kind: 'insert_boss',
        size: fastener,
        bore: opts.boreType,
        at: [hxM, hyM, floorZ],
        normal: [0, 0, 1],
      },
      cloned.id,
      cloned,
    );
    for (const piece of pieces) {
      cloned.geoms.push(piece);
      const derived = cutGeometry(cloned, piece);
      if (derived) Object.assign(piece, derived);
    }
  });

  // Add panel cutouts on the corresponding faces of `host`
  for (const comp of valid.components) {
    if (!comp.panelMount) continue;
    const pm = comp.panelMount;
    const compZ = pcbTopZ + mm(pm.zOffsetMm ?? comp.heightMm / 2);
    const atM: [number, number, number] =
      pm.face === 'top'
        ? [mm(comp.xMm), mm(comp.yMm), bounds.max[2]]
        : pm.face === 'front'
          ? [mm(comp.xMm), bounds.min[1], compZ]
          : pm.face === 'back'
            ? [mm(comp.xMm), bounds.max[1], compZ]
            : pm.face === 'left'
              ? [bounds.min[0], mm(comp.yMm), compZ]
              : [bounds.max[0], mm(comp.yMm), compZ];

    const { geom } = buildPanelCutoutGeom(cloned.id, comp, pm, atM, opts.wallThicknessMm);
    cloned.geoms.push(geom);
    const derived = cutGeometry(cloned, geom);
    if (derived) Object.assign(geom, derived);
  }

  cloned.csgEnabled = true;
  if (cloned.csgCollision === undefined) cloned.csgCollision = 'auto';
  if (cloned.csgSectors === undefined) cloned.csgSectors = CSG_DEFAULT_SECTORS;

  return cloned;
}

// ---------------------------------------------------------------------------
// Front-Panel / Faceplate 1:1 Etch SVG Exporter
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates an SVG `<path>` for a D-shaft hole: a circle of `radius` centred at
 * `(cx, cy)` with a flat chord at the top at distance `flatOffset` from the
 * opposite side (`shaftFlatMm` total height from bottom of circle to flat).
 */
function buildDShaftSvgPath(cx: number, cy: number, radius: number, shaftFlatMm?: number): string {
  const r = Math.max(0.5, radius);
  const flatFromCenter = shaftFlatMm
    ? Math.max(-r * 0.8, Math.min(r * 0.9, shaftFlatMm - r))
    : r * 0.65;
  const yFlat = cy - flatFromCenter;
  const halfChord = Math.sqrt(Math.max(1e-4, r * r - flatFromCenter * flatFromCenter));
  const xLeft = +(cx - halfChord).toFixed(4);
  const xRight = +(cx + halfChord).toFixed(4);
  const yF = +yFlat.toFixed(4);
  const rFmt = +r.toFixed(4);
  // Start at left end of flat top chord, line to right end, major arc around bottom back to left
  return `M ${xLeft} ${yF} L ${xRight} ${yF} A ${rFmt} ${rFmt} 0 1 1 ${xLeft} ${yF} Z`;
}

/**
 * Generates radial potentiometer dial tick marks and a 270-degree scale arc
 * around `(cx, cy)` in SVG coordinates.
 */
function buildDialTicksSvg(cx: number, cy: number, holeRadiusMm: number): string {
  const innerR = holeRadiusMm + 2.0;
  const outerR = holeRadiusMm + 3.6;
  const majorOuterR = holeRadiusMm + 4.3;
  const ticks: string[] = [];
  const totalTicks = 11;
  // In SVG (+Y down, 0 deg = up): sweep from -135 deg (7:30) to +135 deg (4:30)
  for (let i = 0; i < totalTicks; i++) {
    const frac = i / (totalTicks - 1);
    const angleDeg = -135 + frac * 270;
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    const isMajor = i === 0 || i === 5 || i === totalTicks - 1;
    const rOut = isMajor ? majorOuterR : outerR;
    const x1 = +(cx + innerR * Math.cos(rad)).toFixed(3);
    const y1 = +(cy + innerR * Math.sin(rad)).toFixed(3);
    const x2 = +(cx + rOut * Math.cos(rad)).toFixed(3);
    const y2 = +(cy + rOut * Math.sin(rad)).toFixed(3);
    ticks.push(
      `    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#2563eb" stroke-width="${isMajor ? '0.35' : '0.22'}" data-layer="engrave" data-feature="dial-tick" />`,
    );
  }
  return ticks.join('\n');
}

function buildSyncEtchUrl(svg: string, name: string, thicknessMm = 2.0): string {
  const bytes = new TextEncoder().encode(svg);
  const params = new URLSearchParams({
    v: '1',
    gz: '0',
    data: toBase64Url(bytes),
    name,
    thickness: String(thicknessMm),
  });
  return `${etchBaseUrl(safeLocation())}#${params.toString()}`;
}

/**
 * Async helper that builds a compressed Etch handoff URL via `buildEtchHandoffUrl`.
 */
export async function buildPcbFaceplateEtchUrl(
  spec: PcbMechanicalSpec,
  face: PcbEnclosureFace = 'top',
  options?: FaceplateSvgOptions & { baseUrl?: string },
): Promise<string> {
  const { svg } = exportPcbFaceplateSvg(spec, face, options);
  return buildEtchHandoffUrl(
    {
      svg,
      name: `${spec.name} (${face} panel)`,
      thicknessMm: options?.thicknessMm ?? 2.0,
    },
    options?.baseUrl ?? etchBaseUrl(safeLocation()),
  );
}

/**
 * Projects all mounting holes and `panelMount` cutouts for the chosen face onto
 * a 1:1 2D SVG (with red cut outlines for holes, D-shafts, and display windows;
 * engraved blue labels and potentiometer dial tick arcs around knobs), plus an
 * Etch handoff URL.
 */
export function exportPcbFaceplateSvg(
  spec: PcbMechanicalSpec,
  face: PcbEnclosureFace = 'top',
  options?: FaceplateSvgOptions,
): FaceplateSvgResult {
  const valid = validatePcbSpec(spec);
  const enc: PcbEnclosureOptions = { ...DEFAULT_PCB_ENCLOSURE_OPTIONS, ...options?.enclosure };
  // The panel is the enclosure's own face: the lid seen from above, or a wall
  // seen from outside. A marginMm given explicitly overrides the plan size.
  const marginMm = options?.marginMm ?? enc.boardClearanceMm + enc.wallThicknessMm;
  const includeLabels = options?.includeLabels ?? true;
  const includeDialTicks = options?.includeDialTicks ?? true;
  const includeBoardOutline = options?.includeBoardOutline ?? true;
  const thicknessMm = options?.thicknessMm ?? 2.0;

  const { innerDimensionsMm: [innerWidthMm, innerDepthMm, innerHeightMm] } = evaluatePcbClearance(valid, enc);
  const baseHeightMm = enc.wallThicknessMm + innerHeightMm;
  const pcbBottomZMm = -baseHeightMm / 2 + enc.wallThicknessMm + enc.standoffHeightMm;

  const boardSpanXMm =
    face === 'left' || face === 'right' ? valid.depthMm : valid.widthMm;
  const widthMm = +(boardSpanXMm + 2 * marginMm).toFixed(3);
  const heightMm = +(face === 'top' ? valid.depthMm + 2 * marginMm : baseHeightMm).toFixed(3);
  const centerX = widthMm / 2;
  const centerY = heightMm / 2;

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}">`,
  );
  lines.push(`  <title>${escapeXml(valid.name)} - ${face.toUpperCase()} Faceplate</title>`);

  // 1. Outer faceplate cut boundary (red cut layer)
  const cornerR = Math.max(0, valid.cornerRadiusMm ?? 1.5);
  lines.push('  <g id="layer-cut" data-operation="cut" stroke="#ff0000" fill="none" stroke-width="0.2">');
  lines.push(
    `    <rect x="0" y="0" width="${widthMm}" height="${heightMm}" rx="${cornerR.toFixed(2)}" ry="${cornerR.toFixed(2)}" data-feature="panel-outline" />`,
  );

  let cutoutCount = 0;

  // 2. Screw holes on the top panel: the lid's, over the bosses in the base,
  // or with no lid, the board's own, for a plate on its standoffs.
  if (face === 'top') {
    const lidScrews = enc.includeLid ? lidScrewLayout(innerWidthMm, innerDepthMm, enc) : null;
    const holes: { id: string; x: number; y: number; r: number; attr: string }[] = lidScrews
      ? lidScrews.corners.map(([tag, x, y]) => ({
          id: tag, x, y, r: (CLEARANCE_HOLES[lidScrews.fastener] ?? 3.4) / 2, attr: 'data-lid-screw',
        }))
      : valid.mountingHoles.map((h) => ({ id: h.id, x: h.xMm, y: h.yMm, r: h.drillMm / 2, attr: 'data-mounting-hole' }));
    for (const hole of holes) {
      const cx = +(centerX + hole.x).toFixed(3);
      const cy = +(centerY - hole.y).toFixed(3);
      lines.push(
        `    <circle cx="${cx}" cy="${cy}" r="${+hole.r.toFixed(3)}" data-cutout-shape="circle" ${hole.attr}="${escapeXml(hole.id)}" />`,
      );
      cutoutCount++;
    }
  }

  // 3. Component panel cutouts for this face
  const engraveLines: string[] = [];
  if (includeBoardOutline && marginMm > 0 && face === 'top') {
    engraveLines.push(
      `    <rect x="${marginMm.toFixed(3)}" y="${marginMm.toFixed(3)}" width="${valid.widthMm.toFixed(3)}" height="${valid.depthMm.toFixed(3)}" stroke="#64748b" stroke-dasharray="1.5,1" stroke-width="0.15" fill="none" data-layer="reference" data-operation="ghost" data-feature="board-outline" />`,
    );
  }

  const faceComponents = valid.components.filter((c) => c.panelMount?.face === face);
  for (const comp of faceComponents) {
    const pm = comp.panelMount!;
    const dims = cutoutDimensionsMm(comp, pm);
    // Seen from outside: on the back and left walls +X and +Y run leftwards.
    const localX =
      face === 'left' ? -comp.yMm
        : face === 'right' ? comp.yMm
          : face === 'back' ? -comp.xMm
            : comp.xMm;
    // On a wall, the height the base model cuts it at, from the base's middle.
    const sign = comp.side === 'bottom' ? -1 : 1;
    const boardSurfZMm = comp.side === 'bottom' ? pcbBottomZMm : pcbBottomZMm + valid.thicknessMm;
    const localY = face === 'top' ? comp.yMm : boardSurfZMm + sign * (pm.zOffsetMm ?? comp.heightMm / 2);

    const cx = +(centerX + localX).toFixed(3);
    const cy = +(centerY - localY).toFixed(3);

    if (pm.cutoutShape === 'circle') {
      const r = +((dims.diameterMm ?? dims.widthMm) / 2).toFixed(3);
      lines.push(
        `    <circle cx="${cx}" cy="${cy}" r="${r}" data-cutout-shape="circle" data-component="${escapeXml(comp.id)}" data-ref="${escapeXml(comp.ref)}" />`,
      );
      if (includeDialTicks && (comp.kind === 'potentiometer' || pm.showDialTicks)) {
        engraveLines.push(buildDialTicksSvg(cx, cy, r));
      }
    } else if (pm.cutoutShape === 'd_shaft') {
      const r = +((dims.diameterMm ?? dims.widthMm) / 2).toFixed(3);
      const dPath = buildDShaftSvgPath(cx, cy, r, pm.shaftFlatMm);
      lines.push(
        `    <path d="${dPath}" data-cutout-shape="d_shaft" data-component="${escapeXml(comp.id)}" data-ref="${escapeXml(comp.ref)}" />`,
      );
      if (includeDialTicks && (comp.kind === 'potentiometer' || pm.showDialTicks)) {
        engraveLines.push(buildDialTicksSvg(cx, cy, r));
      }
    } else if (pm.cutoutShape === 'rounded_rect') {
      const x = +(cx - dims.widthMm / 2).toFixed(3);
      const y = +(cy - dims.heightMm / 2).toFixed(3);
      const rx = +(pm.cornerRadiusMm ?? Math.min(dims.widthMm, dims.heightMm) * 0.25).toFixed(3);
      lines.push(
        `    <rect x="${x}" y="${y}" width="${dims.widthMm.toFixed(3)}" height="${dims.heightMm.toFixed(3)}" rx="${rx}" ry="${rx}" data-cutout-shape="rounded_rect" data-component="${escapeXml(comp.id)}" data-ref="${escapeXml(comp.ref)}" />`,
      );
    } else {
      const x = +(cx - dims.widthMm / 2).toFixed(3);
      const y = +(cy - dims.heightMm / 2).toFixed(3);
      lines.push(
        `    <rect x="${x}" y="${y}" width="${dims.widthMm.toFixed(3)}" height="${dims.heightMm.toFixed(3)}" data-cutout-shape="rect" data-component="${escapeXml(comp.id)}" data-ref="${escapeXml(comp.ref)}" />`,
      );
    }

    if (includeLabels) {
      const text = comp.label || comp.ref;
      const offsetY =
        (comp.kind === 'potentiometer' || pm.showDialTicks
          ? (dims.diameterMm ?? dims.heightMm) / 2 + 6.2
          : dims.heightMm / 2 + 2.8);
      const labelY = +(cy + offsetY).toFixed(3);
      engraveLines.push(
        `    <text x="${cx}" y="${labelY}" text-anchor="middle" font-family="monospace, sans-serif" font-size="2.4" fill="#2563eb" data-layer="engrave" data-component-label="${escapeXml(comp.id)}">${escapeXml(text)}</text>`,
      );
    }

    cutoutCount++;
  }

  lines.push('  </g>');

  if (engraveLines.length > 0) {
    lines.push('  <g id="layer-engrave" data-operation="etch">');
    lines.push(...engraveLines);
    lines.push('  </g>');
  }

  lines.push('</svg>');
  const svg = lines.join('\n');
  const etchUrl = buildSyncEtchUrl(svg, `${valid.name} (${face} panel)`, thicknessMm);

  return {
    svg,
    widthMm,
    heightMm,
    cutoutCount,
    etchUrl,
  };
}

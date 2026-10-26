import React, { useMemo, useState } from 'react';
import { Cog, Plus, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore, cloneSceneGraph } from '../store/useStore';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { Field, Segmented, inputClass, sectionClass, sectionTitleClass } from './ExportFields';
import {
  STANDARD_MODULES_MM,
  buildCamMechanism,
  buildCamProfile,
  buildFourBarLinkage,
  buildGt2BeltDrive,
  buildGt2PulleyProfile,
  buildInvoluteGearNode,
  buildInvoluteGearProfile,
  buildInvoluteRackProfile,
  buildLeadscrewDrive,
  buildMeshingGearPair,
  buildRackAndPinionPair,
  fourBarMetrics,
  involuteGearMetrics,
  gt2PulleyMetrics,
  rotateLoop2D,
  type CamProfileKind,
  type GearBoreKind,
  type MechanismFamily,
} from '../utils/mechanismParts';

const FAMILY_OPTIONS: readonly [MechanismFamily, string][] = [
  ['gear_pair', 'Involute Gears'],
  ['rack_pinion', 'Rack & Pinion'],
  ['gt2_belt', 'GT2 Belt Drive'],
  ['leadscrew', 'T8 Leadscrew'],
  ['cam_follower', 'Cam & Follower'],
  ['four_bar', '4-Bar Linkage'],
] as const;

const BORE_OPTIONS: readonly [GearBoreKind, string][] = [
  ['round', 'Round Shaft'],
  ['d_shaft', 'D-Shaft'],
  ['hex', 'Hex Bore'],
  ['bearing_608', '608 Bearing (22 mm)'],
  ['none', 'Solid (No Bore)'],
] as const;

const CAM_OPTIONS: readonly [CamProfileKind, string][] = [
  ['heart', 'Heart (Constant Speed)'],
  ['harmonic', 'Harmonic (Dwell-Rise)'],
  ['snail', 'Snail (Drop Cam)'],
  ['eccentric', 'Eccentric Circle'],
] as const;

function loopToSvgPath(loop: [number, number][], dx = 0, dy = 0): string {
  if (loop.length === 0) return '';
  return (
    loop
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${(x + dx).toFixed(3)} ${(-y - dy).toFixed(3)}`)
      .join(' ') + ' Z'
  );
}

export const MechanismBuilderModal: React.FC<{ isOpen?: boolean; onClose: () => void }> = ({
  isOpen = true,
  onClose,
}) => {
  useEscapeToClose(isOpen, onClose);
  const sceneGraph = useStore((s) => s.sceneGraph);
  const updateScene = useStore((s) => s.updateScene);
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);

  const [family, setFamily] = useState<MechanismFamily>('gear_pair');

  // Shared / Gear states
  const [gearMode, setGearMode] = useState<'pair' | 'single'>('pair');
  const [moduleMm, setModuleMm] = useState<number>(1.5);
  const [driverTeeth, setDriverTeeth] = useState<number>(16);
  const [drivenTeeth, setDrivenTeeth] = useState<number>(32);
  const [pressureAngleDeg, setPressureAngleDeg] = useState<number>(20);
  const [thicknessMm, setThicknessMm] = useState<number>(8);
  const [backlashMm, setBacklashMm] = useState<number>(0.1);
  const [boreKind, setBoreKind] = useState<GearBoreKind>('d_shaft');
  const [boreDiameterMm, setBoreDiameterMm] = useState<number>(5.0);
  const [actuateDriver, setActuateDriver] = useState<boolean>(true);

  // Rack & Pinion states
  const [rackTeeth, setRackTeeth] = useState<number>(14);
  const [rackBaseHeightMm, setRackBaseHeightMm] = useState<number>(6);

  // GT2 Belt states
  const [gt2DriverTeeth, setGt2DriverTeeth] = useState<number>(20);
  const [gt2DrivenTeeth, setGt2DrivenTeeth] = useState<number>(40);
  const [gt2CenterMm, setGt2CenterMm] = useState<number>(60);
  const [gt2BeltWidthMm, setGt2BeltWidthMm] = useState<number>(6);

  // T8 Leadscrew states
  const [screwLengthMm, setScrewLengthMm] = useState<number>(180);
  const [screwLeadMm, setScrewLeadMm] = useState<number>(8);
  const [screwPitchMm, setScrewPitchMm] = useState<number>(2);

  // Cam states
  const [camKind, setCamKind] = useState<CamProfileKind>('heart');
  const [camBaseRadiusMm, setCamBaseRadiusMm] = useState<number>(18);
  const [camLiftMm, setCamLiftMm] = useState<number>(10);

  // 4-Bar states
  const [groundMm, setGroundMm] = useState<number>(80);
  const [crankMm, setCrankMm] = useState<number>(28);
  const [couplerMm, setCouplerMm] = useState<number>(72);
  const [rockerMm, setRockerMm] = useState<number>(56);
  const [crankAngleDeg, setCrankAngleDeg] = useState<number>(60);

  // Live preview & engineering metrics
  const preview = useMemo(() => {
    if (family === 'gear_pair') {
      const dSpec = {
        moduleMm,
        teeth: driverTeeth,
        pressureAngleDeg,
        thicknessMm,
        backlashMm,
        boreKind,
        boreDiameterMm,
      };
      const nSpec = {
        moduleMm,
        teeth: drivenTeeth,
        pressureAngleDeg,
        thicknessMm,
        backlashMm,
        boreKind,
        boreDiameterMm,
      };
      const p1 = buildInvoluteGearProfile(dSpec);
      const m1 = involuteGearMetrics(dSpec, gearMode === 'pair' ? nSpec : undefined);
      if (gearMode === 'single') {
        const pad = m1.addendumRadiusMm * 1.25;
        return {
          viewBox: `${-pad} ${-pad} ${pad * 2} ${pad * 2}`,
          paths: [
            {
              d:
                loopToSvgPath(p1.outline) +
                (p1.bore ? ' ' + loopToSvgPath(p1.bore) : ''),
              fill: 'rgba(59, 130, 246, 0.25)',
              stroke: '#3b82f6',
            },
          ],
          pitchCircles: [{ cx: 0, cy: 0, r: m1.pitchRadiusMm }],
          readouts: [
            ['Pitch Diameter', `${m1.pitchDiameterMm.toFixed(2)} mm`],
            ['Outer Diameter', `${(m1.addendumRadiusMm * 2).toFixed(2)} mm`],
            ['Root Diameter', `${(m1.rootRadiusMm * 2).toFixed(2)} mm`],
            ['Profile Shift x', `${m1.profileShift.toFixed(3)}`],
            ['Circular Pitch', `${m1.circularPitchMm.toFixed(2)} mm`],
            ['Tooth Thickness', `${m1.toothThicknessMm.toFixed(2)} mm`],
          ],
          statusOk: true,
          statusText:
            m1.profileShift > 0
              ? `Auto profile shift (+${m1.profileShift.toFixed(2)}) applied to prevent root undercutting at ${m1.teeth}T.`
              : `Standard ISO M${m1.moduleMm} involute profile (${m1.pressureAngleDeg}° pressure angle).`,
        };
      }

      const p2 = buildInvoluteGearProfile(nSpec);
      const m2 = involuteGearMetrics(nSpec, dSpec);
      const centerDist =
        moduleMm * ((m1.teeth + m2.teeth) / 2 + m1.profileShift + m2.profileShift);
      const clockRad = Math.PI + Math.PI / m2.teeth;
      const rot2 = rotateLoop2D(p2.outline, clockRad);
      const minX = -m1.addendumRadiusMm * 1.2;
      const maxX = centerDist + m2.addendumRadiusMm * 1.2;
      const maxR = Math.max(m1.addendumRadiusMm, m2.addendumRadiusMm) * 1.25;

      return {
        viewBox: `${minX} ${-maxR} ${maxX - minX} ${maxR * 2}`,
        paths: [
          {
            d:
              loopToSvgPath(p1.outline) +
              (p1.bore ? ' ' + loopToSvgPath(p1.bore) : ''),
            fill: 'rgba(59, 130, 246, 0.25)',
            stroke: '#3b82f6',
          },
          {
            d:
              loopToSvgPath(rot2, centerDist, 0) +
              (p2.bore ? ' ' + loopToSvgPath(p2.bore, centerDist, 0) : ''),
            fill: 'rgba(245, 158, 11, 0.25)',
            stroke: '#f59e0b',
          },
        ],
        pitchCircles: [
          { cx: 0, cy: 0, r: m1.pitchRadiusMm },
          { cx: centerDist, cy: 0, r: m2.pitchRadiusMm },
        ],
        readouts: [
          ['Center Distance a', `${centerDist.toFixed(2)} mm`],
          ['Gear Ratio', `${(m2.teeth / m1.teeth).toFixed(3)} : 1 (couple ${( -m1.teeth / m2.teeth ).toFixed(3)})`],
          ['Pitch Ø (Driver / Driven)', `${m1.pitchDiameterMm.toFixed(1)} / ${m2.pitchDiameterMm.toFixed(1)} mm`],
          ['Contact Ratio ε_α', `${m1.contactRatio.toFixed(2)}`],
          ['Profile Shift (x₁ / x₂)', `${m1.profileShift.toFixed(2)} / ${m2.profileShift.toFixed(2)}`],
          ['Backlash Allowance', `${backlashMm.toFixed(2)} mm`],
        ],
        statusOk: m1.contactRatio >= 1.2,
        statusText:
          m1.contactRatio >= 1.2
            ? `Continuous involute action verified (contact ratio ε_α = ${m1.contactRatio.toFixed(2)} ≥ 1.2).`
            : `Low contact ratio (ε_α = ${m1.contactRatio.toFixed(2)}); consider increasing tooth counts.`,
      };
    }

    if (family === 'rack_pinion') {
      const pSpec = {
        moduleMm,
        teeth: driverTeeth,
        pressureAngleDeg,
        thicknessMm,
        backlashMm,
        boreKind,
        boreDiameterMm,
      };
      const rSpec = {
        moduleMm,
        teeth: rackTeeth,
        pressureAngleDeg,
        thicknessMm,
        baseHeightMm: rackBaseHeightMm,
        backlashMm,
      };
      const pProf = buildInvoluteGearProfile(pSpec);
      const rProf = buildInvoluteRackProfile(rSpec);
      const pm = pProf.metrics;
      const rm = rProf.metrics;
      const pitchOffset = pm.pitchRadiusMm + moduleMm * pm.profileShift;
      const clockRad = rm.teeth % 2 === 1 ? -Math.PI / 2 + Math.PI / pm.teeth : -Math.PI / 2;
      const rotPinion = rotateLoop2D(pProf.outline, clockRad);

      const halfW = Math.max(rm.totalLengthMm * 0.56, pm.addendumRadiusMm * 1.4);
      const topY = pitchOffset + pm.addendumRadiusMm * 1.2;
      const botY = -(rm.dedendumMm + rm.baseHeightMm) * 1.3;

      return {
        viewBox: `${-halfW} ${-topY} ${halfW * 2} ${topY - botY}`,
        paths: [
          {
            d:
              loopToSvgPath(rotPinion, 0, pitchOffset) +
              (pProf.bore ? ' ' + loopToSvgPath(pProf.bore, 0, pitchOffset) : ''),
            fill: 'rgba(59, 130, 246, 0.25)',
            stroke: '#3b82f6',
          },
          {
            d: loopToSvgPath(rProf.outline, 0, 0),
            fill: 'rgba(100, 116, 139, 0.28)',
            stroke: '#64748b',
          },
        ],
        pitchCircles: [{ cx: 0, cy: -pitchOffset, r: pm.pitchRadiusMm }],
        readouts: [
          ['Pinion Pitch Ø', `${pm.pitchDiameterMm.toFixed(2)} mm`],
          ['Linear Pitch p', `${rm.circularPitchMm.toFixed(2)} mm`],
          ['Travel / Revolution', `${(rm.circularPitchMm * pm.teeth).toFixed(2)} mm/rev`],
          ['Rack Total Length', `${rm.totalLengthMm.toFixed(1)} mm`],
          ['Coupling Ratio', `${(pm.pitchRadiusMm / 1000).toFixed(5)} m/rad`],
          ['Rack Height', `${rm.totalHeightMm.toFixed(2)} mm`],
        ],
        statusOk: true,
        statusText: `Pinion pitch circle tangent to rack pitch line (y = 0) with ${backlashMm.toFixed(2)} mm backlash.`,
      };
    }

    if (family === 'gt2_belt') {
      const m1 = gt2PulleyMetrics({ teeth: gt2DriverTeeth, beltWidthMm: gt2BeltWidthMm, boreDiameterMm });
      const m2 = gt2PulleyMetrics({ teeth: gt2DrivenTeeth, beltWidthMm: gt2BeltWidthMm, boreDiameterMm });
      const p1 = buildGt2PulleyProfile({ teeth: gt2DriverTeeth, beltWidthMm: gt2BeltWidthMm, boreDiameterMm });
      const p2 = buildGt2PulleyProfile({ teeth: gt2DrivenTeeth, beltWidthMm: gt2BeltWidthMm, boreDiameterMm });
      const C = Math.max(m1.flangeRadiusMm + m2.flangeRadiusMm + 6, gt2CenterMm);
      const d1 = m1.pitchDiameterMm;
      const d2 = m2.pitchDiameterMm;
      const beltLen = 2 * C + (Math.PI / 2) * (d1 + d2) + ((d2 - d1) ** 2) / (4 * C);
      const beltTeeth = Math.round(beltLen / 2.0);
      const minX = -m1.flangeRadiusMm * 1.3;
      const maxX = C + m2.flangeRadiusMm * 1.3;
      const maxR = Math.max(m1.flangeRadiusMm, m2.flangeRadiusMm) * 1.35;

      return {
        viewBox: `${minX} ${-maxR} ${maxX - minX} ${maxR * 2}`,
        paths: [
          {
            d: loopToSvgPath(p1.outline) + (p1.bore ? ' ' + loopToSvgPath(p1.bore) : ''),
            fill: 'rgba(148, 163, 184, 0.3)',
            stroke: '#64748b',
          },
          {
            d: loopToSvgPath(p2.outline, C, 0) + (p2.bore ? ' ' + loopToSvgPath(p2.bore, C, 0) : ''),
            fill: 'rgba(148, 163, 184, 0.3)',
            stroke: '#64748b',
          },
        ],
        pitchCircles: [
          { cx: 0, cy: 0, r: m1.pitchRadiusMm },
          { cx: C, cy: 0, r: m2.pitchRadiusMm },
        ],
        readouts: [
          ['Driver Pitch Ø', `${m1.pitchDiameterMm.toFixed(2)} mm (${gt2DriverTeeth}T)`],
          ['Driven Pitch Ø', `${m2.pitchDiameterMm.toFixed(2)} mm (${gt2DrivenTeeth}T)`],
          ['Center Distance C', `${C.toFixed(1)} mm`],
          ['Belt Loop Length', `${beltLen.toFixed(1)} mm (~${beltTeeth}T GT2)`],
          ['Drive Ratio', `${(gt2DrivenTeeth / gt2DriverTeeth).toFixed(3)} : 1`],
          ['Coupling Ratio', `+${(gt2DriverTeeth / gt2DrivenTeeth).toFixed(4)}`],
        ],
        statusOk: true,
        statusText: `GT2-2mm synchronous belt drive: both pulleys rotate in the same direction (+z₁/z₂).`,
      };
    }

    if (family === 'leadscrew') {
      const starts = Math.max(1, Math.round(screwLeadMm / screwPitchMm));
      const coupleRatio = (screwLeadMm / 1000) / (2 * Math.PI);
      const halfL = screwLengthMm / 2;
      return {
        viewBox: `${-halfL * 1.1} -24 ${screwLengthMm * 1.1} 48`,
        paths: [
          {
            d: `M ${-halfL} -4 L ${halfL} -4 L ${halfL} 4 L ${-halfL} 4 Z`,
            fill: 'rgba(148, 163, 184, 0.35)',
            stroke: '#64748b',
          },
          {
            d: `M -7.5 -11 L 7.5 -11 L 7.5 11 L -7.5 11 Z`,
            fill: 'rgba(234, 179, 8, 0.35)',
            stroke: '#ca8a04',
          },
        ],
        pitchCircles: [],
        readouts: [
          ['Screw Spec', `T8 × ${screwLeadMm} mm (${starts}-start, ${screwPitchMm} mm pitch)`],
          ['Linear Advance', `${screwLeadMm.toFixed(1)} mm / rev`],
          ['Usable Stroke', `${Math.max(10, screwLengthMm - 25).toFixed(0)} mm`],
          ['Mechanical Advantage', `${((2 * Math.PI * 1000) / screwLeadMm).toFixed(0)} N per N·m`],
          ['Coupling Ratio', `${coupleRatio.toFixed(6)} m/rad`],
          ['Nut Flange', `Ø22 mm brass, 4× M3 mount`],
        ],
        statusOk: true,
        statusText: `T8 trapezoidal leadscrew with child brass flanged nut carriage coupled at ${screwLeadMm} mm/rev.`,
      };
    }

    if (family === 'cam_follower') {
      const prof = buildCamProfile({
        kind: camKind,
        baseRadiusMm: camBaseRadiusMm,
        liftMm: camLiftMm,
        thicknessMm,
        boreKind,
        boreDiameterMm,
      });
      const maxR = prof.maxRadiusMm * 1.3;
      return {
        viewBox: `${-maxR} ${-maxR} ${maxR * 2} ${maxR * 2}`,
        paths: [
          {
            d:
              loopToSvgPath(prof.outline) +
              (prof.bore ? ' ' + loopToSvgPath(prof.bore) : ''),
            fill: 'rgba(16, 185, 129, 0.25)',
            stroke: '#10b981',
          },
        ],
        pitchCircles: [{ cx: 0, cy: 0, r: prof.baseRadiusMm }],
        readouts: [
          ['Cam Profile', camKind.toUpperCase()],
          ['Base Radius r₀', `${prof.baseRadiusMm.toFixed(1)} mm`],
          ['Max Lift Stroke', `${prof.liftMm.toFixed(1)} mm`],
          ['Max Cam Radius', `${prof.maxRadiusMm.toFixed(1)} mm`],
          ['Face Thickness', `${prof.thicknessMm.toFixed(1)} mm`],
          ['Follower Axis', `+Y Slide Joint`],
        ],
        statusOk: true,
        statusText: `Watertight ${camKind} cam profile with paired sliding roller follower.`,
      };
    }

    // 4-Bar Linkage
    const fb = fourBarMetrics({
      groundMm,
      crankMm,
      couplerMm,
      rockerMm,
      crankAngleDeg,
    });
    const { A, B, C, D } = fb.jointsXYMm;
    const xs = [A[0], B[0], C[0], D[0]];
    const ys = [A[1], B[1], C[1], D[1]];
    const pad = 18;
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;

    return {
      viewBox: `${minX} ${-maxY} ${maxX - minX} ${maxY - minY}`,
      paths: [
        {
          d: `M ${A[0]} ${-A[1]} L ${D[0]} ${-D[1]}`,
          fill: 'none',
          stroke: '#64748b',
        },
        {
          d: `M ${A[0]} ${-A[1]} L ${B[0]} ${-B[1]} L ${C[0]} ${-C[1]} L ${D[0]} ${-D[1]}`,
          fill: 'none',
          stroke: '#3b82f6',
        },
      ],
      pitchCircles: [
        { cx: A[0], cy: -A[1], r: 3 },
        { cx: B[0], cy: -B[1], r: 3 },
        { cx: C[0], cy: -C[1], r: 3 },
        { cx: D[0], cy: -D[1], r: 3 },
      ],
      readouts: [
        ['Classification', fb.classification.replace('_', '-').toUpperCase()],
        ['Grashof Condition', fb.isGrashof ? `Grashof (margin +${fb.grashofMarginMm.toFixed(1)} mm)` : `Non-Grashof (${fb.grashofMarginMm.toFixed(1)} mm)`],
        ['Transmission Angle γ', `${fb.transmissionAngleMinDeg.toFixed(1)}° .. ${fb.transmissionAngleMaxDeg.toFixed(1)}°`],
        ['Shortest / Longest', `${fb.shortestMm.toFixed(0)} mm / ${fb.longestMm.toFixed(0)} mm`],
        ['Pin C Position', `(${C[0].toFixed(1)}, ${C[1].toFixed(1)}) mm`],
        ['Loop Closure', `MuJoCo <connect> at Pin C`],
      ],
      statusOk: fb.validAssembly && fb.transmissionAngleMinDeg >= 30,
      statusText: !fb.validAssembly
        ? 'Link lengths violate triangle inequality and cannot close a loop.'
        : fb.classification === 'crank_rocker'
          ? `Crank-rocker: input crank rotates a full 360° while output rocker oscillates (γ = ${fb.transmissionAngleMinDeg.toFixed(0)}°–${fb.transmissionAngleMaxDeg.toFixed(0)}°).`
          : `Valid 4-bar linkage (${fb.classification.replace('_', ' ')}).`,
    };
  }, [
    family,
    gearMode,
    moduleMm,
    driverTeeth,
    drivenTeeth,
    pressureAngleDeg,
    thicknessMm,
    backlashMm,
    boreKind,
    boreDiameterMm,
    rackTeeth,
    rackBaseHeightMm,
    gt2DriverTeeth,
    gt2DrivenTeeth,
    gt2CenterMm,
    gt2BeltWidthMm,
    screwLengthMm,
    screwLeadMm,
    screwPitchMm,
    camKind,
    camBaseRadiusMm,
    camLiftMm,
    groundMm,
    crankMm,
    couplerMm,
    rockerMm,
    crankAngleDeg,
  ]);

  if (!isOpen) return null;

  const handleInsert = () => {
    const newScene = cloneSceneGraph(sceneGraph);
    let addedNodes;

    if (family === 'gear_pair') {
      const dSpec = {
        moduleMm,
        teeth: driverTeeth,
        pressureAngleDeg,
        thicknessMm,
        backlashMm,
        boreKind,
        boreDiameterMm,
      };
      if (gearMode === 'single') {
        const node = buildInvoluteGearNode(dSpec, { actuated: actuateDriver });
        addedNodes = [node];
      } else {
        const nSpec = {
          moduleMm,
          teeth: drivenTeeth,
          pressureAngleDeg,
          thicknessMm,
          backlashMm,
          boreKind,
          boreDiameterMm,
        };
        const pair = buildMeshingGearPair(dSpec, nSpec, { actuateDriver });
        addedNodes = pair.nodes;
      }
    } else if (family === 'rack_pinion') {
      const res = buildRackAndPinionPair(
        {
          moduleMm,
          teeth: driverTeeth,
          pressureAngleDeg,
          thicknessMm,
          backlashMm,
          boreKind,
          boreDiameterMm,
        },
        {
          moduleMm,
          teeth: rackTeeth,
          pressureAngleDeg,
          thicknessMm,
          baseHeightMm: rackBaseHeightMm,
          backlashMm,
        },
        { actuatePinion: actuateDriver },
      );
      addedNodes = res.nodes;
    } else if (family === 'gt2_belt') {
      const res = buildGt2BeltDrive({
        driverTeeth: gt2DriverTeeth,
        drivenTeeth: gt2DrivenTeeth,
        centerDistanceMm: gt2CenterMm,
        beltWidthMm: gt2BeltWidthMm,
        boreDiameterMm,
        actuateDriver,
      });
      addedNodes = res.nodes;
    } else if (family === 'leadscrew') {
      const res = buildLeadscrewDrive({
        lengthMm: screwLengthMm,
        leadMm: screwLeadMm,
        pitchMm: screwPitchMm,
        actuateScrew: actuateDriver,
      });
      addedNodes = res.nodes;
    } else if (family === 'cam_follower') {
      const res = buildCamMechanism({
        kind: camKind,
        baseRadiusMm: camBaseRadiusMm,
        liftMm: camLiftMm,
        thicknessMm,
        boreKind,
        boreDiameterMm,
        actuateCam: actuateDriver,
      });
      addedNodes = res.nodes;
    } else {
      const res = buildFourBarLinkage(
        {
          groundMm,
          crankMm,
          couplerMm,
          rockerMm,
          crankAngleDeg,
          thicknessMm,
        },
        { actuateCrank: actuateDriver },
      );
      addedNodes = res.nodes;
    }

    newScene.nodes = [...newScene.nodes, ...addedNodes];
    updateScene(newScene);
    if (addedNodes[0]) setSelectedNodeId(addedNodes[0].id);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-4xl max-h-[92dvh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-lg">
              <Cog className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                Mechanism & Transmission Synthesis
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                True involute gears, racks, GT2 belt drives, T8 leadscrews, cams, and Grashof 4-bar linkages with automatic MuJoCo coupling
              </p>
            </div>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Family Picker */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Mechanism Family</h3>
            <Segmented
              value={family}
              onChange={(v) => setFamily(v as MechanismFamily)}
              options={FAMILY_OPTIONS}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Parameters Column */}
            <div className="lg:col-span-7 space-y-4">
              {family === 'gear_pair' && (
                <div className={sectionClass}>
                  <div className="flex items-center justify-between">
                    <h3 className={sectionTitleClass}>Involute Spur Gear Parameters</h3>
                    <Segmented
                      value={gearMode}
                      onChange={(v) => setGearMode(v as 'pair' | 'single')}
                      options={[
                        ['pair', 'Meshing Pair'],
                        ['single', 'Single Gear'],
                      ]}
                    />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <Field label="Module m (mm)" hint="ISO metric gear module (pitch diameter d = m × z).">
                      <select
                        value={moduleMm}
                        onChange={(e) => setModuleMm(Number(e.target.value))}
                        className={inputClass}
                      >
                        {STANDARD_MODULES_MM.map((m) => (
                          <option key={m} value={m}>
                            M{m} ({(m * Math.PI).toFixed(2)} mm pitch)
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Driver Teeth z₁" hint="Number of teeth on the driving gear (minimum 6).">
                      <NumberInput
                        step={1}
                        min={6}
                        max={120}
                        value={driverTeeth}
                        onChange={(v) => v !== undefined && setDriverTeeth(Math.max(6, Math.round(v)))}
                        className={inputClass}
                      />
                    </Field>
                    {gearMode === 'pair' && (
                      <Field label="Driven Teeth z₂" hint="Number of teeth on the meshing driven gear.">
                        <NumberInput
                          step={1}
                          min={6}
                          max={120}
                          value={drivenTeeth}
                          onChange={(v) => v !== undefined && setDrivenTeeth(Math.max(6, Math.round(v)))}
                          className={inputClass}
                        />
                      </Field>
                    )}
                    <Field label="Pressure Angle α (°)" hint="Standard involute pressure angle (20° standard, 14.5° legacy, 25° high strength).">
                      <NumberInput
                        step={0.5}
                        min={14.5}
                        max={25}
                        value={pressureAngleDeg}
                        onChange={(v) => v !== undefined && setPressureAngleDeg(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Face Width (mm)" hint="Axial thickness of the extruded gear.">
                      <NumberInput
                        step={1}
                        min={2}
                        max={50}
                        value={thicknessMm}
                        onChange={(v) => v !== undefined && setThicknessMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Backlash (mm)" hint="Circumferential tooth thinning for 3D printing clearance.">
                      <NumberInput
                        step={0.05}
                        min={0}
                        max={0.6}
                        value={backlashMm}
                        onChange={(v) => v !== undefined && setBacklashMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Shaft Bore" hint="Center mounting bore geometry.">
                      <select
                        value={boreKind}
                        onChange={(e) => setBoreKind(e.target.value as GearBoreKind)}
                        className={inputClass}
                      >
                        {BORE_OPTIONS.map(([val, label]) => (
                          <option key={val} value={val}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {boreKind !== 'none' && boreKind !== 'bearing_608' && (
                      <Field label="Bore Ø (mm)" hint="Shaft hole diameter (5 mm for NEMA17 stepper).">
                        <NumberInput
                          step={0.5}
                          min={2}
                          max={30}
                          value={boreDiameterMm}
                          onChange={(v) => v !== undefined && setBoreDiameterMm(v)}
                          className={inputClass}
                        />
                      </Field>
                    )}
                  </div>
                </div>
              )}

              {family === 'rack_pinion' && (
                <div className={sectionClass}>
                  <h3 className={sectionTitleClass}>Involute Rack & Pinion Parameters</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <Field label="Module m (mm)">
                      <select
                        value={moduleMm}
                        onChange={(e) => setModuleMm(Number(e.target.value))}
                        className={inputClass}
                      >
                        {STANDARD_MODULES_MM.map((m) => (
                          <option key={m} value={m}>
                            M{m}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Pinion Teeth z">
                      <NumberInput
                        step={1}
                        min={6}
                        max={80}
                        value={driverTeeth}
                        onChange={(v) => v !== undefined && setDriverTeeth(Math.max(6, Math.round(v)))}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Rack Teeth Count">
                      <NumberInput
                        step={1}
                        min={4}
                        max={60}
                        value={rackTeeth}
                        onChange={(v) => v !== undefined && setRackTeeth(Math.max(4, Math.round(v)))}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Face Width (mm)">
                      <NumberInput
                        step={1}
                        min={2}
                        max={40}
                        value={thicknessMm}
                        onChange={(v) => v !== undefined && setThicknessMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Rack Base Height (mm)">
                      <NumberInput
                        step={1}
                        min={3}
                        max={30}
                        value={rackBaseHeightMm}
                        onChange={(v) => v !== undefined && setRackBaseHeightMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Backlash (mm)">
                      <NumberInput
                        step={0.05}
                        min={0}
                        max={0.5}
                        value={backlashMm}
                        onChange={(v) => v !== undefined && setBacklashMm(v)}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                </div>
              )}

              {family === 'gt2_belt' && (
                <div className={sectionClass}>
                  <h3 className={sectionTitleClass}>GT2-2mm Synchronous Belt Drive</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <Field label="Driver Pulley Teeth">
                      <NumberInput
                        step={1}
                        min={12}
                        max={80}
                        value={gt2DriverTeeth}
                        onChange={(v) => v !== undefined && setGt2DriverTeeth(Math.max(12, Math.round(v)))}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Driven Pulley Teeth">
                      <NumberInput
                        step={1}
                        min={12}
                        max={100}
                        value={gt2DrivenTeeth}
                        onChange={(v) => v !== undefined && setGt2DrivenTeeth(Math.max(12, Math.round(v)))}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Center Distance C (mm)">
                      <NumberInput
                        step={2}
                        min={25}
                        max={300}
                        value={gt2CenterMm}
                        onChange={(v) => v !== undefined && setGt2CenterMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Belt Width (mm)">
                      <NumberInput
                        step={1}
                        min={4}
                        max={15}
                        value={gt2BeltWidthMm}
                        onChange={(v) => v !== undefined && setGt2BeltWidthMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Shaft Bore Ø (mm)">
                      <NumberInput
                        step={0.5}
                        min={3}
                        max={12}
                        value={boreDiameterMm}
                        onChange={(v) => v !== undefined && setBoreDiameterMm(v)}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                </div>
              )}

              {family === 'leadscrew' && (
                <div className={sectionClass}>
                  <h3 className={sectionTitleClass}>T8 Trapezoidal Leadscrew & Nut</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <Field label="Screw Length (mm)">
                      <NumberInput
                        step={10}
                        min={60}
                        max={600}
                        value={screwLengthMm}
                        onChange={(v) => v !== undefined && setScrewLengthMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Lead (mm / rev)" hint="2 mm (1-start), 4 mm (2-start), or 8 mm (4-start).">
                      <select
                        value={screwLeadMm}
                        onChange={(e) => setScrewLeadMm(Number(e.target.value))}
                        className={inputClass}
                      >
                        <option value={2}>2 mm (High Force, 1-Start)</option>
                        <option value={4}>4 mm (Balanced, 2-Start)</option>
                        <option value={8}>8 mm (Fast Travel, 4-Start)</option>
                      </select>
                    </Field>
                    <Field label="Thread Pitch (mm)">
                      <NumberInput
                        step={0.5}
                        min={1}
                        max={4}
                        value={screwPitchMm}
                        onChange={(v) => v !== undefined && setScrewPitchMm(v)}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                </div>
              )}

              {family === 'cam_follower' && (
                <div className={sectionClass}>
                  <h3 className={sectionTitleClass}>Cam & Follower Synthesis</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <Field className="col-span-2 sm:col-span-3" label="Motion Law / Cam Profile">
                      <Segmented
                        value={camKind}
                        onChange={(v) => setCamKind(v as CamProfileKind)}
                        options={CAM_OPTIONS}
                      />
                    </Field>
                    <Field label="Base Radius r₀ (mm)">
                      <NumberInput
                        step={1}
                        min={8}
                        max={60}
                        value={camBaseRadiusMm}
                        onChange={(v) => v !== undefined && setCamBaseRadiusMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Follower Lift (mm)">
                      <NumberInput
                        step={1}
                        min={2}
                        max={40}
                        value={camLiftMm}
                        onChange={(v) => v !== undefined && setCamLiftMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Thickness (mm)">
                      <NumberInput
                        step={1}
                        min={3}
                        max={30}
                        value={thicknessMm}
                        onChange={(v) => v !== undefined && setThicknessMm(v)}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                </div>
              )}

              {family === 'four_bar' && (
                <div className={sectionClass}>
                  <h3 className={sectionTitleClass}>Planar Grashof 4-Bar Linkage</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <Field label="Ground Link d (mm)">
                      <NumberInput
                        step={2}
                        min={15}
                        max={250}
                        value={groundMm}
                        onChange={(v) => v !== undefined && setGroundMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Input Crank a (mm)">
                      <NumberInput
                        step={2}
                        min={10}
                        max={200}
                        value={crankMm}
                        onChange={(v) => v !== undefined && setCrankMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Coupler Link b (mm)">
                      <NumberInput
                        step={2}
                        min={15}
                        max={250}
                        value={couplerMm}
                        onChange={(v) => v !== undefined && setCouplerMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Output Rocker c (mm)">
                      <NumberInput
                        step={2}
                        min={15}
                        max={250}
                        value={rockerMm}
                        onChange={(v) => v !== undefined && setRockerMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Crank Angle θ (°)">
                      <NumberInput
                        step={5}
                        min={0}
                        max={360}
                        value={crankAngleDeg}
                        onChange={(v) => v !== undefined && setCrankAngleDeg(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Link Thickness (mm)">
                      <NumberInput
                        step={1}
                        min={3}
                        max={20}
                        value={thicknessMm}
                        onChange={(v) => v !== undefined && setThicknessMm(v)}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                </div>
              )}

              {/* Engineering Readouts */}
              <div className={sectionClass}>
                <h3 className={sectionTitleClass}>Engineering Readouts</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {preview.readouts.map(([label, val]) => (
                    <div
                      key={label}
                      className="p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
                    >
                      <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
                      <div className="text-xs font-mono font-bold text-slate-800 dark:text-slate-100 mt-0.5">
                        {val}
                      </div>
                    </div>
                  ))}
                </div>
                <div
                  className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg border ${
                    preview.statusOk
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
                      : 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300'
                  }`}
                >
                  {preview.statusOk ? (
                    <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  )}
                  <span>{preview.statusText}</span>
                </div>
              </div>
            </div>

            {/* 2D SVG Profile Blueprint Column */}
            <div className="lg:col-span-5 flex flex-col">
              <div className={`${sectionClass} flex-1 flex flex-col`}>
                <div className="flex items-center justify-between">
                  <h3 className={sectionTitleClass}>2D Profile & Pitch Line Preview</h3>
                  <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={actuateDriver}
                      onChange={(e) => setActuateDriver(e.target.checked)}
                      className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    Drive with velocity motor
                  </label>
                </div>
                <div className="flex-1 min-h-[240px] rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center p-3">
                  <svg
                    viewBox={preview.viewBox}
                    className="w-full h-60"
                    preserveAspectRatio="xMidYMid meet"
                  >
                    {preview.paths.map((p, idx) => (
                      <path
                        key={idx}
                        d={p.d}
                        fill={p.fill}
                        stroke={p.stroke}
                        strokeWidth="0.6%"
                        fillRule="evenodd"
                      />
                    ))}
                    {preview.pitchCircles.map((c, idx) => (
                      <circle
                        key={idx}
                        cx={c.cx}
                        cy={c.cy}
                        r={c.r}
                        fill="none"
                        stroke="#22d3ee"
                        strokeDasharray="1.5 1.5"
                        strokeWidth="0.45%"
                      />
                    ))}
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/60"
          >
            Cancel
          </button>
          <button
            onClick={handleInsert}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Insert Mechanism into Scene
          </button>
        </div>
      </div>
    </div>
  );
};

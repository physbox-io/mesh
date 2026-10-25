import React from 'react';
import { useStore } from '../../store/useStore';
import { useDialogs } from '../../store/dialogStore';
import type { JoinKind } from '../../utils/extrusionParts';
import { HARDWARE_PARTS } from '../../utils/hardwareParts';
import { getNodeWorldPos } from '../../utils/sceneTree';
import { PaletteTile, type TileSpin } from './PaletteTile';

// Steel-grey line drawings, one per tile: a section, a nut, a bracket, a
// plate, a screw, a carriage.
const svg = (children: React.ReactNode) => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" strokeLinejoin="round">{children}</svg>
);
const line = 'stroke-slate-600 dark:stroke-slate-300';
const fill = 'fill-slate-200 dark:fill-slate-700';

const ProfileIcon = () => svg(
  <path d="M3 3 H9.5 V5.5 H8 V8 H16 V5.5 H14.5 V3 H21 V9.5 H18.5 V8 H16 V16 H18.5 V14.5 H21 V21 H14.5 V18.5 H16 V16 H8 V18.5 H9.5 V21 H3 V14.5 H5.5 V16 H8 V8 H5.5 V9.5 H3 Z" className={`${fill} ${line}`} strokeWidth="1.1" />,
);
const VSlotIcon = () => svg(
  <path d="M3 3 H8.5 L10.5 5.5 H13.5 L15.5 3 H21 V8.5 L18.5 10.5 V13.5 L21 15.5 V21 H15.5 L13.5 18.5 H10.5 L8.5 21 H3 V15.5 L5.5 13.5 V10.5 L3 8.5 Z" className={`${fill} ${line}`} strokeWidth="1.1" />,
);
const TNutIcon = () => svg(<>
  <path d="M4 9 H20 V14 H15 V17 H9 V14 H4 Z" className={`${fill} ${line}`} strokeWidth="1.1" />
  <circle cx="12" cy="11.5" r="1.8" className={line} strokeWidth="1" />
</>);
const BracketIcon = () => svg(<>
  <path d="M5 4 V19 H20 V15.5 H8.5 V4 Z" className={`${fill} ${line}`} strokeWidth="1.1" />
  <path d="M8.5 12 L12 15.5" className={line} strokeWidth="1.4" />
</>);
const PlateIcon = () => svg(<>
  <path d="M4 4 H10 V14 H20 V20 H4 Z" className={`${fill} ${line}`} strokeWidth="1.1" />
  {[[7, 7], [7, 11], [7, 17], [13, 17], [17, 17]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.1" className={line} strokeWidth="0.9" />)}
</>);
const EndTapIcon = () => svg(<>
  <rect x="9" y="3" width="6" height="4" rx="1.5" className={`${fill} ${line}`} strokeWidth="1.1" />
  <path d="M10.5 7 V21 H13.5 V7" className={`${fill} ${line}`} strokeWidth="1.1" />
</>);
const CarriageIcon = () => svg(<>
  <rect x="3" y="6" width="18" height="5" rx="1" className={`${fill} ${line}`} strokeWidth="1.1" />
  {[7, 17].map((x) => <circle key={x} cx={x} cy={15.5} r="3" className={line} strokeWidth="1.2" />)}
  <path d="M2 19.5 H22" className={line} strokeWidth="1.4" />
</>);

interface Tile { label: string; title: string; spin: TileSpin; Icon: () => React.JSX.Element; onClick: () => void }

/**
 * The extrusion group of the palette: profiles, a T-nut and a carriage stand
 * on their own; a bracket, a plate or an end-tap screw joins the two profiles
 * selected, where they meet, and says so when they do not.
 */
export function ExtrusionTiles({ onDone }: { onDone: () => void }) {
  const showNotice = useDialogs((s) => s.showNotice);

  const near = (): number[] => {
    const { selectedNodeId, sceneGraph } = useStore.getState();
    const at = selectedNodeId ? getNodeWorldPos(sceneGraph.nodes, selectedNodeId) : null;
    return at ? [at[0] + 0.05, at[1], at[2]] : [0, 0, 0.03];
  };
  const addProfile = (size: string) => {
    const store = useStore.getState();
    // Not into the selection: a profile is a part of its own.
    const id = store.addHardwarePart('extrusion', near(), null);
    if (id && size !== HARDWARE_PARTS.extrusion.defaultSize) useStore.getState().setHardwarePart(id, { size });
    onDone();
  };
  const join = (kind: JoinKind) => {
    const { selectedNodeId, extraSelectedIds } = useStore.getState();
    const other = extraSelectedIds[0];
    if (!selectedNodeId || !other) {
      showNotice(`Select two profiles for the ${HARDWARE_PARTS[kind].label.toLowerCase()}`, 'Pick one, then Shift-click the one it meets: the joint goes where they meet.');
      return;
    }
    const r = useStore.getState().joinProfiles(selectedNodeId, other, kind);
    if ('problem' in r) showNotice('These two cannot be joined there', r.problem);
    else onDone();
  };
  const carriage = () => {
    const { selectedNodeId } = useStore.getState();
    const r = selectedNodeId ? useStore.getState().addCarriage(selectedNodeId) : { problem: 'Select the V-slot 2020 profile it runs on first.' };
    if ('problem' in r) showNotice('No V-slot to run on', r.problem);
    else onDone();
  };

  const tiles: Tile[] = [
    { label: 'Profile', title: HARDWARE_PARTS.extrusion.hint, spin: 'group-hover:rotate-6', Icon: ProfileIcon, onClick: () => addProfile('2020') },
    { label: 'V-slot', title: 'V-slot 2020 extrusion, for wheel carriages to run along.', spin: 'group-hover:-rotate-6', Icon: VSlotIcon, onClick: () => addProfile('2020V') },
    { label: 'T-nut', title: HARDWARE_PARTS.tnut.hint, spin: 'group-hover:rotate-3', Icon: TNutIcon, onClick: () => { useStore.getState().addHardwarePart('tnut', near(), null); onDone(); } },
    { label: 'Corner Bracket', title: HARDWARE_PARTS.corner_bracket.hint, spin: 'group-hover:-rotate-3', Icon: BracketIcon, onClick: () => join('corner_bracket') },
    { label: 'Joint Plate', title: HARDWARE_PARTS.joint_plate.hint, spin: 'group-hover:rotate-3', Icon: PlateIcon, onClick: () => join('joint_plate') },
    { label: 'End-tap Screw', title: HARDWARE_PARTS.end_tap.hint, spin: 'group-hover:rotate-6', Icon: EndTapIcon, onClick: () => join('end_tap') },
    { label: 'V Carriage', title: HARDWARE_PARTS.vslot_carriage.hint, spin: 'group-hover:-rotate-3', Icon: CarriageIcon, onClick: carriage },
  ];

  return (
    <>
      <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500 mt-3 mb-2">
        Extrusion. A bracket, plate or end-tap screw joins the two profiles selected (Shift-click the second) where they meet.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {tiles.map((t) => (
          <PaletteTile key={t.label} button label={t.label} title={t.title} color="slate" spin={t.spin} icon={<t.Icon />} onClick={t.onClick} />
        ))}
      </div>
    </>
  );
}

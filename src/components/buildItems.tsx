import { BrickWall, ListChecks, PersonStanding, Puzzle, Scissors, Wrench } from 'lucide-react';
import type { BuildItem } from './BuildMenu';

/** The building methods, in the order a person would reach for them. */
export function buildItems(actions: {
  unfold?: () => void;
  pipes?: () => void;
  joinery?: () => void;
  brick?: () => void;
  dressForm?: () => void;
  partsList: () => void;
  hasHardware: boolean;
}): BuildItem[] {
  const icon = 'w-3.5 h-3.5';
  return [
    ...(actions.unfold
      ? [{ label: 'Papercraft & leather', hint: 'Unfold 3D shapes into flat 1:1 patterns with glue tabs, stitch holes or bend lines — print on A4/Letter for scissors & craft knife, or send to Etch.', icon: <Scissors className={icon} />, run: actions.unfold }]
      : []),
    ...(actions.pipes
      ? [{ label: 'Pipe frame', hint: 'Frame a shape in PVC, EMT or aluminium tube, with the cut list and printable hubs. Best for: shelters, carts, racks and greenhouses.', icon: <Wrench className={icon} />, run: actions.pipes }]
      : []),
    ...(actions.joinery
      ? [{ label: 'Timber frame', hint: 'Break a frame into mortise-and-tenon parts with a cut list, cut by bandsaw or router. Best for: tables, chairs, benches and stands.', icon: <Puzzle className={icon} />, run: actions.joinery }]
      : []),
    ...(actions.brick
      ? [{ label: 'Brick', hint: 'Lay a shape in brick, course by course, with the bricks to buy, the cuts, the mortar and the lintels. Best for: walls, piers, planters and barbecues.', icon: <BrickWall className={icon} />, run: actions.brick }]
      : []),
    ...(actions.dressForm
      ? [{ label: 'Dress form', hint: 'A tailor\'s dummy to make garments on, sized by tape measurements in its card. Its garments are in the left sidebar.', icon: <PersonStanding className={icon} />, run: actions.dressForm }]
      : []),
    {
      label: 'Parts list',
      hint: 'The hardware to buy, counted, with bar stock cut to length. Best for: the shopping list before a build.',
      icon: <ListChecks className={icon} />,
      run: actions.partsList,
      disabledReason: actions.hasHardware ? undefined : 'No bought hardware in the scene yet — add screws, bearings or bar stock from the left palette.',
    },
  ];
}

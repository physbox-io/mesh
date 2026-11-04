import { BrickWall, ListChecks, Puzzle, Wrench } from 'lucide-react';
import type { BuildItem } from './BuildMenu';

/** The building methods, in the order a person would reach for them. */
export function buildItems(actions: {
  pipes?: () => void;
  joinery?: () => void;
  brick?: () => void;
  partsList: () => void;
  hasHardware: boolean;
}): BuildItem[] {
  const icon = 'w-3.5 h-3.5';
  return [
    ...(actions.pipes
      ? [{ label: 'Pipe frame', hint: 'Frame a shape in PVC, EMT or aluminium tube, with the cut list and printable hubs. Best for: shelters, carts, racks and greenhouses.', icon: <Wrench className={icon} />, run: actions.pipes }]
      : []),
    ...(actions.joinery
      ? [{ label: 'Timber frame', hint: 'Break a frame into mortise-and-tenon parts with a cut list, cut by bandsaw or router. Best for: tables, chairs, benches and stands.', icon: <Puzzle className={icon} />, run: actions.joinery }]
      : []),
    ...(actions.brick
      ? [{ label: 'Brick', hint: 'Lay a shape in brick, course by course, with the bricks to buy, the cuts, the mortar and the lintels. Best for: walls, piers, planters and barbecues.', icon: <BrickWall className={icon} />, run: actions.brick }]
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

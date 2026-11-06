import { useCallback, useState } from 'react';
import { DEFAULT_GCODE_OPTIONS } from '../utils/gcodeExporter';
import { machineLaserMax, retargetLaserPowers, type LaserPowers, type SheetMachine } from '../utils/sheetCutRecipe';
import type { MachineState } from '../utils/webSerialManager';

/**
 * The laser power fields of an export dialog. The maximum S-value follows the
 * connected controller's `$30` until the operator picks one.
 */
export function useLaserPowers(machine: SheetMachine, machineState: MachineState) {
  const [powers, setPowers] = useState<LaserPowers>({
    max: DEFAULT_GCODE_OPTIONS.laserMaxPower,
    cut: DEFAULT_GCODE_OPTIONS.laserPower,
    engrave: DEFAULT_GCODE_OPTIONS.laserEngravePower,
  });
  const [operatorChose, setOperatorChose] = useState(false);

  const machineMax = machineLaserMax(machine, machineState, operatorChose);
  const [followedMax, setFollowedMax] = useState<number | null>(null);
  if (machineMax !== null && machineMax !== followedMax) {
    setFollowedMax(machineMax);
    setPowers((p) => retargetLaserPowers(p, machineMax));
  }

  const pickLaserMaxPower = useCallback((next: number) => {
    setOperatorChose(true);
    setPowers((p) => retargetLaserPowers(p, next));
  }, []);
  const setLaserPower = useCallback((cut: number) => setPowers((p) => ({ ...p, cut })), []);
  const setEngravePower = useCallback((engrave: number) => setPowers((p) => ({ ...p, engrave })), []);

  return {
    laserMaxPower: powers.max,
    laserPower: powers.cut,
    engravePower: powers.engrave,
    pickLaserMaxPower,
    setLaserPower,
    setEngravePower,
  };
}

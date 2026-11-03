// What the tooling and feeds of a surface job say about it before a line is cut.

import { materialSpec } from './feedsAndSpeeds';
import {
  vBitConeHeight,
  vBitHalfAngleRad,
  type CutterGeometry,
  type CutterTip,
  type ReliefCarveOptions,
} from './reliefOptions';
import { MAX_REACH_DIAMETERS, autoFluteLength, autoShankDia, chiploadMm } from './reliefTooling';

/** The finishing cutter's end, its radius and the stepover its passes are laid at. */
export function finishingCutter(opts: ReliefCarveOptions) {

  /** The finishing cutter's end, as the dilation and the warnings both see it. */
  const finishTip: CutterTip = {
    shape: opts.finishingToolType,
    vBitAngleDeg: opts.finishingVBitAngleDeg,
  };

  // The raster is inset by the finishing tool's radius so the cutter stays over
  // the stock, which is also the area a fitted model has to land inside.
  const finishRad = Math.max(0.05, opts.finishingToolDiaMm / 2);
  const stepover = Math.max(
    0.05,
    (opts.finishingToolDiaMm * Math.min(100, Math.max(2, opts.finishingStepoverPercent))) / 100
  );
  return { finishTip, finishRad, stepover };
}

/**
 * Warnings about the cutters, feeds and spindle speed for a cut `depthMm` deep,
 * pushed onto `warnings` in the order the operator should read them.
 */
export function warnAboutTooling(
  opts: ReliefCarveOptions,
  depthMm: number,
  noun: string,
  warnings: string[]
): void {
  const { finishTip, finishRad, stepover } = finishingCutter(opts);

  // These all turn on how deep the ${noun} actually ends up, which in
  // proportional mode is not the depth that was asked for, so they are defined
  // here and called once `depthMm` is known.
  //
  // A cutter has to reach the floor of the ${noun} with its flutes, not its
  // shank, and it goes soft long before it runs out of flute: bending stiffness
  // falls with the cube of stickout and the fourth power of diameter, so a bit
  // held four diameters out of the collet is already a wire. Catalogue flute
  // lengths for straight bits run about three diameters, so four is the point
  // past which no stock bit that size can do the job at all.
  const reachWarn = (
    dia: number,
    shankDia: number,
    fluteLen: number,
    which: string,
    tip?: CutterTip
  ) => {
    // Two different problems, and a bit can have either without the other.
    //
    // The geometric one is a shank fatter than the cutter having to follow it
    // into the cut. A necked or long-reach bit does not have it at all, which is
    // why this asks about the shank rather than about the depth. It is only
    // raised when nothing is going to account for it, because with shank
    // clearance on the path is held out of the wall instead.
    const shank = shankDia > 0 ? shankDia : autoShankDia(dia);
    const flutes = fluteLen > 0 ? fluteLen : autoFluteLength(dia, tip);
    if (!opts.toolBodyClearance && shank > dia + 1e-6 && depthMm > flutes) {
      warnings.push(
        `${dia} mm ${which} bit has ~${flutes.toFixed(1)} mm flute length on a ${shank.toFixed(3)} mm shank; ${depthMm.toFixed(1)} mm ${noun} depth exceeds flute length with shank clearance disabled.`
      );
    }

    // A V-bit is a solid cone rather than a slender cylinder, so the bending
    // rule below does not describe it. What does limit it is where the cone
    // stops: past the point it reaches its nominal diameter there is only
    // shank, so a relief deeper than that is being cut by the shank whatever
    // the catalogue says the bit is for.
    if (tip?.shape === 'v_bit') {
      const cone = vBitConeHeight(dia, tip.vBitAngleDeg ?? 60);
      if (depthMm > cone + 1e-6) {
        warnings.push(
          `${dia} mm ${tip.vBitAngleDeg ?? 60}° V-bit cone height is ${cone.toFixed(1)} mm (${noun} depth is ${depthMm.toFixed(1)} mm); use a wider V-bit, a narrower angle, or rough first.`
        );
      }
      return;
    }

    // The stiffness one is unavoidable at any depth: bending goes with the cube
    // of stickout, so a bit hung this far out chatters and wanders whatever its
    // shank looks like.
    const ratio = depthMm / Math.max(0.05, dia);
    if (ratio > MAX_REACH_DIAMETERS) {
      warnings.push(
        `${depthMm.toFixed(1)} mm ${noun} requires ${ratio.toFixed(1)}×D stickout on the ${dia} mm ${which} bit; use a ≥ ${(depthMm / MAX_REACH_DIAMETERS).toFixed(1)} mm cutter or reduce depth to avoid deflection.`
      );
    }
  };

  if (opts.finishingEnabled) {
    reachWarn(
      opts.finishingToolDiaMm,
      opts.finishingShankDiaMm,
      opts.finishingFluteLengthMm,
      'finishing',
      finishTip
    );
  }
  if (opts.roughingEnabled) {
    reachWarn(opts.roughingToolDiaMm, 0, 0, 'roughing');
  }

  // --- What the cutter's own specification implies --------------------------
  //
  // Flute count and helix direction are not labels on a drop-down. They are two
  // of the three numbers that decide whether the feed rate in this file is a
  // cut or a rub, and where the chips end up once it is.

  const material = materialSpec(opts.material);

  /** Feed, RPM and flutes are one quantity seen three ways; check the third. */
  const chiploadWarn = (feed: number, flutes: number, which: string, dia: number) => {
    const chip = chiploadMm(feed, opts.spindleRpm, flutes);
    // The band is the material's own, scaled to the bit. A generic one is worse
    // than useless here: 0.05 mm a tooth is a healthy chip in pine and roughly
    // four times what a cutter should be taking in aluminium.
    const ideal = material.chiploadPerDia * dia;
    const floor = ideal * 0.25;
    const ceiling = ideal * 2;
    if (chip < floor) {
      warnings.push(
        `${which} chipload is ${chip.toFixed(4)} mm/tooth (${feed} mm/min, ${opts.spindleRpm} RPM, ${Math.max(1, Math.round(flutes))} flutes), below the ${floor.toFixed(3)} mm minimum for a ${dia} mm cutter in ${material.label.toLowerCase()} (target ~${ideal.toFixed(3)} mm). Increase feedrate, lower RPM, or use fewer flutes to prevent rubbing.`
      );
    } else if (chip > ceiling) {
      warnings.push(
        `${which} chipload is ${chip.toFixed(3)} mm/tooth (${feed} mm/min, ${opts.spindleRpm} RPM, ${Math.max(1, Math.round(flutes))} flutes), above the ${ceiling.toFixed(3)} mm maximum for a ${dia} mm cutter in ${material.label.toLowerCase()}. Lower feedrate or increase RPM.`
      );
    }
  };

  // The spindle speed itself, which on these machines is a dial nobody is
  // prompted to turn. Checked against surface speed rather than left implicit
  // in the chipload, because "your feed is wrong" and "your dial is wrong" want
  // different actions from the operator.
  {
    const ideal = (material.surfaceSpeedMMin * 1000) / (Math.PI * Math.max(0.1, opts.finishingToolDiaMm));
    const capped = material.maxRpm !== undefined ? Math.min(ideal, material.maxRpm) : ideal;
    if (opts.spindleRpm > capped * 1.6) {
      warnings.push(
        `${opts.spindleRpm.toLocaleString()} RPM exceeds the recommended ~${Math.round(capped / 500) * 500} RPM for a ${opts.finishingToolDiaMm} mm cutter in ${material.label.toLowerCase()}` +
          (material.maxRpm !== undefined
            ? ` (risk of melting).`
            : ` (risk of rubbing and excess heat).`)
      );
    } else if (opts.spindleRpm < capped * 0.45) {
      warnings.push(
        `${opts.spindleRpm.toLocaleString()} RPM is below the recommended ~${Math.round(capped / 500) * 500} RPM for a ${opts.finishingToolDiaMm} mm cutter in ${material.label.toLowerCase()}, increasing chipload and tool deflection.`
      );
    }
  }

  if (opts.finishingEnabled) {
    chiploadWarn(opts.finishingFeedrate, opts.finishingFlutes, 'finishing', opts.finishingToolDiaMm);
  }
  if (opts.roughingEnabled) {
    chiploadWarn(opts.roughingFeedrate, opts.roughingFlutes, 'roughing', opts.roughingToolDiaMm);
  }

  /** What the helix direction means for a pocket this deep. */
  const geometryWarn = (geometry: CutterGeometry, dia: number, which: string) => {
    if (geometry === 'downcut' && depthMm > dia * 2) {
      warnings.push(
        `Downcut ${which} bit in a ${(depthMm / dia).toFixed(1)}×D deep ${noun} can pack chips; use an upcut bit for roughing deep pockets.`
      );
    }
    if (geometry === 'compression' && depthMm < 6) {
      warnings.push(
        `Compression ${which} bit in a ${depthMm.toFixed(1)} mm ${noun} cuts only within its lower upcut section.`
      );
    }
    if (geometry === 'straight' && depthMm > dia * 3) {
      warnings.push(
        `Straight-flute ${which} bit in a ${(depthMm / dia).toFixed(1)}×D deep ${noun} has no axial chip evacuation; use dust extraction or shallower passes.`
      );
    }
  };

  if (opts.finishingEnabled) {
    geometryWarn(opts.finishingGeometry, opts.finishingToolDiaMm, 'finishing');
  }
  if (opts.roughingEnabled) {
    geometryWarn(opts.roughingGeometry, opts.roughingToolDiaMm, 'roughing');
  }

  // A downcut cutter is at its very worst going straight down: the direction it
  // throws waste is the direction it is trying to travel.
  if (opts.finishingEnabled && opts.finishingGeometry === 'downcut' && opts.leadInAngleDeg <= 0) {
    warnings.push(
      `Downcut finishing bit with 0° lead-in plunges vertically and can pack chips under the tip; set a 10–20° lead-in angle.`
    );
  }

  // What the finishing stepover actually leaves behind between passes. This is
  // the number people mean by "how smooth will it be", and for a V-bit it is
  // not the ball-nose arithmetic the stepover box implies.
  const half = stepover / 2;
  const ridgeMm =
    opts.finishingToolType === 'flat'
      ? 0
      : opts.finishingToolType === 'v_bit'
        ? half / Math.tan(vBitHalfAngleRad(opts.finishingVBitAngleDeg))
        : half >= finishRad
          ? finishRad
          : finishRad - Math.sqrt(finishRad * finishRad - half * half);
  if (ridgeMm > 0.2) {
    warnings.push(
      `${stepover.toFixed(2)} mm stepover leaves ${ridgeMm.toFixed(2)} mm cusps between passes; ` +
        (opts.finishingToolType === 'v_bit'
          ? `reduce stepover or use a wider V-bit angle.`
          : `reduce stepover or use a larger ball-nose cutter.`)
    );
  }
}

/** '#rrggbb' -> the 0..1 triple a geom's rgba is written in. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** The 0..1 triple back to '#rrggbb', for a swatch and a colour input. */
export function rgbToHex(rgb: ArrayLike<number>): string {
  const channel = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v ?? 0)) * 255).toString(16).padStart(2, '0');
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

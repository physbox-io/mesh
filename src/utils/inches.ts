// Inch arithmetic for the quick reference's converter. Kept out of the
// component file, which may only export components for fast refresh to work.

/** Reads `0.3`, `3/16` or `1 1/2` as inches; null if it is none of those. */
export function parseInches(text: string): number | null {
  const m = text.trim().replace(/["”]|in$/i, '').trim()
    .match(/^(?:(\d+(?:\.\d+)?)\s+)?(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?$/);
  if (!m) return null;
  const [, whole, num, den] = m;
  if (den === undefined) return whole === undefined ? Number(num) : null;
  if (Number(den) === 0) return null;
  return (whole ? Number(whole) : 0) + Number(num) / Number(den);
}

/** Nearest 1/64 as a reduced fraction, e.g. 0.1875 → `3/16"`. */
export function nearestFraction(inch: number): string {
  let n = Math.round(inch * 64);
  let d = 64;
  while (n % 2 === 0 && d > 1) { n /= 2; d /= 2; }
  const whole = Math.floor(n / d);
  const rest = n % d;
  if (rest === 0) return `${whole}"`;
  return whole ? `${whole} ${rest}/${d}"` : `${rest}/${d}"`;
}

import type { GarmentTrim } from '../../types/cloth';

/** How much of its run a zip or a row of buttons is done up, from the bottom: 0 to 1 (`GarmentTrim.fastened`). */
export const doneUp = (trim: GarmentTrim) => (trim.fastened === false ? 0 : typeof trim.fastened === 'number' ? Math.max(0, Math.min(1, trim.fastened)) : 1);

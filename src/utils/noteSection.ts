// The scene's note card, one section at a time: tooling made again for the
// same part rewrites its own section instead of adding another.

import { physicsGlobals } from '../physicsGlobals';
import { dropSections, upsertSection } from './toolingReplace';

/** Puts `section` on the first note card (replacing the one with its heading), or starts a card with it. */
export function putNoteSection(section: string, newCardId: string, dropTitles: readonly string[] = []): void {
  const [card, ...rest] = physicsGlobals._physics_getNoteCards?.() ?? [];
  physicsGlobals._physics_setNoteCards?.(card
    ? [{ ...card, markdown: upsertSection(dropSections(card.markdown, dropTitles), section) }, ...rest]
    : [{ id: newCardId, markdown: section, minimized: true, x: 16, y: 16 }]);
}

/** Takes the sections headed by these titles off the first note card. */
export function dropNoteSections(titles: readonly string[]): void {
  if (!titles.length) return;
  const [card, ...rest] = physicsGlobals._physics_getNoteCards?.() ?? [];
  if (!card) return;
  const markdown = dropSections(card.markdown, titles);
  if (markdown !== card.markdown) physicsGlobals._physics_setNoteCards?.([{ ...card, markdown }, ...rest]);
}

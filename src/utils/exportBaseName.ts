import { PRESETS } from '../presets/presetScenes';
import type { NoteCard } from './noteCards';

/**
 * The scene's name, cleaned up into something that can be a filename: the
 * first note card's heading, else the preset's name, else `physics_scene`.
 */
export function exportBaseName(noteCards: NoteCard[], activePreset: string | undefined): string {
  let baseName = '';
  if (noteCards && noteCards.length > 0) {
    for (const card of noteCards) {
      if (card.markdown) {
        const match = card.markdown.match(/^\s*#\s+(.+)$/m);
        const heading = match ? match[1].replace(/[*_`]/g, '').trim() : '';
        // Not the new-card placeholder, or every export became note.stl.
        if (heading && heading !== 'Note') {
          baseName = heading;
          break;
        }
      }
    }
  }

  if (!baseName && activePreset) {
    if (activePreset.startsWith('user:')) {
      baseName = activePreset.replace('user:', '').trim();
    } else {
      const presetObj = PRESETS[activePreset as keyof typeof PRESETS] as { name?: string } | undefined;
      baseName = presetObj?.name || activePreset;
    }
  }

  if (!baseName) {
    baseName = 'physics_scene';
  }

  return baseName.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'physics_scene';
}

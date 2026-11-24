import { describe, it, expect, beforeEach } from 'vitest';
import { PRESETS } from '../src/presets/presetScenes';
import { sceneHasInstruments } from '../src/utils/sceneSound';
import { useSoundStore } from '../src/store/soundStore';
import type { SceneGraph } from '../src/types/scene';

type Entry = { scene?: SceneGraph; sound?: boolean };
const entries = Object.entries(PRESETS as Record<string, Entry>);

describe('scene sound', () => {
  it('every preset marked sound carries instrument bodies', () => {
    const marked = entries.filter(([, p]) => p.sound);
    expect(marked.length).toBeGreaterThanOrEqual(8);
    for (const [, p] of marked) expect(sceneHasInstruments(p.scene?.nodes)).toBe(true);
  });

  it('no unmarked preset would switch sound on by detection', () => {
    const detected = entries
      .filter(([, p]) => p.sound === undefined && sceneHasInstruments(p.scene?.nodes))
      .map(([k]) => k);
    expect(detected).toEqual([]);
  });

  it('finds an instrument nested in a child', () => {
    expect(sceneHasInstruments([
      { id: 'a', name: 'a', children: [{ id: 'b', name: 'b', tunedPitchHz: 440 }] },
    ] as unknown as SceneGraph['nodes'])).toBe(true);
    expect(sceneHasInstruments([{ id: 'a', name: 'a' }] as unknown as SceneGraph['nodes'])).toBe(false);
  });

  describe('applySceneSound', () => {
    beforeEach(() => useSoundStore.setState({ soundEnabled: false, soundAutoEnabled: false }));

    it('turns on for an instrument scene and off again on leaving it', () => {
      expect(useSoundStore.getState().applySceneSound(true)).toBe(true);
      expect(useSoundStore.getState().soundEnabled).toBe(true);
      useSoundStore.getState().applySceneSound(true);
      expect(useSoundStore.getState().soundEnabled).toBe(true);
      useSoundStore.getState().applySceneSound(false);
      expect(useSoundStore.getState().soundEnabled).toBe(false);
    });

    it("leaves the user's own choice alone", () => {
      useSoundStore.getState().setSoundEnabled(true);
      useSoundStore.getState().applySceneSound(false);
      expect(useSoundStore.getState().soundEnabled).toBe(true);

      // Switched on by a scene, then kept on by hand: stays on.
      useSoundStore.setState({ soundEnabled: false, soundAutoEnabled: false });
      useSoundStore.getState().applySceneSound(true);
      useSoundStore.getState().toggleSound();
      useSoundStore.getState().toggleSound();
      useSoundStore.getState().applySceneSound(false);
      expect(useSoundStore.getState().soundEnabled).toBe(true);
    });

    it('does not force sound on after the user muted an instrument scene', () => {
      useSoundStore.getState().applySceneSound(true);
      useSoundStore.getState().toggleSound();
      useSoundStore.getState().applySceneSound(false);
      expect(useSoundStore.getState().soundEnabled).toBe(false);
    });
  });
});

import { create } from 'zustand';

interface SoundState {
  /** Off by default so simulation is completely silent until toggled in the header. */
  soundEnabled: boolean;
  /**
   * Sound is on because a scene asked for it (see applySceneSound), not
   * because the user switched it on. Only then does leaving that scene for
   * one that does not ask turn it back off; any manual toggle clears it.
   */
  soundAutoEnabled: boolean;
  /** Studio room reverb on the shared master bus (on by default; individual 3D body FIRs stay active either way). */
  reverbEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
  toggleSound: () => void;
  /**
   * A scene has loaded: on if it wants sound, and back off on leaving it
   * if it was the scene that switched it on. A user's own choice stands.
   * Returns true when this call switched sound on.
   */
  applySceneSound: (wantsSound: boolean) => boolean;
  setReverbEnabled: (enabled: boolean) => void;
  toggleReverb: () => void;
}

export const useSoundStore = create<SoundState>((set, get) => ({
  soundEnabled: false,
  soundAutoEnabled: false,
  reverbEnabled: true,
  setSoundEnabled: (enabled) => set({ soundEnabled: enabled, soundAutoEnabled: false }),
  toggleSound: () => set((s) => ({ soundEnabled: !s.soundEnabled, soundAutoEnabled: false })),
  applySceneSound: (wantsSound) => {
    const { soundEnabled, soundAutoEnabled } = get();
    if (wantsSound && !soundEnabled) {
      set({ soundEnabled: true, soundAutoEnabled: true });
      return true;
    }
    if (!wantsSound && soundEnabled && soundAutoEnabled) {
      set({ soundEnabled: false, soundAutoEnabled: false });
    }
    return false;
  },
  setReverbEnabled: (enabled) => set({ reverbEnabled: enabled }),
  toggleReverb: () => set((s) => ({ reverbEnabled: !s.reverbEnabled })),
}));

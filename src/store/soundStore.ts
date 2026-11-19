import { create } from 'zustand';

interface SoundState {
  /** Off by default so simulation is completely silent until toggled in the header. */
  soundEnabled: boolean;
  /** Studio room reverb on the shared master bus (on by default; individual 3D body FIRs stay active either way). */
  reverbEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
  toggleSound: () => void;
  setReverbEnabled: (enabled: boolean) => void;
  toggleReverb: () => void;
}

export const useSoundStore = create<SoundState>((set) => ({
  soundEnabled: false,
  reverbEnabled: true,
  setSoundEnabled: (enabled) => set({ soundEnabled: enabled }),
  toggleSound: () => set((s) => ({ soundEnabled: !s.soundEnabled })),
  setReverbEnabled: (enabled) => set({ reverbEnabled: enabled }),
  toggleReverb: () => set((s) => ({ reverbEnabled: !s.reverbEnabled })),
}));

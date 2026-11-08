import { useSuiteDarkMode } from '@physbox-io/ui';

/** The light/dark switch, shared by every PhysBox app and synced to the account. */
export function useDarkMode(): [boolean, () => void] {
  const [darkMode, toggleDarkMode] = useSuiteDarkMode('physics_dark_mode');
  return [darkMode, toggleDarkMode];
}

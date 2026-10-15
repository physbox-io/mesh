import { useEffect, useState } from 'react';
import { pushAppParameter } from '../utils/cloudSync';

/** The light/dark switch: the `dark` class on <html>, kept in storage and synced to the account. */
export function useDarkMode(): [boolean, () => void] {
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('physics_dark_mode') === 'true';
    }
    return false;
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('physics_dark_mode', 'true');
      pushAppParameter('physics_dark_mode', 'true');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('physics_dark_mode', 'false');
      pushAppParameter('physics_dark_mode', 'false');
    }
  }, [darkMode]);

  const toggleDarkMode = () => setDarkMode(prev => !prev);
  return [darkMode, toggleDarkMode];
}

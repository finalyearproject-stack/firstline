/**
 * Three-way theme switch for the sidebar. Sits on the teal sidebar, so it is styled for a
 * dark ground in both themes (see `.theme-switch` in styles.css).
 */
import { useEffect, useState } from 'react';
import { applyTheme, getTheme, type ThemeChoice } from '../theme.ts';

const OPTIONS: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(getTheme);

  useEffect(() => {
    const sync = (event: Event) => setChoice((event as CustomEvent<ThemeChoice>).detail);
    window.addEventListener('firstline-theme', sync);
    return () => window.removeEventListener('firstline-theme', sync);
  }, []);

  return (
    <div className="theme-switch" role="group" aria-label="Appearance">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={choice === option.value}
          onClick={() => {
            setChoice(option.value);
            applyTheme(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Light / dark preference.
 *
 * 'system' (the default) writes no attribute and lets the stylesheet follow the device's
 * own setting. Choosing light or dark sets `data-theme`, which the stylesheet treats as
 * an override in either direction. The choice is remembered per device, and storage
 * failing (private mode, blocked site data) falls back to 'system' rather than throwing.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'firstline-theme';

export function getTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const html = document.documentElement;

  if (choice === 'system') html.removeAttribute('data-theme');
  else html.setAttribute('data-theme', choice);

  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* the choice still applies for this session */
  }
}

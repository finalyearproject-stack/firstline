/**
 * Command palette: Ctrl+K (Cmd+K on a Mac) reaches every screen and the common actions.
 *
 * Plain React with no library. The dashboard has about a dozen destinations, so filtering is
 * a substring match over the label (not the group: "ref" should not match "Preferences").
 * Keyboard: arrows move, Enter runs, Escape closes. Focus returns to wherever it was.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconSearch } from './icons.tsx';

export interface Command {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  run(): void;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

/** Opens on Ctrl/Cmd+K anywhere in the app. */
export function useCommandShortcut(onOpen: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpen]);
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    input.current?.focus();
    return () => (returnFocus.current as HTMLElement | null)?.focus?.();
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => setActive(0), [query]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); run(results[active]); }
  };

  // Group headings are shown only where the group changes, so results stay in their order.
  let lastGroup = '';

  return (
    <div className="cmdk-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="cmdk__search">
          <IconSearch size={17} />
          <input
            ref={input}
            className="cmdk__input"
            placeholder="Go to a page or run an action…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={results[active] ? `cmdk-${results[active].id}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>

        <ul className="cmdk__list" id="cmdk-list" role="listbox">
          {results.length === 0 && <li className="cmdk__empty">No matches for “{query}”</li>}
          {results.map((command, index) => {
            const heading = command.group !== lastGroup ? command.group : null;
            lastGroup = command.group;
            return (
              <li key={command.id} role="presentation">
                {heading && <div className="cmdk__group" aria-hidden="true">{heading}</div>}
                <div
                  id={`cmdk-${command.id}`}
                  className="cmdk__item"
                  role="option"
                  aria-selected={index === active}
                  onMouseMove={() => setActive(index)}
                  onClick={() => run(command)}
                >
                  {command.icon}
                  {command.label}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="cmdk__foot" aria-hidden="true">
          <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span>
          <span><kbd>Enter</kbd> to open</span>
        </div>
      </div>
    </div>
  );
}

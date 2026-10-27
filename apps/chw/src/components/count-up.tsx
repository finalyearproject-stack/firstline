/**
 * A number that counts up to its value when it first appears.
 *
 * Purely presentational. The real value is always in the DOM for assistive technology
 * (the animated digits are `aria-hidden`), and a reader who prefers reduced motion gets
 * the final number immediately with no animation at all.
 */
import { useEffect, useRef, useState } from 'react';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export function CountUp({ value, duration = 650 }: { value: number; duration?: number }) {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : 0));
  const from = useRef(shown);

  useEffect(() => {
    if (prefersReducedMotion() || from.current === value) {
      setShown(value);
      from.current = value;
      return;
    }

    const start = performance.now();
    const origin = from.current;
    let frame = 0;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = origin + (value - origin) * eased;
      setShown(next);
      from.current = next;
      if (t < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return (
    <>
      <span aria-hidden="true">{Math.round(shown).toLocaleString()}</span>
      <span className="sr-only">{value.toLocaleString()}</span>
    </>
  );
}

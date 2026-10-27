/**
 * The FirstLine mark: a ruled register line, the first one heavy. It is the product's name
 * drawn literally, and it echoes the ledger rules used throughout the interface.
 *
 * Drawn rather than imported so every place that shows it (sidebar, sign-in) stays in step.
 */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect x="1.6" y="1.6" width="28.8" height="28.8" rx="3.2" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M8 11h16" stroke="currentColor" strokeWidth="3.4" strokeLinecap="butt" />
      <path d="M8 17.5h16M8 23h10" stroke="currentColor" strokeWidth="1.8" opacity="0.6" />
    </svg>
  );
}

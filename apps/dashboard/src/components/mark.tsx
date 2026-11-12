/**
 * The FirstLine mark: a page of the VHT register, its first line heavy and its margin
 * ruled. The same drawing is the VHT app's mark and the installed app icon.
 *
 * Drawn rather than imported so every place that shows it (sidebar, sign-in, phone bar)
 * stays in step. The tile takes the brand colour from `currentColor`.
 */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="currentColor" />
      <rect x="17" y="12" width="30" height="40" rx="3.5" fill="#fff" />
      <g stroke="currentColor" strokeLinecap="round">
        <path d="M23.5 12V52" strokeWidth="1.6" opacity="0.35" strokeLinecap="butt" />
        <path d="M27 22H41" strokeWidth="4.2" />
        <path d="M27 30.5H41M27 38H41M27 45.5H36" strokeWidth="2.2" opacity="0.55" />
      </g>
    </svg>
  );
}

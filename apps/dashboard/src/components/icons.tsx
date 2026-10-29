/**
 * Dashboard icon set.
 *
 * Same drawing conventions as the CHW application's set (24×24, 1.8 stroke, round caps,
 * `currentColor`, inline SVG) so the two products look like one.
 *
 * Deliberately duplicated rather than shared: `@rhm/shared` is a plain TypeScript package
 * with no React dependency, and adding React to it to host a dozen icons would pull a UI
 * framework into the API's dependency graph. Each client ships only the icons it uses.
 */
import type { SVGProps } from 'react';

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function Svg({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

// ------------------------------------------------------------- navigation

export const IconOverview = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7.4" height="8.6" rx="1.6" />
    <rect x="13.1" y="3.5" width="7.4" height="5.4" rx="1.6" />
    <rect x="13.1" y="11.9" width="7.4" height="8.6" rx="1.6" />
    <rect x="3.5" y="15.1" width="7.4" height="5.4" rx="1.6" />
  </Svg>
);

export const IconAnalytics = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20.5V13" /><path d="M9.3 20.5V7.5" />
    <path d="M14.7 20.5v-5" /><path d="M20 20.5V4" />
  </Svg>
);

export const IconVillages = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 20.5V10L9 6l5.5 4v10.5" />
    <path d="M14.5 20.5V12l3-2.2 3 2.2v8.5" />
    <path d="M7.4 20.5v-4.4h3.2v4.4" />
  </Svg>
);

export const IconReferrals = (p: IconProps) => (
  <Svg {...p}><path d="M4 12h15" /><path d="m13 6 6 6-6 6" /></Svg>
);

export const IconChw = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 20c0-3.1 2.5-5.3 5.5-5.3s5.5 2.2 5.5 5.3" />
    <path d="M16.5 5.6a3.2 3.2 0 0 1 0 6" />
    <path d="M18 14.9c1.7.7 2.9 2.3 2.9 4.4" />
  </Svg>
);

export const IconSync = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.2 11.5a8.3 8.3 0 0 0-14.3-4.3L3.5 9.4" />
    <path d="M3.8 12.5a8.3 8.3 0 0 0 14.3 4.3l2.4-2.2" />
    <path d="M3.5 5v4.4h4.4M20.5 19v-4.4h-4.4" />
  </Svg>
);

export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="7.6" r="3.6" />
    <path d="M4.8 20.4c0-3.8 3.2-6.6 7.2-6.6s7.2 2.8 7.2 6.6" />
  </Svg>
);

export const IconRules = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v17" /><path d="M6.5 6.4h11" />
    <path d="m6.5 6.4-3 6.2a3 3 0 0 0 6 0Z" />
    <path d="m17.5 6.4-3 6.2a3 3 0 0 0 6 0Z" />
    <path d="M8.5 20.5h7" />
  </Svg>
);

export const IconAudit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.4 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.1Z" />
    <path d="M13.4 3.5V9.1H19" />
    <path d="M8.8 13.6h6.4M8.8 16.8h4.2" />
  </Svg>
);

// ------------------------------------------------------------------- KPIs

export const IconPatients = IconChw;

export const IconActivity = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 12h4l2.2-6 4.6 12 2.4-6h5.8" /></Svg>
);

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.8 21.2 19.6a1.3 1.3 0 0 1-1.1 2H3.9a1.3 1.3 0 0 1-1.1-2Z" />
    <path d="M12 9.6v4.2" /><path d="M12 17.4h.01" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="8.75" /><path d="M12 6.9V12l3.3 2" /></Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="m4.8 12.6 4.7 4.7 9.7-10.4" /></Svg>
);

export const IconPhone = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.4 4.2H5.6a2 2 0 0 0-2 2.2c.5 8 6.5 14 14.5 14.5a2 2 0 0 0 2.2-2v-2.8l-4.2-1.4-1.9 2a14.6 14.6 0 0 1-6.3-6.3l2-1.9Z" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></Svg>
);

export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}><path d="M12 5v14" /><path d="M5 12h14" /></Svg>
);

export const IconVersion = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.75" />
    <path d="M12 7.6v5l3 1.8" />
  </Svg>
);

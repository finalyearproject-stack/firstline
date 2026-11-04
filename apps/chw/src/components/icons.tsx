/**
 * Icon set.
 *
 * Stroke-based, 24×24, `currentColor`, inline SVG. Inline rather than an icon font or a
 * sprite sheet for three reasons that matter here: nothing extra is downloaded on a 2G
 * connection, every icon inherits the colour of whatever it sits inside, and there is no
 * flash of missing glyphs before an icon font arrives.
 *
 * These replace the typographic characters the interface used previously (`~`, `!`, `◷`,
 * `♪`). A punctuation mark in a rounded square does not read as an icon — it reads as a
 * placeholder, and it was the single most generic thing in the product.
 *
 * Drawing conventions, so additions stay consistent:
 *   - 24×24 viewBox, 1.8 stroke, round caps and joins, no fill.
 *   - Shapes sit on a 2px grid inside a 20×20 optical area.
 *   - Nothing relies on colour to be legible; every icon works as a silhouette.
 */
import type { SVGProps } from 'react';

export interface IconProps extends SVGProps<SVGSVGElement> {
  /** Pixel size; icons are square. */
  size?: number;
}

function Svg({ size = 20, children, ...rest }: IconProps) {
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

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5.5 9.5V20a1 1 0 0 0 1 1H9.5v-5.5h5V21h3a1 1 0 0 0 1-1V9.5" />
  </Svg>
);

export const IconPatients = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 20c0-3.1 2.5-5.3 5.5-5.3s5.5 2.2 5.5 5.3" />
    <path d="M16.5 5.6a3.2 3.2 0 0 1 0 6" />
    <path d="M18 14.9c1.7.7 2.9 2.3 2.9 4.4" />
  </Svg>
);

export const IconFollowUp = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.75" />
    <path d="m8.4 12.2 2.5 2.5 4.7-4.9" />
  </Svg>
);

export const IconLearn = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 5.2h5.3c1.8 0 3.2 1.3 3.2 2.9V20c0-1.3-1.2-2.3-2.6-2.3H3.5Z" />
    <path d="M20.5 5.2h-5.3c-1.8 0-3.2 1.3-3.2 2.9V20c0-1.3 1.2-2.3 2.6-2.3h5.9Z" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}><path d="m9.5 5.5 6.5 6.5-6.5 6.5" /></Svg>
);

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}><path d="M14.5 5.5 8 12l6.5 6.5" /></Svg>
);

export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}><path d="M4.5 12h15" /><path d="m13.5 6 6 6-6 6" /></Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}><path d="M12 5v14" /><path d="M5 12h14" /></Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="10.8" cy="10.8" r="6.3" /><path d="m15.5 15.5 4 4" /></Svg>
);

export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.6" y="10.4" width="14.8" height="9.6" rx="2.4" />
    <path d="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.6 0v2.8" />
  </Svg>
);

// ---------------------------------------------------------------- clinical

/** Pulse trace — used for screenings and anything "activity". */
export const IconActivity = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 12h4l2.2-6 4.6 12 2.4-6h5.8" /></Svg>
);

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.8 21.2 19.6a1.3 1.3 0 0 1-1.1 2H3.9a1.3 1.3 0 0 1-1.1-2Z" />
    <path d="M12 9.6v4.2" />
    <path d="M12 17.4h.01" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="8.75" /><path d="M12 6.9V12l3.3 2" /></Svg>
);

export const IconHeart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20s-7.5-4.6-7.5-9.6A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7.5 2.8c0 5-7.5 9.6-7.5 9.6Z" />
  </Svg>
);

export const IconStethoscope = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 3.5v5a4 4 0 0 0 8 0v-5" />
    <path d="M4 3.5h2M12 3.5h2" />
    <path d="M9 12.5v2.2a4.3 4.3 0 0 0 8.6 0v-1.4" />
    <circle cx="17.6" cy="11" r="2.2" />
  </Svg>
);

export const IconThermometer = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.8 13.6V5.4a2.4 2.4 0 1 0-4.8 0v8.2a4.2 4.2 0 1 0 4.8 0Z" />
    <path d="M11.4 16.4v-4" />
  </Svg>
);

export const IconDroplet = (p: IconProps) => (
  <Svg {...p}><path d="M12 3.2c3 3.5 5.6 6.4 5.6 9.4a5.6 5.6 0 0 1-11.2 0c0-3 2.6-5.9 5.6-9.4Z" /></Svg>
);

export const IconLungs = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v9" />
    <path d="M12 8.5c-1.6 0-2.6-1-3.6-1-2 0-3.4 2-3.9 5.2-.4 2.7-.2 5.4 1 6.5 1.3 1.2 3.6.6 4.6-.9.8-1.2 1.1-3 1.1-5" />
    <path d="M12 8.5c1.6 0 2.6-1 3.6-1 2 0 3.4 2 3.9 5.2.4 2.7.2 5.4-1 6.5-1.3 1.2-3.6.6-4.6-.9-.8-1.2-1.1-3-1.1-5" />
  </Svg>
);

export const IconCup = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 9h12v5a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5V9Z" />
    <path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17" />
    <path d="M9 3.5v2.5" />
    <path d="M13 3.5v2.5" />
  </Svg>
);

export const IconStomach = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.5 3.8v4.4c0 2.6 1.7 3.6 4 4.3 2.5.8 4 2.2 4 4.6a3.9 3.9 0 0 1-7.8.2" />
    <path d="M6.6 3.8h3.8" />
  </Svg>
);

export const IconBaby = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8.2" r="4.7" />
    <path d="M10.2 7.6h.01M13.8 7.6h.01" />
    <path d="M10.4 10.2a2.6 2.6 0 0 0 3.2 0" />
    <path d="M6.6 20.4c.9-2.9 2.9-4.6 5.4-4.6s4.5 1.7 5.4 4.6" />
  </Svg>
);

export const IconZap = (p: IconProps) => (
  <Svg {...p}><path d="M13.4 2.5 4.8 13.2h6L10.6 21.5l8.6-10.7h-6Z" /></Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}><path d="M20.3 13.6A8.5 8.5 0 0 1 10.4 3.7a8.8 8.8 0 1 0 9.9 9.9Z" /></Svg>
);

export const IconQuestion = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.75" />
    <path d="M9.6 9.6a2.5 2.5 0 0 1 4.9.6c0 1.7-2.5 2.1-2.5 3.6" />
    <path d="M12 17.2h.01" />
  </Svg>
);

export const IconTrendDown = (p: IconProps) => (
  <Svg {...p}><path d="m3.5 7.5 6.5 6.5 3.5-3.5 7 7" /><path d="M20.5 13.5v4h-4" /></Svg>
);

// ------------------------------------------------------------- operational

export const IconSync = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.2 11.5a8.3 8.3 0 0 0-14.3-4.3L3.5 9.4" />
    <path d="M3.8 12.5a8.3 8.3 0 0 0 14.3 4.3l2.4-2.2" />
    <path d="M3.5 5v4.4h4.4M20.5 19v-4.4h-4.4" />
  </Svg>
);

export const IconCloud = (p: IconProps) => (
  <Svg {...p}><path d="M7 18.5h10.2a4.3 4.3 0 0 0 .6-8.6 6 6 0 0 0-11.5 1.5A3.6 3.6 0 0 0 7 18.5Z" /></Svg>
);

export const IconCloudOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.2 5.6a6 6 0 0 1 8.6 4.3 4.3 4.3 0 0 1 2.9 6.9M16.2 18.5H7a3.6 3.6 0 0 1-.7-7.1 6 6 0 0 1 1-2.8" />
    <path d="m3.5 3.5 17 17" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}><path d="m6.5 9.5 5.5 5.5 5.5-5.5" /></Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="m4.8 12.6 4.7 4.7 9.7-10.4" /></Svg>
);

export const IconSend = (p: IconProps) => (
  <Svg {...p}><path d="M20.8 3.6 10.6 13.9" /><path d="M20.8 3.6 14.3 21 10.6 13.9 3.5 10.2Z" /></Svg>
);

export const IconPhone = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.4 4.2H5.6a2 2 0 0 0-2 2.2c.5 8 6.5 14 14.5 14.5a2 2 0 0 0 2.2-2v-2.8l-4.2-1.4-1.9 2a14.6 14.6 0 0 1-6.3-6.3l2-1.9Z" />
  </Svg>
);

export const IconDoc = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.4 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.1Z" />
    <path d="M13.4 3.5V9.1H19" />
    <path d="M8.8 13.6h6.4M8.8 16.8h4.2" />
  </Svg>
);

export const IconAudio = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 9.6v4.8M8.2 6.6v10.8M12 4.2v15.6M15.8 7.8v8.4M19.5 10.4v3.2" />
  </Svg>
);

export const IconMapPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2.6" />
  </Svg>
);

export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Svg>
);

/** The MUAC tape: a band with graduations. */
export const IconTape = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="8" width="18" height="8" rx="2" />
    <path d="M7 8v3M11 8v4M15 8v3M19 8v4" />
  </Svg>
);

export const IconPrinter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 9V3.5h10V9" />
    <rect x="3.5" y="9" width="17" height="8" rx="2" />
    <path d="M7 14h10v6.5H7z" />
  </Svg>
);

// ---------------------------------------------------------------------------

/**
 * Symptom icon lookup.
 *
 * Several symptoms deliberately share an icon within a body area. A CHW reads the label;
 * the icon's job is to group the list so the eye lands in the right region first.
 */
const SYMPTOM_ICONS: Record<string, (p: IconProps) => JSX.Element> = {
  headache: IconQuestion,
  fever_felt: IconThermometer,
  chills: IconThermometer,
  body_aches: IconActivity,
  dizziness: IconQuestion,
  weight_loss: IconTrendDown,
  fatigue: IconMoon,
  night_sweats: IconMoon,

  cough: IconLungs,
  difficulty_breathing: IconLungs,
  chest_pain: IconHeart,

  abdominal_pain: IconStomach,
  severe_abdominal_pain: IconStomach,
  diarrhoea: IconDroplet,
  vomits_everything: IconStomach,
  unable_to_feed: IconCup,

  convulsions: IconZap,
  confusion: IconQuestion,
  unconscious: IconMoon,
  chest_indrawing: IconLungs,
  blood_in_stool: IconDroplet,

  pregnant: IconBaby,
  vaginal_bleeding: IconDroplet,
  reduced_fetal_movement: IconBaby,
  blurred_vision: IconEye,
  swollen_face_hands: IconDroplet,
  too_weak_to_get_up: IconMoon,
  feels_ill: IconThermometer,
};

export function SymptomIcon({ code, size = 20 }: { code: string; size?: number }) {
  const Icon = SYMPTOM_ICONS[code] ?? IconActivity;
  return <Icon size={size} />;
}

/** Icon for a triage risk level, for lists and history rows. */
export function RiskIcon({ level, size = 18 }: { level: string; size?: number }) {
  if (level === 'RED') return <IconAlert size={size} />;
  if (level === 'AMBER') return <IconClock size={size} />;
  return <IconCheck size={size} />;
}

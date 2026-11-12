/**
 * Pieces of the screening flow that model the VHT kit (MoH VHT guidelines 2010, s10):
 * choosing what to screen for, counting breathing with the phone as the respiratory
 * timer, reading the colour-coded MUAC tape, and the referral letter that goes with a
 * referred patient.
 */
import { useEffect, useRef, useState } from 'react';
import {
  buildReferralLetter,
  canTakeEmergencies,
  composeReferralLetter,
  facilityLevel,
  rankFacilities,
  type MuacColour,
  type ReferralLetterInput,
  type ScreeningFocus,
  type Sex,
} from '@rhm/shared';
import { FOCUS_CATALOGUE, WHO_ANC_CONTACT_WEEKS, fastBreathingFrom, focusFits, nextAncContact } from '@rhm/triage';
import {
  IconActivity,
  IconBaby,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconDoc,
  IconHeart,
  IconLungs,
  IconPrinter,
  IconSend,
  IconStethoscope,
  IconThermometer,
  type IconProps,
} from './icons.tsx';

export const FOCUS_ICONS: Record<ScreeningFocus, (p: IconProps) => JSX.Element> = {
  FEVER: IconThermometer,
  COUGH: IconLungs,
  BLOOD_PRESSURE: IconHeart,
  PREGNANCY: IconBaby,
  CHILD: IconActivity,
  GENERAL: IconStethoscope,
};

/*
 * Every focus shares one neutral tile; the icon tells them apart. Coloured tiles read as
 * verdicts here: a rose "Fever" tile looks like RED and a green "Sick child" like GREEN,
 * and in this app red, amber and green mean only the triage result.
 */

export function focusName(focus: ScreeningFocus | null | undefined): string {
  return FOCUS_CATALOGUE.find((f) => f.focus === focus)?.name ?? 'General check';
}

/** The first step: one large card per screening that fits this patient. */
export function FocusPicker({
  patient,
  onPick,
}: {
  patient: { age: number; sex: Sex };
  onPick(focus: ScreeningFocus): void;
}) {
  const options = FOCUS_CATALOGUE.filter((f) => focusFits(f.focus, patient));
  return (
    <ul className="focus-list">
      {options.map((option) => {
        const Icon = FOCUS_ICONS[option.focus];
        return (
          <li key={option.focus}>
            <button type="button" className="focus-card" onClick={() => onPick(option.focus)}>
              <span className={`chip-icon focus-chip focus-chip--${option.focus}`}><Icon size={22} /></span>
              <span className="focus-card__text">
                <span className="focus-card__name">{option.name}</span>
                <span className="focus-card__hint">{option.hint}</span>
              </span>
              <IconChevronRight size={18} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const COUNT_SECONDS = 60;

/**
 * Breathing counter. The guidelines accept "a mobile phone with timer function" as the
 * respiratory timer: the VHT starts it, taps once per breath while watching the chest,
 * and after a full minute the count is the breathing rate. Typing a number counted on
 * a watch works too.
 */
export function BreathingCounter({
  age,
  value,
  onChange,
}: {
  age: number;
  value: string;
  onChange(next: string): void;
}) {
  const [left, setLeft] = useState<number | null>(null);
  const [taps, setTaps] = useState(0);
  const tapsRef = useRef(0);

  useEffect(() => {
    if (left === null) return;
    if (left === 0) {
      onChange(String(tapsRef.current));
      setLeft(null);
      return;
    }
    const timer = window.setTimeout(() => setLeft(left - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [left, onChange]);

  const start = () => {
    tapsRef.current = 0;
    setTaps(0);
    setLeft(COUNT_SECONDS);
  };
  const tap = () => {
    tapsRef.current += 1;
    setTaps(tapsRef.current);
  };

  const fast = fastBreathingFrom(age);
  const rate = Number.parseInt(value, 10);

  if (left !== null) {
    return (
      <div className="breath breath--running">
        <div className="breath__clock" aria-live="polite">
          <IconClock size={18} /> {left}s left
        </div>
        <button type="button" className="breath__tap" onClick={tap}>
          <span className="breath__count">{taps}</span>
          <span>Tap for each breath</span>
        </button>
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => setLeft(null)}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="breath">
      <div className="breath__row">
        <input
          className="input input--number"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="—"
          aria-label="Breaths per minute"
          value={value}
          onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 3))}
        />
        <button type="button" className="btn btn--secondary btn--sm" onClick={start}>
          <IconClock size={17} /> Count for 1 minute
        </button>
      </div>
      <div className={`field__hint${Number.isFinite(rate) && rate >= fast ? ' breath__fast' : ''}`}>
        {Number.isFinite(rate) && rate >= fast
          ? `Fast breathing for this age (${fast} or more).`
          : `Count when the patient is calm. Fast for this age: ${fast} or more per minute.`}
      </div>
    </div>
  );
}

const MUAC_OPTIONS: Array<{ value: MuacColour; label: string }> = [
  { value: 'RED', label: 'Red' },
  { value: 'YELLOW', label: 'Yellow' },
  { value: 'GREEN', label: 'Green' },
];

/** The colour band on the MUAC tape where it meets around the upper arm. */
export function MuacChoice({
  value,
  onChange,
}: {
  value: MuacColour | null;
  onChange(next: MuacColour | null): void;
}) {
  return (
    <div className="chip-group">
      {MUAC_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`chip chip--grow muac muac--${option.value}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(value === option.value ? null : option.value)}
        >
          <span className="muac__swatch" aria-hidden="true" />
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The referral letter, shown as it will read, with the ways to get it to the facility.
 * Sharing is a deliberate act: the letter carries health information, unlike the SMS.
 */
export function ReferralLetter({ input }: { input: ReferralLetterInput }) {
  const [copied, setCopied] = useState(false);
  const letter = buildReferralLetter(input);
  const text = composeReferralLetter(input);

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'VHT referral letter', text });
        return;
      } catch {
        // The VHT closed the share sheet; nothing to do.
        return;
      }
    }
    await copy();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  // Laid out as a document the receiving health worker can read at a glance; the plain
  // text above is what Share sends.
  const list = (title: string, items: string[]) =>
    items.length > 0 && (
      <div className="ldoc__block">
        <div className="ldoc__label">{title}</div>
        <ul className="ldoc__list">{items.map((item) => <li key={item}>{item}</li>)}</ul>
      </div>
    );

  return (
    <div className="card letter-card">
      <article className="ldoc" aria-label="Referral letter">
        <header className="ldoc__head">
          <div>
            <div className="ldoc__kicker">FirstLine · Village Health Team</div>
            <div className="ldoc__title">Referral letter</div>
          </div>
          <div className="ldoc__code">
            <span>Code</span>
            <strong>{letter.referralCode}</strong>
          </div>
        </header>

        <div className={`ldoc__urgency ldoc__urgency--${letter.urgency}`}>{letter.urgencyText}</div>

        <dl className="ldoc__rows">
          <dt>To</dt><dd>{letter.facility}</dd>
          <dt>Patient</dt><dd>{letter.patient.name}, {letter.patient.age}, {letter.patient.sex}</dd>
          <dt>Village</dt><dd>{letter.patient.village} · {letter.patient.patientCode}</dd>
          <dt>Date</dt><dd>{letter.date}, {letter.time}</dd>
        </dl>

        {list('Reasons for referral', letter.reasons)}
        {list('Findings', letter.findings)}
        {list('Symptoms reported', letter.symptoms)}
        {letter.notes && (
          <div className="ldoc__block">
            <div className="ldoc__label">Note from the VHT</div>
            <p className="ldoc__note">{letter.notes}</p>
          </div>
        )}

        <p className="ldoc__result">Screening result: {letter.result}</p>

        <footer className="ldoc__sign">
          <div><span className="ldoc__line" />Referred by {letter.referredBy}</div>
          <div><span className="ldoc__line" />Received at facility (name, date)</div>
        </footer>
      </article>

      <p className="muted small">
        Show this at the facility, print it, or copy it onto the paper referral form. It
        contains health information: share it only with the patient or the facility.
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => window.print()}>
          <IconPrinter size={17} /> Print
        </button>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => void share()}>
          {copied ? <><IconCheck size={17} /> Copied</> : <><IconSend size={17} /> Share</>}
        </button>
      </div>
    </div>
  );
}

/**
 * Where a pregnant woman is in the WHO 2016 schedule of eight antenatal contacts, and
 * when the next one falls. The VHT's job (VHT guidelines 2010, s9) is to advise her to
 * attend; the contacts themselves happen at the health facility.
 */
export function AncCard({ weeks }: { weeks: number }) {
  const next = nextAncContact(weeks);
  const when = next && next.inWeeks > 0
    ? new Date(Date.now() + next.inWeeks * 7 * 864e5).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
    : null;

  return (
    <div className="anc">
      <div className="result__section-label">Antenatal care (WHO)</div>
      <ol className="anc__track" aria-label="WHO antenatal contacts by week of pregnancy">
        {WHO_ANC_CONTACT_WEEKS.map((w, i) => (
          <li
            key={w}
            className={`anc__dot${next && i < next.dueSoFar ? ' anc__dot--past' : ''}${next && i === next.contact - 1 ? ' anc__dot--next' : ''}`}
          >
            <span>{w}</span>
          </li>
        ))}
      </ol>
      <p className="small" style={{ margin: 0 }}>
        {next === null
          ? `About ${weeks} weeks: past her due date. She should give birth at a health facility now.`
          : next.contact === 1
            ? `About ${weeks} weeks. Her first antenatal contact should be as early as possible, by 12 weeks.`
            : next.inWeeks === 0
              ? `About ${weeks} weeks. Contact ${next.contact} of 8 (${next.atWeeks} weeks) is due now.`
              : `About ${weeks} weeks. Next: contact ${next.contact} of 8 at ${next.atWeeks} weeks, in about ${next.inWeeks} ${next.inWeeks === 1 ? 'week' : 'weeks'} (around ${when}).`}
      </p>
      {next !== null && next.dueSoFar > 0 && (
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          By now she should have had {next.dueSoFar} {next.dueSoFar === 1 ? 'contact' : 'contacts'}. Ask to see her antenatal card.
        </p>
      )}
    </div>
  );
}

/**
 * Where to refer: the facilities this VHT has used, then the district's list, each with
 * its level. A danger sign puts places that can give emergency care (HC IV, hospital)
 * first. Any other facility can be typed in.
 */
export function FacilityPicker({
  value,
  onChange,
  recent,
  emergency,
}: {
  value: string;
  onChange(next: string): void;
  recent: string[];
  emergency: boolean;
}) {
  const options = rankFacilities(recent, emergency);
  const listed = options.some((f) => f.name === value);
  const [typing, setTyping] = useState(() => value !== '' && !listed);
  const chosenLevel = value ? facilityLevel(value) : null;
  const tooLow = emergency && value !== '' && !canTakeEmergencies({ level: chosenLevel });

  return (
    <div className="facility">
      <ul className="facility__list" role="radiogroup" aria-label="Health facility">
        {options.map((facility) => (
          <li key={facility.name}>
            <button
              type="button"
              role="radio"
              aria-checked={!typing && value === facility.name}
              className="facility__option"
              onClick={() => {
                setTyping(false);
                onChange(facility.name);
              }}
            >
              <span className="facility__name">{facility.name}</span>
              {facility.level && (
                <span className={`facility__level${canTakeEmergencies(facility) ? ' facility__level--emergency' : ''}`}>
                  {facility.level}
                </span>
              )}
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            role="radio"
            aria-checked={typing}
            className="facility__option"
            onClick={() => {
              setTyping(true);
              if (listed) onChange('');
            }}
          >
            <span className="facility__name">Another facility…</span>
          </button>
        </li>
      </ul>

      {typing && (
        <input
          className="input mt-16"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Name of the health facility"
          autoCapitalize="words"
          autoFocus
        />
      )}

      {tooLow && (
        <div className="field__hint facility__warn">
          For a danger sign, choose a Health Centre IV or a hospital if you can: they can give
          emergency care.
        </div>
      )}
    </div>
  );
}

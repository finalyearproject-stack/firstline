/**
 * Starting a screening from the home page: choose what it is for, then who.
 *
 * Laid out as two numbered sections on one page, so a VHT who arrives from a shortcut
 * ("Pregnancy check") sees the focus already chosen and only has to pick the woman. The
 * patient list is narrowed to people the focus fits, and registering someone new goes
 * straight on into the screening.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { SCREENING_FOCUSES, type RiskLevel, type ScreeningFocus } from '@rhm/shared';
import { FOCUS_CATALOGUE, focusFits } from '@rhm/triage';
import { Empty, PatientMark, Screen } from '../components/shell.tsx';
import { IconPatients, IconPlus, IconSearch } from '../components/icons.tsx';
import { useUnlocked } from '../state/session.tsx';
import { lastResults, searchPatients, type PatientView } from '../db/repository.ts';

const WHO_FITS: Partial<Record<ScreeningFocus, string>> = {
  PREGNANCY: 'Showing women aged 10 to 55.',
  CHILD: 'Showing children under five.',
};

export function NewScreeningScreen() {
  const { key } = useUnlocked();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const focus = SCREENING_FOCUSES.find((f) => f === searchParams.get('focus')) ?? null;

  const [term, setTerm] = useState('');
  const [patients, setPatients] = useState<PatientView[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [results, setResults] = useState<Map<string, RiskLevel>>(new Map());

  useEffect(() => {
    void lastResults().then(setResults);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void searchPatients(key, term).then((results) => {
      if (!cancelled) setPatients(results);
    });
    return () => {
      cancelled = true;
    };
  }, [key, term]);

  const fitting = (patients ?? []).filter((p) => !focus || focusFits(focus, p));
  const pick = (next: ScreeningFocus) => {
    setSearchParams({ focus: next }, { replace: true });
    // A patient chosen for the old focus may not fit the new one.
    if (chosen && !(patients ?? []).some((p) => p.id === chosen && focusFits(next, p))) setChosen(null);
  };

  return (
    <Screen title="New screening" back>
      <section className="setup">
        <h2 className="setup__head"><span className="setup__num">1</span> What are you screening for?</h2>
        <div className="chip-group">
          {FOCUS_CATALOGUE.map((option) => (
            <button
              key={option.focus}
              type="button"
              className="chip"
              aria-pressed={focus === option.focus}
              onClick={() => pick(option.focus)}
            >
              {option.name}
            </button>
          ))}
        </div>
      </section>

      <section className="setup">
        <h2 className="setup__head"><span className="setup__num">2</span> Patient</h2>
        {focus && WHO_FITS[focus] && <p className="muted small" style={{ marginTop: 0 }}>{WHO_FITS[focus]}</p>}
        <input
          className="input mb-16"
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Name, patient code or village"
          aria-label="Search patients"
          autoCapitalize="words"
        />

        <Link
          to={focus ? `/patients/new?focus=${focus}` : '/patients/new'}
          className="btn btn--secondary btn--sm mb-16"
        >
          <IconPlus size={17} /> Register a new patient
        </Link>

        {patients === null ? (
          <p className="muted">Loading…</p>
        ) : fitting.length === 0 ? (
          <Empty
            icon={term ? IconSearch : IconPatients}
            title={term ? 'No patient matches that' : 'No patients for this check yet'}
            body="Register the patient as new to start."
          />
        ) : (
          <ul className="list" role="radiogroup" aria-label="Patient">
            {fitting.slice(0, 30).map((patient) => (
              <li key={patient.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={chosen === patient.id}
                  className="list__item list__item--pick"
                  onClick={() => setChosen(patient.id)}
                >
                  <PatientMark risk={results.get(patient.id)} />
                  <span className="list__body">
                    <span className="list__title">{patient.firstName} {patient.lastName}</span>
                    <span className="list__meta">
                      {patient.age} yrs · {patient.sex.toLowerCase()} · {patient.village}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="setup__go">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!focus || !chosen}
          onClick={() => navigate(`/screen/${chosen}?focus=${focus}`)}
        >
          {!focus ? 'Choose what you are screening for' : !chosen ? 'Choose the patient' : 'Start screening'}
        </button>
      </div>
    </Screen>
  );
}

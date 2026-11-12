/**
 * The nurse's patients: a list narrowed by place and status, and one patient's record,
 * where the nurse sets that patient's status.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  can,
  NOT_REVIEWED_LABEL,
  PATIENT_STATUSES,
  PATIENT_STATUS_LABEL,
  type PatientStatus,
} from '@rhm/shared';
import type { CarePatient, Paginated, PatientHistory, PatientStatusInfo } from '../api.ts';
import { ApiError, get, post, useAuth } from '../api.ts';
import { PlaceFilter, SearchField, placeLine, useLocations, usePlaceFilter } from '../components/places.tsx';
import { Card, Empty, ErrorNotice, Loading, Page, formatDate, formatDateTime, useResource } from '../components/ui.tsx';

const FOCUS_LABEL: Record<string, string> = {
  FEVER: 'Fever or malaria',
  COUGH: 'Cough or TB',
  BLOOD_PRESSURE: 'Blood pressure or sugar',
  PREGNANCY: 'Pregnancy',
  CHILD: 'Sick child under 5',
  GENERAL: 'General check',
};

const RISK_WORD: Record<string, string> = { RED: 'Urgent', AMBER: 'Follow-up', GREEN: 'No danger signs' };

export function statusLabel(status: PatientStatus | null): string {
  return status ? PATIENT_STATUS_LABEL[status] : NOT_REVIEWED_LABEL;
}

const PAGE_SIZE = 50;

export function PatientsScreen() {
  const { session, signOut } = useAuth();
  const token = session?.token ?? null;
  const filter = usePlaceFilter();
  const locations = useLocations();
  const status = filter.param('status');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Paginated<CarePatient> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const query = [filter.query, status ? `status=${status}` : '', `page=${page}`, `pageSize=${PAGE_SIZE}`]
    .filter(Boolean)
    .join('&');

  // Back to the first page whenever the filters change.
  useEffect(() => setPage(1), [filter.query, status]);

  useEffect(() => {
    let cancelled = false;
    // A short pause while typing a name, so each key does not start a request.
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      get<Paginated<CarePatient>>(`/patients/care?${query}`, token)
        .then((response) => { if (!cancelled) setResult(response); })
        .catch((caught: unknown) => {
          if (cancelled) return;
          if (caught instanceof ApiError && caught.status === 401) return signOut();
          setError(caught instanceof Error ? caught.message : 'Could not load patients.');
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, token, signOut]);

  const total = result?.pagination.total ?? 0;
  const pages = result?.pagination.totalPages ?? 1;

  return (
    <Page title="Patients" subtitle="Not yet reviewed and most urgent first">
      <div className="filters">
        <SearchField id="patient-search" label="Name or ID" placeholder="e.g. Namazzi"
          value={filter.search} onChange={filter.setSearch} />
        <PlaceFilter value={filter.place} onChange={filter.setPlace} locations={locations.data?.locations ?? []} />
        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select id="f-status" className="select" value={status} onChange={(e) => filter.setParam('status', e.target.value)}>
            <option value="">Any status</option>
            <option value="NOT_REVIEWED">{NOT_REVIEWED_LABEL}</option>
            {PATIENT_STATUSES.map((s) => <option key={s} value={s}>{PATIENT_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
      </div>

      {error && <ErrorNotice message={error} />}

      <Card>
        {loading && !result ? (
          <Loading rows={6} />
        ) : !result || result.data.length === 0 ? (
          <Empty>No patients match these filters.</Empty>
        ) : (
          <>
            <div className="table-wrap" aria-busy={loading}>
              <table>
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Village</th>
                    <th>Last screening</th>
                    <th className="num">Open referrals</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.map((patient) => (
                    <tr key={patient.id}>
                      <td>
                        <Link className="row-link" to={`/patients/${patient.id}`}>
                          {patient.firstName} {patient.lastName}
                        </Link>
                        <div className="small muted">{patient.age} yrs · {patient.sex.toLowerCase()}</div>
                      </td>
                      <td>
                        {patient.village}
                        <div className="small muted">{placeLine(patient.place)}</div>
                      </td>
                      <td className="small">
                        {patient.lastVisitAt ? (
                          <span className={`dot-label dot-label--${patient.lastRisk ?? 'NONE'}`}>
                            {patient.lastRisk ? RISK_WORD[patient.lastRisk] : 'No result'} · {formatDate(patient.lastVisitAt)}
                          </span>
                        ) : 'None yet'}
                      </td>
                      <td className="num">{patient.openReferrals || '—'}</td>
                      <td className="small">
                        <span className={`dot-label care--${patient.status ?? 'NEW'}`}>{statusLabel(patient.status)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <span className="small muted">
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
              </span>
              <button type="button" className="btn btn--sm btn--secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <button type="button" className="btn btn--sm btn--secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </>
        )}
      </Card>
    </Page>
  );
}

// ---------------------------------------------------------------------------

export function PatientScreen() {
  const { id } = useParams<{ id: string }>();
  const { session } = useAuth();
  const canSet = session ? can(session.user.role, 'followup:manage') : false;
  const record = useResource<PatientHistory>(`/patients/${id}/visits`, [id]);
  const status = useResource<PatientStatusInfo>(`/patients/${id}/status`, [id]);

  const patient = record.data?.patient;
  const current = status.data?.history[0] ?? null;

  return (
    <Page
      title={patient ? `${patient.firstName} ${patient.lastName}` : 'Patient'}
      subtitle={patient ? `${patient.age} yrs · ${patient.sex.toLowerCase()} · ${patient.localId}` : undefined}
      actions={<Link className="btn btn--secondary btn--sm" to="/patients">All patients</Link>}
    >
      {record.error && <ErrorNotice message={record.error} onRetry={record.reload} />}

      {/* Only the first load shows the skeleton; a reload after saving keeps the page. */}
      {(record.loading && !record.data) || (status.loading && !status.data) ? (
        <Loading rows={5} />
      ) : patient ? (
        <div className="grid grid--patient">
          <div>
            <Card title="Status">
              <div className={`status-now dot-label care--${current?.status ?? 'NEW'}`}>{statusLabel(current?.status ?? null)}</div>
              {current && (
                <p className="small muted" style={{ marginTop: 4 }}>
                  Set by {current.setBy}, {formatDateTime(current.setAt)}
                </p>
              )}
              {canSet && (
                <StatusForm patientId={patient.id} current={current?.status ?? null} onSaved={status.reload} />
              )}
            </Card>

            <Card title="Where">
              <dl className="place-list">
                <div><dt>Village</dt><dd>{patient.village}</dd></div>
                <div><dt>Parish</dt><dd>{status.data?.place?.parish ?? '—'}</dd></div>
                <div><dt>Sub-county</dt><dd>{status.data?.place?.subCounty ?? '—'}</dd></div>
                <div><dt>District</dt><dd>{status.data?.place?.district ?? '—'}</dd></div>
              </dl>
              {!status.data?.place && <p className="small muted">This village has not been placed in a parish yet.</p>}
            </Card>

            {(status.data?.history.length ?? 0) > 0 && (
              <Card title="Status history">
                <ol className="history">
                  {status.data!.history.map((event) => (
                    <li key={event.id}>
                      <strong>{statusLabel(event.status)}</strong>
                      <div className="small muted">{event.setBy} · {formatDateTime(event.setAt)}</div>
                      {event.note && <div className="small">{event.note}</div>}
                    </li>
                  ))}
                </ol>
              </Card>
            )}
          </div>

          <Card title="Screenings" hint={`${record.data!.visits.length} recorded by the VHT, newest first`}>
            {record.data!.visits.length === 0 ? (
              <Empty>No screenings recorded yet.</Empty>
            ) : (
              <ol className="visits">
                {record.data!.visits.map(({ visit, triage, referral, symptoms }) => (
                  <li key={visit.id}>
                    <div className="visits__head">
                      <span className={`dot-label dot-label--${triage?.riskLevel ?? 'NONE'}`}>
                        {triage ? RISK_WORD[triage.riskLevel] : 'No result'}
                      </span>
                      <span className="small muted">{formatDate(visit.visitDate)} · {FOCUS_LABEL[visit.focus ?? 'GENERAL'] ?? visit.focus}</span>
                    </div>
                    {triage && triage.triggeredLabels.length > 0 && (
                      <ul className="visits__found">
                        {triage.triggeredLabels.map((label) => <li key={label}>{label}</li>)}
                      </ul>
                    )}
                    {symptoms.length > 0 && (
                      <div className="small muted">Reported: {symptoms.map((s) => s.symptomName.toLowerCase()).join(', ')}</div>
                    )}
                    {referral && (
                      <div className="small visits__referral">
                        Referred to {referral.destination} · {referral.status.charAt(0) + referral.status.slice(1).toLowerCase()}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      ) : null}
    </Page>
  );
}

/** Choose one status for this patient, add a note if useful, save. */
function StatusForm({ patientId, current, onSaved }: { patientId: string; current: PatientStatus | null; onSaved(): void }) {
  const { session } = useAuth();
  const [choice, setChoice] = useState<PatientStatus | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!choice) return;
    setSaving(true);
    setError(null);
    try {
      await post(`/patients/${patientId}/status`, { status: choice, note: note.trim() || null }, session?.token ?? null);
      setChoice(null);
      setNote('');
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the status.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="status-form" onSubmit={save}>
      <fieldset>
        <legend className="small">Change status</legend>
        <div className="status-options">
          {PATIENT_STATUSES.map((value) => (
            <label key={value} className={`status-option${value === current ? ' status-option--current' : ''}`}>
              <input type="radio" name="status" value={value} checked={choice === value} onChange={() => setChoice(value)} />
              <span>{PATIENT_STATUS_LABEL[value]}</span>
              {value === current && <span className="small muted">current</span>}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="status-note">Note (optional)</label>
        <textarea id="status-note" className="input" rows={2} maxLength={1000} value={note}
          placeholder="e.g. Seen on Monday, started treatment" onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && <ErrorNotice message={error} />}
      <button type="submit" className="btn btn--primary" disabled={!choice || choice === current || saving}>
        {saving ? 'Saving…' : 'Save status'}
      </button>
    </form>
  );
}

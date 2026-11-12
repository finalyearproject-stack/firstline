/**
 * Referral management, synchronisation monitoring, user administration, triage rules
 * and the audit log.
 */
import { useState } from 'react';
import type {
  AuditRow,
  Paginated,
  ReferralRow,
  SyncHealth,
  UserRow,
} from '../api.ts';
import { patch, post, useAuth } from '../api.ts';
import {
  Badge,
  Card,
  Empty,
  ErrorNotice,
  Kpi,
  Loading,
  Page,
  formatAgo,
  formatDate,
  formatDateTime,
  usePhoneLimit,
  useResource,
} from '../components/ui.tsx';
import { IconAlert, IconClock, IconRules, IconSync, IconVersion } from '../components/icons.tsx';
import { Link } from 'react-router-dom';
import { can } from '@rhm/shared';
import { PlaceFilter, SearchField, placeLine, useLocations, usePlaceFilter } from '../components/places.tsx';

// ---------------------------------------------------------------------------
// Referrals (spec s14: follow-up and referral monitoring)
// ---------------------------------------------------------------------------

export function ReferralsScreen() {
  const { session } = useAuth();
  const [status, setStatus] = useState('PENDING');
  const [urgency, setUrgency] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const filter = usePlaceFilter();
  const locations = useLocations();
  const seesPatients = session ? can(session.user.role, 'dashboard:identifiable') : false;

  const query = new URLSearchParams(filter.query);
  query.set('pageSize', '50');
  if (status) query.set('status', status);
  if (urgency) query.set('urgency', urgency);

  const referrals = useResource<ReferralRow[]>(`/referrals?${query}`, [query.toString()]);
  const shown = usePhoneLimit(referrals.data);

  // Only a nurse or health officer may change a referral's state; an official viewing
  // the programme sees the list read-only. The API enforces this regardless.
  const canUpdate = session?.user.role === 'NURSE';

  async function setReferralStatus(id: string, next: string) {
    setBusyId(id);
    try {
      await patch(`/referrals/${id}`, { status: next }, session?.token ?? null);
      referrals.reload();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Page
      title="Referrals"
      subtitle="Most urgent first"
    >
      <div className="filters">
        <SearchField id="referral-search" label="Patient name" placeholder="e.g. Namazzi"
          value={filter.search} onChange={filter.setSearch} />
        <PlaceFilter value={filter.place} onChange={filter.setPlace} locations={locations.data?.locations ?? []} />
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="PENDING">Pending</option>
            <option value="ACKNOWLEDGED">Acknowledged</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="urgency">Urgency</label>
          <select id="urgency" className="select" value={urgency} onChange={(e) => setUrgency(e.target.value)}>
            <option value="">All</option>
            <option value="IMMEDIATE">Immediate</option>
            <option value="WITHIN_24H">Within 24 hours</option>
            <option value="ROUTINE">Routine</option>
          </select>
        </div>
      </div>

      {referrals.error && <ErrorNotice message={referrals.error} onRetry={referrals.reload} />}

      <Card>
        {referrals.loading ? (
          <Loading rows={6} />
        ) : (referrals.data?.length ?? 0) === 0 ? (
          <Empty>No referrals match these filters.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Village</th>
                  <th>Urgency</th>
                  <th>Reason</th>
                  <th>Facility</th>
                  <th>Created</th>
                  <th>Status</th>
                  {canUpdate && <th>Action</th>}
                </tr>
              </thead>
              <tbody>
                {shown.visible.map((referral) => (
                  <tr key={referral.id}>
                    <td>
                      {seesPatients ? (
                        <Link className="row-link" to={`/patients/${referral.patientId}`}>
                          {referral.patient.firstName} {referral.patient.lastName}
                        </Link>
                      ) : (
                        <strong>{referral.patient.firstName} {referral.patient.lastName}</strong>
                      )}
                      <div className="small muted">
                        {referral.patient.age} yrs · {referral.patient.sex.toLowerCase()}
                      </div>
                    </td>
                    <td>
                      {referral.patient.village}
                      <div className="small muted">{placeLine(referral.place)}</div>
                    </td>
                    <td>
                      {/* The dot is the triage colour; the word is how soon the patient must go. */}
                      <span className={`dot-label dot-label--${referral.riskLevel ?? 'NONE'}`}>
                        {urgencyLabel(referral.urgency)}
                        {referral.riskLevel && <span className="sr-only"> ({referral.riskLevel})</span>}
                      </span>
                    </td>
                    <td className="small" style={{ maxWidth: 240 }}>{referral.reason}</td>
                    <td className="small">{referral.destination}</td>
                    <td className="small nowrap">{formatDate(referral.createdAt)}</td>
                    <td className="small">{statusLabel(referral.status)}</td>
                    {canUpdate && (
                      <td>
                        {referral.status === 'PENDING' && (
                          <button
                            type="button"
                            className="btn btn--sm btn--secondary"
                            disabled={busyId === referral.id}
                            onClick={() => void setReferralStatus(referral.id, 'ACKNOWLEDGED')}
                          >
                            Acknowledge
                          </button>
                        )}
                        {referral.status === 'ACKNOWLEDGED' && (
                          <button
                            type="button"
                            className="btn btn--sm btn--primary"
                            disabled={busyId === referral.id}
                            onClick={() => void setReferralStatus(referral.id, 'COMPLETED')}
                          >
                            Mark seen
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.more}
          </div>
        )}
      </Card>

      <p className="small muted mt-24">
        Patient names appear here because a referral cannot be acted on without them.
        District officials, who do not hold the referral permission, see only the
        aggregate figures elsewhere in this dashboard.
      </p>
    </Page>
  );
}

function urgencyLabel(urgency: string): string {
  return urgency === 'IMMEDIATE' ? 'Immediate' : urgency === 'WITHIN_24H' ? 'Within 24 hours' : 'Routine';
}

function statusLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Synchronisation monitoring (spec s14)
// ---------------------------------------------------------------------------

export function SyncScreen() {
  const health = useResource<SyncHealth>('/dashboard/sync-health');

  return (
    <Page title="Synchronisation">
      {health.error && <ErrorNotice message={health.error} onRetry={health.reload} />}

      {health.loading ? (
        <Loading rows={3} />
      ) : health.data ? (
        <>
          <div className="grid grid--kpi mb-24">
            <Kpi label="Records received" value={health.data.receiptsLast24h} icon={IconSync} tone="teal" meta="last 24 hours" />
            <Kpi label="Rejected" value={health.data.rejectedLast24h} icon={IconAlert} tone={health.data.rejectedLast24h > 0 ? 'red' : undefined} meta="failed validation" />
            <Kpi label="Conflicts" value={health.data.conflictsLast24h} icon={IconClock} tone={health.data.conflictsLast24h > 0 ? 'amber' : undefined} meta="stale device copies" />
            <Kpi label="Devices quiet" value={health.data.chwsSilentOver48h.length} icon={IconClock} meta="over 48 hours" />
          </div>

          <Card title="Devices that have not synchronised recently">
            {health.data.chwsSilentOver48h.length === 0 ? (
              <Empty>Every active CHW has synchronised in the last 48 hours.</Empty>
            ) : (
              <>
                <p className="small muted" style={{ marginTop: 0 }}>
                  A quiet phone does not mean lost data: records stay on it, encrypted, until
                  it connects. Check whether the VHT has network coverage or needs help.
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>CHW</th>
                        <th>Last synchronised</th>
                      </tr>
                    </thead>
                    <tbody>
                      {health.data.chwsSilentOver48h.map((chw) => (
                        <tr key={chw.chwId}>
                          <td><strong>{chw.name}</strong></td>
                          <td>
                            {chw.hoursSinceLastSync === null ? 'Never' : formatAgo(chw.hoursSinceLastSync)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>
        </>
      ) : null}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Users and roles (spec s16)
// ---------------------------------------------------------------------------

export function UsersScreen() {
  const { session } = useAuth();
  const users = useResource<UserRow[]>('/users');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    username: '',
    password: '',
    role: 'CHW',
    village: '',
    chwIdentifier: '',
  });

  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await post(
        '/users',
        {
          name: form.name,
          username: form.username,
          password: form.password,
          role: form.role,
          village: form.village || null,
          chwIdentifier: form.chwIdentifier || null,
        },
        session?.token ?? null,
      );
      setForm({ name: '', username: '', password: '', role: 'CHW', village: '', chwIdentifier: '' });
      setCreating(false);
      users.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the user.');
    }
  }

  async function toggleStatus(user: UserRow) {
    setError(null);
    try {
      await patch(
        `/users/${user.id}`,
        { status: user.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' },
        session?.token ?? null,
      );
      users.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update the user.');
    }
  }

  return (
    <Page
      title="Users & roles"
      actions={
        <button type="button" className="btn btn--primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : '+ Add user'}
        </button>
      }
    >
      {error && <ErrorNotice message={error} />}
      {users.error && <ErrorNotice message={users.error} onRetry={users.reload} />}

      {creating && (
        <Card title="New user">
          <form onSubmit={createUser}>
            <div className="grid grid--2">
              <div className="field">
                <label htmlFor="name">Full name</label>
                <input id="name" className="input" value={form.name} required
                  onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="username">Username</label>
                <input id="username" className="input" value={form.username} required autoCapitalize="none"
                  onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="password">Initial password</label>
                <input id="password" className="input" type="password" value={form.password} required minLength={8}
                  onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="role">Role</label>
                <select id="role" className="select" value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="CHW">CHW — field screening</option>
                  <option value="NURSE">Nurse / health officer</option>
                  <option value="OFFICIAL">District official — aggregate only</option>
                  <option value="ADMIN">Administrator</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="village">Village</label>
                <input id="village" className="input" value={form.village}
                  onChange={(e) => setForm({ ...form, village: e.target.value })} />
              </div>
              {form.role === 'CHW' && (
                <div className="field">
                  <label htmlFor="chwid">CHW identifier</label>
                  <input id="chwid" className="input" value={form.chwIdentifier} placeholder="CHW-005"
                    onChange={(e) => setForm({ ...form, chwIdentifier: e.target.value })} />
                </div>
              )}
            </div>
            <button type="submit" className="btn btn--primary">Create user</button>
          </form>
        </Card>
      )}

      <Card>
        {users.loading ? (
          <Loading rows={6} />
        ) : (users.data?.length ?? 0) === 0 ? (
          <Empty>No users yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Village</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {users.data!.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.name}</strong>
                      {user.chwIdentifier && <div className="mono">{user.chwIdentifier}</div>}
                    </td>
                    <td className="mono">{user.username}</td>
                    <td><Badge kind={user.role} /></td>
                    <td>{user.village ?? '—'}</td>
                    <td><Badge kind={user.status} /></td>
                    <td className="small">{formatDate(user.createdAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--sm btn--secondary"
                        onClick={() => void toggleStatus(user)}
                      >
                        {user.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Triage rules (spec s8: thresholds are configuration, not code)
// ---------------------------------------------------------------------------

interface RuleSetSummary {
  id: string;
  version: string;
  active: boolean;
  approvedBy: string | null;
  approvedOn: string | null;
  createdAt: string;
}

interface ActiveRuleSet {
  rulesetVersion: string;
  metadata: { name: string; disclaimer: string; source: string; approvedBy: string | null; approvedOn: string | null };
  rules: Array<{
    id: string;
    name: string;
    category: string;
    riskLevel: 'RED' | 'AMBER' | 'GREEN';
    priority: number;
    referralRequired: boolean;
    label: string;
    recommendation: string;
    explanation: string;
    active?: boolean;
  }>;
}

export function RulesScreen() {
  const active = useResource<ActiveRuleSet>('/triage/ruleset');
  const history = useResource<RuleSetSummary[]>('/triage/rulesets');

  return (
    <Page
      title="Triage rules"
      subtitle="The rules every device applies offline"
    >
      {active.error && <ErrorNotice message={active.error} onRetry={active.reload} />}

      {active.loading ? (
        <Loading rows={5} />
      ) : active.data ? (
        <>
          {active.data.metadata.approvedBy === null && (
            <div className="notice notice--warning" role="alert">
              <strong>This rule set has not been approved by a clinical authority.</strong>{' '}
              The thresholds below are a configuration template for demonstration. Before
              any use with real patients, the responsible health authority must review
              every rule, replace the thresholds with the locally approved protocol, and
              record the approver.
            </div>
          )}

          <div className="grid grid--kpi mb-24">
            <Kpi label="Active version" value={active.data.rulesetVersion} icon={IconVersion} tone="teal" />
            <Kpi label="Rules" value={active.data.rules.length} icon={IconRules} tone="teal" />
            <Kpi label="Urgent rules" value={active.data.rules.filter((r) => r.riskLevel === 'RED').length} icon={IconAlert} tone="red" />
            <Kpi label="Approved by" value={active.data.metadata.approvedBy ?? 'Not approved'} />
          </div>

          <Card title="Active rules" hint="Changing a threshold is a configuration change, not a code release">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Category</th>
                    <th>Risk</th>
                    <th className="num">Priority</th>
                    <th>Refer</th>
                    <th>Shown to the CHW as</th>
                  </tr>
                </thead>
                <tbody>
                  {active.data.rules.map((rule) => (
                    <tr key={rule.id}>
                      <td>
                        <strong>{rule.name}</strong>
                        <div className="mono">{rule.id}</div>
                      </td>
                      <td className="small">{rule.category}</td>
                      <td><Badge kind={rule.riskLevel} /></td>
                      <td className="num">{rule.priority}</td>
                      <td>{rule.referralRequired ? 'Yes' : 'No'}</td>
                      <td className="small" style={{ maxWidth: 280 }}>{rule.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Publication history" >
            {history.loading ? (
              <Loading rows={3} />
            ) : (history.data?.length ?? 0) === 0 ? (
              <Empty>No rule set has been published yet; devices are using the version bundled with the build.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Status</th>
                      <th>Approved by</th>
                      <th>Published</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.data!.map((entry) => (
                      <tr key={entry.id}>
                        <td className="mono">{entry.version}</td>
                        <td>{entry.active ? <Badge kind="ACTIVE">Active</Badge> : <Badge kind="CANCELLED">Superseded</Badge>}</td>
                        <td>{entry.approvedBy ?? <span className="muted">Not approved</span>}</td>
                        <td className="small">{formatDateTime(entry.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Audit log (spec s17/s18)
// ---------------------------------------------------------------------------

export function AuditScreen() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);

  const query = new URLSearchParams({ page: String(page), pageSize: '50' });
  if (action) query.set('action', action);

  const audit = useResource<AuditRow[]>(`/audit?${query}`, [action, page]);
  const shown = usePhoneLimit(audit.data);

  return (
    <Page
      title="Audit log"
      actions={
        <div className="field">
          <label htmlFor="action">Action</label>
          <select
            id="action"
            className="select"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All actions</option>
            <option value="LOGIN_SUCCESS">Sign in</option>
            <option value="LOGIN_FAILURE">Failed sign in</option>
            <option value="PATIENT_CREATE">Patient created</option>
            <option value="PATIENT_VIEW">Patient viewed</option>
            <option value="VISIT_CREATE">Visit recorded</option>
            <option value="REFERRAL_CREATE">Referral created</option>
            <option value="REFERRAL_UPDATE">Referral updated</option>
            <option value="SYNC_PUSH">Synchronisation</option>
            <option value="USER_CREATE">User created</option>
            <option value="USER_UPDATE">User updated</option>
            <option value="RULESET_PUBLISH">Rules published</option>
          </select>
        </div>
      }
    >
      {audit.error && <ErrorNotice message={audit.error} onRetry={audit.reload} />}

      <div className="notice notice--info">
        The audit log records actions, never clinical content. Patient names, vital signs
        and symptoms are deliberately excluded so that this log cannot become a second,
        less protected copy of the health record.
      </div>

      <Card>
        {audit.loading ? (
          <Loading rows={8} />
        ) : (audit.data?.length ?? 0) === 0 ? (
          <Empty>No audit entries match this filter.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.visible.map((entry) => (
                    <tr key={entry.id}>
                      <td className="small" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(entry.timestamp)}</td>
                      <td>
                        {entry.userName ?? <span className="muted">—</span>}
                        {entry.userRole && <div><Badge kind={entry.userRole} /></div>}
                      </td>
                      <td className="mono">{entry.action}</td>
                      <td className="small">{entry.entityType}</td>
                      <td className="small muted" style={{ maxWidth: 320 }}>
                        {entry.metadata
                          ? Object.entries(entry.metadata).map(([k, v]) => `${k}: ${String(v)}`).join(', ')
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.more}
            </div>

            <div className="row row--between mt-24">
              <button
                type="button"
                className="btn btn--sm btn--secondary"
                disabled={page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <span className="small muted">Page {page}</span>
              <button
                type="button"
                className="btn btn--sm btn--secondary"
                disabled={(audit.data?.length ?? 0) < 50}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </Card>
    </Page>
  );
}

export type { Paginated };

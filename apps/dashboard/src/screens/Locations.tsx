/**
 * Where each village sits. An administrator places every village in its parish,
 * sub-county and district, from the district's official list, so the rest of the
 * dashboard can group and filter by place.
 */
import { useState, type FormEvent } from 'react';
import type { LocationRow } from '../api.ts';
import { post, useAuth } from '../api.ts';
import { SearchField, useLocations } from '../components/places.tsx';
import { Card, Empty, ErrorNotice, Loading, Page } from '../components/ui.tsx';

const BLANK: LocationRow = { village: '', parish: '', subCounty: '', district: '' };

export function LocationsScreen() {
  const { session } = useAuth();
  const locations = useLocations();
  const [form, setForm] = useState<LocationRow>(BLANK);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const rows = locations.data?.locations ?? [];
  const term = search.trim().toLowerCase();
  const shown = term
    ? rows.filter((r) => [r.village, r.parish, r.subCounty, r.district].some((v) => v.toLowerCase().includes(term)))
    : rows;
  const values = (key: keyof LocationRow) => [...new Set(rows.map((r) => r[key]))].sort();

  function start(row: LocationRow, isEdit: boolean) {
    setForm(row);
    setEditing(isEdit);
    setError(null);
    document.getElementById('loc-village')?.focus();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await post('/reference/locations', form, session?.token ?? null);
      setForm(BLANK);
      setEditing(false);
      locations.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the village.');
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof LocationRow, label: string, list?: string) => (
    <div className="field">
      <label htmlFor={`loc-${key}`}>{label}</label>
      <input id={`loc-${key}`} className="input" required maxLength={120} list={list} value={form[key]}
        readOnly={key === 'village' && editing}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </div>
  );

  return (
    <Page title="Locations" subtitle="Each village’s parish, sub-county and district">
      {locations.error && <ErrorNotice message={locations.error} onRetry={locations.reload} />}

      <div className="grid grid--patient">
        <div>
          <Card title={editing ? `Move ${form.village}` : 'Place a village'}>
            <form onSubmit={save}>
              {field('village', 'Village')}
              {field('parish', 'Parish or ward', 'loc-parishes')}
              {field('subCounty', 'Sub-county or town council', 'loc-subcounties')}
              {field('district', 'District', 'loc-districts')}
              <datalist id="loc-parishes">{values('parish').map((v) => <option key={v} value={v} />)}</datalist>
              <datalist id="loc-subcounties">{values('subCounty').map((v) => <option key={v} value={v} />)}</datalist>
              <datalist id="loc-districts">{values('district').map((v) => <option key={v} value={v} />)}</datalist>
              {error && <ErrorNotice message={error} />}
              <div className="row">
                <button type="submit" className="btn btn--primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                {(editing || form.village) && (
                  <button type="button" className="btn btn--secondary" onClick={() => start(BLANK, false)}>Cancel</button>
                )}
              </div>
            </form>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Use the names on the district’s official list, so reports match the district’s own.
            </p>
          </Card>

          {(locations.data?.unplaced.length ?? 0) > 0 && (
            <Card title="Not yet placed" hint="Villages VHTs have recorded that have no parish yet">
              <ul className="plain-list">
                {locations.data!.unplaced.map((village) => (
                  <li key={village} className="row row--between">
                    <span>{village}</span>
                    <button type="button" className="btn btn--sm btn--secondary"
                      onClick={() => start({ ...BLANK, village }, false)}>Place</button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <Card>
          <div className="filters">
            <SearchField id="loc-search" label="Search" placeholder="Village, parish, sub-county or district"
              value={search} onChange={setSearch} />
          </div>
          {locations.loading ? (
            <Loading rows={5} />
          ) : shown.length === 0 ? (
            <Empty>{rows.length === 0 ? 'No villages placed yet.' : 'No villages match.'}</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>District</th><th>Sub-county</th><th>Parish</th><th>Village</th><th /></tr>
                </thead>
                <tbody>
                  {shown.map((row) => (
                    <tr key={row.village}>
                      <td>{row.district}</td>
                      <td>{row.subCounty}</td>
                      <td>{row.parish}</td>
                      <td><strong>{row.village}</strong></td>
                      <td><button type="button" className="btn btn--sm btn--secondary" onClick={() => start(row, true)}>Move</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}

/**
 * Place filters: district > sub-county > parish, kept in the address bar so that going
 * into a patient and coming back keeps the list where it was.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { LocationFilter } from '@rhm/shared';
import type { LocationRow, Locations } from '../api.ts';
import { useResource } from './ui.tsx';

const KEYS = ['district', 'subCounty', 'parish'] as const;

/** The place filter and free-text search, read from and written to the address bar. */
export function usePlaceFilter(): {
  place: LocationFilter;
  search: string;
  setPlace(next: LocationFilter): void;
  setSearch(next: string): void;
  /** `district=…&subCounty=…` ready to append to an API path, with the search as `search`. */
  query: string;
  param(key: string): string;
  setParam(key: string, value: string): void;
} {
  const [params, setParams] = useSearchParams();

  const place = useMemo<LocationFilter>(() => ({
    district: params.get('district') ?? undefined,
    subCounty: params.get('subCounty') ?? undefined,
    parish: params.get('parish') ?? undefined,
  }), [params]);
  const search = params.get('q') ?? '';

  const update = useCallback((changes: Record<string, string | undefined>) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  const query = useMemo(() => {
    const out = new URLSearchParams();
    for (const key of KEYS) if (place[key]) out.set(key, place[key]!);
    if (search.trim()) out.set('search', search.trim());
    return out.toString();
  }, [place, search]);

  return {
    place,
    search,
    setPlace: (next) => update({ district: next.district, subCounty: next.subCounty, parish: next.parish }),
    setSearch: (next) => update({ q: next }),
    query,
    param: (key) => params.get(key) ?? '',
    setParam: (key, value) => update({ [key]: value }),
  };
}

export function useLocations() {
  return useResource<Locations>('/reference/locations');
}

const unique = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));

/**
 * Three linked selects. Choosing a district narrows the sub-counties to that district,
 * and so on down; changing a higher level clears the levels below it.
 */
export function PlaceFilter({
  value,
  onChange,
  locations,
}: {
  value: LocationFilter;
  onChange(next: LocationFilter): void;
  locations: LocationRow[];
}) {
  const districts = unique(locations.map((l) => l.district));
  const subCounties = unique(locations.filter((l) => l.district === value.district).map((l) => l.subCounty));
  const parishes = unique(
    locations.filter((l) => l.district === value.district && l.subCounty === value.subCounty).map((l) => l.parish),
  );

  return (
    <>
      <div className="field">
        <label htmlFor="f-district">District</label>
        <select id="f-district" className="select" value={value.district ?? ''}
          onChange={(e) => onChange({ district: e.target.value || undefined })}>
          <option value="">All districts</option>
          {districts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="f-subcounty">Sub-county</label>
        <select id="f-subcounty" className="select" value={value.subCounty ?? ''} disabled={!value.district}
          onChange={(e) => onChange({ district: value.district, subCounty: e.target.value || undefined })}>
          <option value="">{value.district ? 'All sub-counties' : 'Choose a district'}</option>
          {subCounties.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="f-parish">Parish</label>
        <select id="f-parish" className="select" value={value.parish ?? ''} disabled={!value.subCounty}
          onChange={(e) => onChange({ ...value, parish: e.target.value || undefined })}>
          <option value="">{value.subCounty ? 'All parishes' : 'Choose a sub-county'}</option>
          {parishes.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
    </>
  );
}

/** A search box that writes as you type. */
export function SearchField({ id, label, placeholder, value, onChange }: {
  id: string; label: string; placeholder: string; value: string; onChange(next: string): void;
}) {
  return (
    <div className="field field--grow">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" type="search" placeholder={placeholder} value={value}
        onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** "Nangabo · Wakiso" style line under a village name. */
export function placeLine(place: Pick<LocationRow, 'parish' | 'subCounty' | 'district'> | null): string {
  if (!place) return 'Not yet placed';
  return `${place.parish} parish · ${place.subCounty} · ${place.district}`;
}

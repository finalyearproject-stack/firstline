/**
 * Health awareness module (spec s11).
 *
 * Content is seeded into the local database on first run and refreshed from the server
 * opportunistically. It is fully readable and playable with no connection.
 */
import { useEffect, useMemo, useState } from 'react';
import { AWARENESS_LANGUAGES, AWARENESS_SEED } from '@rhm/shared';
import { Empty, Field, Screen } from '../components/shell.tsx';
import { IconAudio, IconChevronRight, IconDoc, IconLearn } from '../components/icons.tsx';
import { db, META_KEYS, getMeta, setMeta, type StoredAwareness } from '../db/local.ts';
import { useSession } from '../state/session.tsx';
import { fetchAwareness } from '../sync/api.ts';

/** Seeds the bundled content so a brand-new device has material before its first sync. */
export async function ensureAwarenessSeeded(): Promise<void> {
  if (await getMeta<boolean>(META_KEYS.awarenessSeeded)) return;

  await db().awareness.bulkPut(
    AWARENESS_SEED.map((item) => ({
      id: item.id,
      title: item.title,
      language: item.language,
      category: item.category,
      summary: item.summary,
      body: item.body,
      audioPath: item.audioPath,
      version: item.version,
      active: item.active ? 1 : 0,
      updatedAt: new Date().toISOString(),
    })),
  );

  await setMeta(META_KEYS.awarenessSeeded, true);
}

export function AwarenessScreen() {
  const { token } = useSession();
  const [items, setItems] = useState<StoredAwareness[]>([]);
  const [language, setLanguage] = useState('en');
  const [category, setCategory] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState<StoredAwareness | null>(null);

  useEffect(() => {
    void (async () => {
      await ensureAwarenessSeeded();
      setItems(await db().awareness.toArray());
    })();
  }, []);

  // Refresh from the server when possible. Failure is silent and harmless: the local
  // copy is what the CHW reads either way.
  useEffect(() => {
    if (!token || !navigator.onLine) return;
    void (async () => {
      try {
        const remote = await fetchAwareness(token);
        if (remote.length === 0) return;

        await db().awareness.bulkPut(
          remote.map((item) => ({
            id: item.id,
            title: item.title,
            language: item.language,
            category: item.category,
            summary: item.summary,
            body: item.body,
            audioPath: item.audioPath,
            version: item.version,
            active: item.active ? 1 : 0,
            updatedAt: item.updatedAt,
          })),
        );
        setItems(await db().awareness.toArray());
      } catch {
        // Offline or unreachable. The bundled and previously cached content stands.
      }
    })();
  }, [token]);

  const categories = useMemo(
    () => [...new Set(items.filter((i) => i.language === language).map((i) => i.category))].sort(),
    [items, language],
  );

  const visible = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return items
      .filter((item) => item.active === 1 && item.language === language)
      .filter((item) => !category || item.category === category)
      .filter(
        (item) =>
          !needle ||
          item.title.toLowerCase().includes(needle) ||
          item.summary.toLowerCase().includes(needle) ||
          item.body.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  }, [items, language, category, term]);

  if (open) {
    return <AwarenessDetail item={open} onBack={() => setOpen(null)} />;
  }

  return (
    <Screen title="Health information">
      <Field label="Language">
        <div className="chip-group">
          {AWARENESS_LANGUAGES.map((option) => (
            <button
              key={option.code}
              type="button"
              className="chip chip--grow"
              aria-pressed={language === option.code}
              onClick={() => {
                setLanguage(option.code);
                setCategory(null);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Search">
        <input
          className="input"
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search health topics"
        />
      </Field>

      {categories.length > 0 && (
        <div className="chip-group mb-16">
          <button
            type="button"
            className="chip"
            aria-pressed={category === null}
            onClick={() => setCategory(null)}
          >
            All
          </button>
          {categories.map((name) => (
            <button
              key={name}
              type="button"
              className="chip"
              aria-pressed={category === name}
              onClick={() => setCategory(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <Empty
          icon={IconLearn}
          title="Nothing here yet"
          body={
            language === 'en'
              ? 'No topics match your search.'
              : 'There is no content in this language on this phone yet.'
          }
        />
      ) : (
        <ul className="list">
          {visible.map((item) => (
            <li key={item.id}>
              <button type="button" className="list__item" onClick={() => setOpen(item)}>
                <span className="list__avatar">
                  {item.audioPath ? <IconAudio size={20} /> : <IconDoc size={20} />}
                </span>
                <span className="list__body">
                  <span className="list__title">{item.title}</span>
                  <span className="list__meta">{item.category}</span>
                </span>
                <span className="list__chevron"><IconChevronRight size={19} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="muted small center mt-16">
        All of this works without internet.
      </p>
    </Screen>
  );
}

// ---------------------------------------------------------------------------

function AwarenessDetail({ item, onBack }: { item: StoredAwareness; onBack(): void }) {
  const [audioError, setAudioError] = useState(false);
  const isDraftTranslation = AWARENESS_SEED.find((s) => s.id === item.id)?.reviewed === false;

  return (
    <Screen title={item.title} back>
      <button type="button" className="btn btn--quiet btn--sm mb-16" onClick={onBack}>
        ‹ Back to topics
      </button>

      {isDraftTranslation && (
        <div className="translation-note">
          This translation is a draft and has not yet been checked by a health educator.
          Use the English version if you are unsure of any wording.
        </div>
      )}

      {item.audioPath && !audioError && (
        <div className="audio-bar">
          {/*
            A plain <audio> element with controls: it is keyboard accessible, it is
            familiar, and the file is precached by the service worker so it plays with
            no connection at all.
          */}
          <audio
            controls
            preload="none"
            src={item.audioPath}
            style={{ width: '100%' }}
            onError={() => setAudioError(true)}
          >
            Your browser cannot play audio.
          </audio>
        </div>
      )}

      {audioError && (
        <div className="translation-note">
          The audio for this topic has not been installed on this phone. The written
          version below is complete.
        </div>
      )}

      <div className="card">
        <div className="card__label">{item.category}</div>
        <p className="muted">{item.summary}</p>
        <hr style={{ border: 0, borderTop: '1px solid var(--ink-200)', margin: '16px 0' }} />
        <div className="awareness__body">{item.body}</div>
      </div>
    </Screen>
  );
}

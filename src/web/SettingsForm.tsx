import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import type {
  FieldSpec,
  FieldValue,
  PublicValue,
  SecretState,
  SettingsErrorResponse,
  SettingsResponse,
  SettingsSection,
  SettingsUpdate,
  TestResult,
} from "../shared/settings.js";
import { ApiError, api } from "./api.js";

const timeZones: string[] = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();

type Draft = Record<string, string | boolean>;

function toDraft(section: SettingsSection, values: Record<string, PublicValue>): Draft {
  const draft: Draft = {};
  for (const field of section.fields) {
    if (field.type === "secret") draft[field.key] = "";
    else if (field.type === "boolean") draft[field.key] = Boolean(values[field.key]);
    else draft[field.key] = values[field.key] === undefined ? "" : String(values[field.key]);
  }
  return draft;
}

function isSecretSet(value: PublicValue | undefined): boolean {
  return typeof value === "object" && value !== null && (value as SecretState).set;
}

export function SettingsForm({
  section,
  values,
  onSaved,
}: {
  section: SettingsSection;
  values: Record<string, PublicValue>;
  onSaved: (response: SettingsResponse) => void;
}) {
  const saved = useMemo(() => toDraft(section, values), [section, values]);
  const [draft, setDraft] = useState<Draft>(saved);
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const changes = useMemo(() => {
    const update: SettingsUpdate = {};
    for (const field of section.fields) {
      const value = draft[field.key];
      if (field.type === "secret") {
        if (remove.has(field.key)) update[field.key] = null;
        else if (typeof value === "string" && value.trim() !== "") update[field.key] = value;
      } else if (value !== saved[field.key]) {
        update[field.key] = value as FieldValue;
      }
    }
    return update;
  }, [draft, remove, saved, section.fields]);
  const dirty = Object.keys(changes).length > 0;

  // Pick up changes saved elsewhere, unless the user is mid-edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: react only to newly saved values
  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved]);

  const save = async (): Promise<boolean> => {
    if (!dirty) return true;
    try {
      const response = await api.put<SettingsResponse>(`/api/settings/${section.scope}`, changes);
      setErrors({});
      setRemove(new Set());
      setDraft(toDraft(section, response.values[section.scope] ?? {}));
      onSaved(response);
      return true;
    } catch (error) {
      const body = error instanceof ApiError ? (error.body as SettingsErrorResponse | null) : null;
      setErrors(body?.fields ?? {});
      setStatus({ ok: false, message: (error as Error).message });
      return false;
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    if (await save()) setStatus({ ok: true, message: "Saved." });
    setBusy(false);
  };

  const onTest = async () => {
    setBusy(true);
    setStatus(null);
    if (await save()) {
      try {
        setStatus(await api.post<TestResult>(`/api/integrations/${section.scope}/test`));
      } catch (error) {
        setStatus({ ok: false, message: (error as Error).message });
      }
    }
    setBusy(false);
  };

  return (
    <form className="card settings" onSubmit={onSubmit}>
      <header className="card-head">
        <h2>{section.title}</h2>
      </header>
      {section.description && <p className="muted">{section.description}</p>}
      {section.fields.map((field) => (
        <Field
          key={field.key}
          id={`${section.scope}-${field.key}`}
          field={field}
          value={draft[field.key] ?? ""}
          secretSet={isSecretSet(values[field.key])}
          removing={remove.has(field.key)}
          error={errors[field.key]}
          onChange={(value) => setDraft({ ...draft, [field.key]: value })}
          onRemove={() => {
            const next = new Set(remove);
            if (next.has(field.key)) next.delete(field.key);
            else next.add(field.key);
            setRemove(next);
          }}
        />
      ))}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !dirty}>
          Save
        </button>
        {section.testable && (
          <button type="button" disabled={busy} onClick={onTest}>
            {dirty ? "Save & test" : "Test"}
          </button>
        )}
        {status && (
          <span className={status.ok ? "good" : "bad"} role="status">
            {status.message}
          </span>
        )}
      </div>
    </form>
  );
}

function Field({
  id,
  field,
  value,
  secretSet,
  removing,
  error,
  onChange,
  onRemove,
}: {
  id: string;
  field: FieldSpec;
  value: string | boolean;
  secretSet: boolean;
  removing: boolean;
  error?: string;
  onChange: (value: string | boolean) => void;
  onRemove: () => void;
}) {
  const help = error ? (
    <span className="bad">{error}</span>
  ) : (
    field.help && <span className="muted">{field.help}</span>
  );

  if (field.type === "boolean") {
    return (
      <div className="field checkbox">
        <label htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.label}
        </label>
        {help}
      </div>
    );
  }

  let input: ReactNode;
  if (field.type === "select") {
    input = (
      <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (field.type === "secret") {
    input = (
      <div className="secret">
        <input
          id={id}
          type="password"
          autoComplete="off"
          value={String(value)}
          disabled={removing}
          placeholder={
            removing ? "Will be removed on save" : secretSet ? "Saved — type to replace" : "Not set"
          }
          onChange={(e) => onChange(e.target.value)}
        />
        {secretSet && (
          <button type="button" className="small" onClick={onRemove}>
            {removing ? "Keep" : "Remove"}
          </button>
        )}
      </div>
    );
  } else {
    const type = field.type === "number" ? "number" : field.type === "time" ? "time" : "text";
    input = (
      <input
        id={id}
        type={type}
        value={String(value)}
        min={field.min}
        max={field.max}
        placeholder={field.placeholder}
        list={field.type === "timezone" ? "time-zones" : undefined}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div className="field">
      <label htmlFor={id}>{field.label}</label>
      {input}
      {help}
    </div>
  );
}

/** One shared list of time zones for every time-zone field. */
export function TimeZoneList() {
  return (
    <datalist id="time-zones">
      {timeZones.map((zone) => (
        <option key={zone} value={zone} />
      ))}
    </datalist>
  );
}

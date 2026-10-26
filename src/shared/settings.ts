// Settings are declared as field specs. The server validates against them and
// the UI renders forms from them, so a tool gets a settings page for free.

export type FieldType =
  | "string"
  | "url"
  | "number"
  | "boolean"
  | "time"
  | "secret"
  | "select"
  | "timezone";

export type FieldValue = string | number | boolean;

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  default?: FieldValue;
  help?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

export interface SettingsSection {
  scope: string;
  title: string;
  description?: string;
  group: "core" | "integration" | "tool";
  fields: FieldSpec[];
  /** Has a "Test" button (POST /api/integrations/:scope/test). */
  testable?: boolean;
}

/** Secrets are write-only: the API only says whether one is saved. */
export interface SecretState {
  set: boolean;
}

export type PublicValue = FieldValue | SecretState;

export interface SettingsResponse {
  sections: SettingsSection[];
  values: Record<string, Record<string, PublicValue>>;
}

/**
 * Update body: field → new value. For secrets: a string replaces the saved
 * value, `null` removes it, and leaving the key out keeps it.
 */
export type SettingsUpdate = Record<string, FieldValue | null>;

export interface SettingsErrorResponse {
  error: string;
  fields?: Record<string, string>;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

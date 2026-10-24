/**
 * types.d.ts — shared shapes for the Quick Apply extension.
 *
 * Every source file here is a classic script, not a module: common.js defines
 * `window.AAF` and the others read it. Declaring `AAF` as an ambient global
 * lets them keep referring to it directly while still being type-checked.
 */

/** A user's saved details. Every field is a plain string. */
interface AAFProfile {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  linkedin: string;
  github: string;
  portfolio: string;
  location: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  workAuthorized: string;
  requireSponsorship: string;
  hearAbout: string;
}

type AAFProfileKey = keyof AAFProfile;

/** One remembered answer, keyed by its normalized question text. */
interface AAFLearnedEntry {
  /** The answer. Multi-select answers are joined with AAF.MULTI_SEPARATOR. */
  value: string;
  /** The question as it appeared on the page, for display in the options UI. */
  sample: string;
  ts: number;
}

type AAFLearned = Record<string, AAFLearnedEntry>;

interface AAFSettings {
  autofillOnLoad: boolean;
  learnFields: boolean;
}

interface AAFState {
  profile: AAFProfile;
  learned: AAFLearned;
  settings: AAFSettings;
}

interface AAFMatcher {
  key: AAFProfileKey;
  test: (normalizedLabel: string) => boolean;
}

interface AAFProfileStats {
  filled: number;
  total: number;
  missingEssential: AAFProfileKey[];
}

/**
 * Cross-browser extension API handle. Chrome exposes `chrome`; Firefox also
 * exposes `browser` with promise-returning methods. The surface used here is
 * compatible across both.
 */
type AAFExtensionApi = typeof chrome;

interface AAFApi {
  readonly api: AAFExtensionApi;
  readonly DEFAULTS: AAFState;
  getAll(): Promise<AAFState>;
  setProfile(profile: AAFProfile): Promise<void>;
  setLearned(learned: AAFLearned): Promise<void>;
  setSettings(settings: AAFSettings): Promise<void>;
  normalizeLabel(s: string | null | undefined): string;
  readonly MATCHERS: readonly AAFMatcher[];
  matchProfileKey(normalizedLabel: string): AAFProfileKey | null;
  workdayFieldKey(suffix: string): AAFProfileKey | null;
  greenhouseFieldKey(id: string): AAFProfileKey | null;
  readonly MULTI_SEPARATOR: string;
  splitMulti(value: string | null | undefined): string[];
  joinMulti(list: readonly string[]): string;
  profileValue(profile: AAFProfile, key: AAFProfileKey): string;
  readonly COMPLETENESS_FIELDS: readonly AAFProfileKey[];
  readonly ESSENTIAL_FIELDS: readonly AAFProfileKey[];
  readonly FIELD_LABELS: Partial<Record<AAFProfileKey, string>>;
  profileStats(profile: AAFProfile): AAFProfileStats;
}

/** Messages exchanged between the popup and the content script. */
type AAFMessage = { type: "AAF_FILL" } | { type: "AAF_STATUS" };

type AAFFillResponse = { ok: true; count: number };
type AAFStatusResponse = { ok: true; fields: number };

declare const AAF: AAFApi;

interface Window {
  AAF: AAFApi;
  /** Set by content.ts so a re-injected copy bails out instead of doubling up. */
  __AAF_CONTENT_LOADED__?: boolean;
}

/** Firefox's WebExtension global. Absent in Chrome, hence the optional shape. */
declare const browser: typeof chrome | undefined;

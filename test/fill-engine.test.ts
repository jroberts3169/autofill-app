/**
 * fill-engine.test.ts — end-to-end checks for the Quick Apply fill engine.
 *
 * Runs the BUILT dist/common.js and dist/content.js against offline fixtures.
 * The extension is never loaded as an extension; both files are injected into
 * the page with a stubbed `chrome.storage` / `chrome.runtime`, and the content
 * script's own AAF_FILL / AAF_STATUS handlers are driven directly. That keeps
 * the engine under test identical to what ships, while letting every case
 * start from a known profile + learned set.
 *
 * No network access. Fixtures are served by intercepting requests to the real
 * job-board URLs, so `location.hostname` is genuinely greenhouse.io — which
 * matters, because the engine's Greenhouse id mapping is hostname-gated. Any
 * request that is NOT a fixture is aborted and recorded as a failure.
 *
 * Usage:
 *   npm install && npx playwright install chromium
 *   npm test                 # builds, then runs. Add -- --headed to watch.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DIST = join(root, "dist");
const FIXTURES = join(here, "fixtures");
const HEADED = process.argv.includes("--headed");

/** Fixtures are served at the real origins so hostname checks behave. */
const GREENHOUSE_URL = "https://job-boards.greenhouse.io/fixtureco/jobs/1000";
const ASHBY_URL = "https://jobs.ashbyhq.com/fixtureco/application";

const FIXTURE_ROUTES: ReadonlyArray<{ pattern: string; file: string }> = [
  { pattern: "https://job-boards.greenhouse.io/**", file: "greenhouse.html" },
  { pattern: "https://jobs.ashbyhq.com/**", file: "ashby.html" }
];

/** Greenhouse element ids used by the fixture. */
const GH = {
  email: "email",
  sponsorNow: "question_2001",
  sponsorFuture: "question_2002",
  hearAbout: "question_2003",
  prevEmployed: "question_2004",
  genderIdentity: "4028768003",
  raceEthnicity: "4028769003"
} as const;

// ---------------------------------------------------------------- harness --

interface Result {
  suite: string;
  name: string;
  pass: boolean;
}

const results: Result[] = [];
const escapedRequests: string[] = [];
let currentSuite = "";

function suite(name: string): void {
  currentSuite = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function check(name: string, pass: boolean, detail?: string): void {
  results.push({ suite: currentSuite, name, pass: !!pass });
  const mark = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  const extra = pass || detail === undefined ? "" : `\n        ${detail}`;
  console.log(`  ${mark}  ${name}${extra}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}\n        actual   ${a}`);
}

// ----------------------------------------------------------------- shared --

interface TestStore {
  profile: Partial<AAFProfileLike>;
  learned: Record<string, { value: string; sample: string; ts: number }>;
  settings: { autofillOnLoad: boolean; learnFields: boolean };
}

/** Mirrors the extension's profile shape; all fields optional in tests. */
interface AAFProfileLike {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  linkedin: string;
  github: string;
  portfolio: string;
  location: string;
  hearAbout: string;
  workAuthorized: string;
  requireSponsorship: string;
}

function sources(): { common: string; content: string } {
  return {
    common: readFileSync(join(DIST, "common.js"), "utf8"),
    content: readFileSync(join(DIST, "content.js"), "utf8")
  };
}

/**
 * Serve the fixtures offline and fail loudly if anything tries to reach the
 * network.
 */
async function serveFixtures(page: Page): Promise<void> {
  // Playwright matches routes most-recently-added first, so the catch-all
  // must be registered BEFORE the fixtures or it would swallow them.
  await page.route("**/*", (route) => {
    escapedRequests.push(route.request().url());
    return route.abort();
  });
  for (const { pattern, file } of FIXTURE_ROUTES) {
    const body = readFileSync(join(FIXTURES, file), "utf8");
    await page.route(pattern, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body })
    );
  }
}

/**
 * Inject the built scripts with a stubbed storage layer. Exposes on the page:
 * __store (backing data) and __msg (the content script's message handler).
 */
async function install(page: Page, initialStore: TestStore): Promise<void> {
  const { common, content } = sources();
  await page.evaluate(
    ([commonSrc, contentSrc, store]) => {
      const w = window as unknown as Record<string, unknown>;
      w.__store = store;
      w.chrome = {
        storage: {
          local: {
            get: async () => JSON.parse(JSON.stringify(w.__store)),
            set: async (obj: Record<string, unknown>) =>
              Object.assign(w.__store as object, obj)
          },
          onChanged: { addListener: () => {} }
        },
        runtime: {
          lastError: null,
          onMessage: {
            addListener: (fn: unknown) => {
              w.__msg = fn;
            }
          }
        }
      };
      // Indirect eval so `window.AAF` lands on the page global, mirroring the
      // two <script> files the manifest injects.
      window.eval(commonSrc as string);
      window.eval(contentSrc as string);
    },
    [common, content, initialStore] as const
  );
  await page.waitForTimeout(300);
}

async function fill(page: Page, settleMs = 1200): Promise<number> {
  const resp = await page.evaluate(
    () =>
      new Promise<{ ok: true; count: number }>((res) => {
        (window as never as { __msg: Function }).__msg({ type: "AAF_FILL" }, {}, res);
      })
  );
  await page.waitForTimeout(settleMs);
  return resp.count;
}

const status = (page: Page): Promise<{ ok: true; fields: number }> =>
  page.evaluate(
    () =>
      new Promise<{ ok: true; fields: number }>((res) => {
        (window as never as { __msg: Function }).__msg({ type: "AAF_STATUS" }, {}, res);
      })
  );

const learned = (page: Page): Promise<TestStore["learned"]> =>
  page.evaluate(() => (window as never as { __store: TestStore }).__store.learned);

async function open(browser: Browser, url: string, readySelector: string): Promise<Page> {
  const page = await browser.newPage();
  await serveFixtures(page);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(readySelector, { timeout: 10000 });
  return page;
}

const openGreenhouse = (b: Browser): Promise<Page> => open(b, GREENHOUSE_URL, "#first_name");
const openAshby = (b: Browser): Promise<Page> => open(b, ASHBY_URL, 'input[type="radio"]');

// ------------------------------------------------------- in-page readers ---
// Serialized into the page, so they may only use browser globals.

function readGreenhouse(ids: Record<string, string>): Record<string, unknown> {
  const clean = (t: string | null): string => (t || "").replace(/\s+/g, " ").trim();
  const shown = (id: string): string | string[] => {
    const el = document.getElementById(id);
    const c = el && el.closest("[class*='select__control']");
    if (!c) return "(missing)";
    const chips = Array.from(c.querySelectorAll("[class*='multi-value__label']")).map((e) =>
      clean(e.textContent)
    );
    if (chips.length) return chips;
    const sv = c.querySelector("[class*='single-value']");
    return sv ? clean(sv.textContent) : "";
  };
  const out: Record<string, unknown> = {};
  Object.keys(ids).forEach((k) => {
    const el = document.getElementById(ids[k]) as HTMLInputElement | null;
    out[k] = !el ? "(missing)" : el.getAttribute("role") === "combobox" ? shown(ids[k]) : el.value;
  });
  const shims = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[aria-hidden="true"]')
  );
  out.__shimCount = shims.length;
  out.__shimsAllEmpty = shims.every((s) => s.value === "");
  return out;
}

function readAshbyRadios(): string[] {
  const clean = (t: string | null): string => (t || "").replace(/\s+/g, " ").trim();
  return Array.from(document.querySelectorAll("fieldset"))
    .filter((f) => f.querySelector("input[type=radio]"))
    .map((f) => {
      const lab = Array.from(f.children).find((c) => c.tagName === "LABEL");
      const q = clean(lab ? lab.textContent : "");
      const on = f.querySelector<HTMLInputElement>("input[type=radio]:checked");
      const opt = on
        ? clean(document.querySelector(`label[for="${CSS.escape(on.id)}"]`)?.textContent ?? "")
        : "(none)";
      return `${q} => ${opt}`;
    });
}

function readAshbyYesNo(): string[] {
  const clean = (t: string | null): string => (t || "").replace(/\s+/g, " ").trim();
  return Array.from(document.querySelectorAll("[class*='_yesno_']")).map((g) => {
    let p: Element | null = g;
    let q = "?";
    for (let i = 0; i < 4 && p; i++) {
      p = p.parentElement;
      if (!p) break;
      const l = p.querySelector(":scope > label");
      if (l) {
        q = clean(l.textContent);
        break;
      }
    }
    const on = Array.from(g.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-pressed") === "true"
    );
    return `${q} => ${on ? clean(on.textContent) : "(none)"}`;
  });
}

/**
 * Each visible field's DOM value vs the controlled copy the fixture keeps.
 * A mismatch is the "the form doesn't think there's any text there" bug.
 */
function readControlledStateMismatches(): Array<{ field: string; dom: string; state: string }> {
  const clean = (t: string | null): string => (t || "").replace(/\s+/g, " ").trim();
  const out: Array<{ field: string; dom: string; state: string }> = [];
  document.querySelectorAll("input, textarea").forEach((node) => {
    const el = node as HTMLInputElement & { __reactValue?: string };
    if (["hidden", "file", "radio", "checkbox", "submit"].includes(el.type)) return;
    if (el.__reactValue === undefined) return; // not a controlled field
    const dom = clean(el.value);
    if (!dom) return;
    if (clean(el.__reactValue) !== dom) {
      out.push({
        field: clean(el.getAttribute("aria-label") || el.id || "?").slice(0, 40),
        dom,
        state: String(el.__reactValue)
      });
    }
  });
  return out;
}

// ------------------------------------------------------------- the tests ---

const PROFILE: Partial<AAFProfileLike> = {
  firstName: "Jeff",
  lastName: "Roberts",
  fullName: "Jeff Roberts",
  email: "jeff@example.com",
  phone: "5125550143",
  linkedin: "https://linkedin.com/in/jeffroberts",
  github: "https://github.com/jroberts3169",
  portfolio: "https://jeff.dev",
  location: "Austin, TX",
  hearAbout: "LinkedIn",
  workAuthorized: "Yes",
  requireSponsorship: "No"
};

async function greenhouseFill(browser: Browser): Promise<void> {
  suite("Greenhouse — fill");
  const page = await openGreenhouse(browser);
  try {
    await install(page, {
      profile: PROFILE,
      learned: {
        // Stored exactly as the learner would record them.
        "how do you identify? (gender identity)": { value: "Male", sample: "g", ts: 1 },
        "how do you identify? (race/ethnicity)": { value: "White | East Asian", sample: "r", ts: 2 },
        "have you previously been employed at fixture co for any length of time?": {
          value: "I have not previously been employed at Fixture Co",
          sample: "p",
          ts: 3
        }
      },
      settings: { autofillOnLoad: false, learnFields: true }
    });

    eq("hostname is a real greenhouse.io origin", await page.evaluate(() => location.hostname), "job-boards.greenhouse.io");

    const st = await status(page);
    check("AAF_STATUS reports form fields", st.ok && st.fields > 5, `fields=${st.fields}`);

    const first = await fill(page);
    const after = (await page.evaluate(readGreenhouse, GH as unknown as Record<string, string>)) as Record<string, unknown>;

    check("filled a meaningful number of fields", first >= 8, `count=${first}`);
    eq("email (matched by stable Greenhouse id)", after.email, PROFILE.email);
    eq("sponsorship now (react-select)", after.sponsorNow, "No");
    eq("sponsorship future (react-select)", after.sponsorFuture, "No");
    eq("source (react-select)", after.hearAbout, "LinkedIn");
    eq("learned long-sentence option", after.prevEmployed, "I have not previously been employed at Fixture Co");
    eq("demographic single-select", after.genderIdentity, "Male");
    eq("demographic MULTI-select", after.raceEthnicity, ["White", "East Asian"]);

    // Greenhouse renders an aria-hidden input per required dropdown purely for
    // native validation. Writing into one is invisible to the user.
    check("aria-hidden shim inputs left empty", after.__shimsAllEmpty as boolean, `shims=${after.__shimCount}`);

    eq("second fill is a no-op (idempotent)", await fill(page), 0);
    const afterSecond = (await page.evaluate(readGreenhouse, GH as unknown as Record<string, string>)) as Record<string, unknown>;
    eq("multi-select did not accumulate duplicates", afterSecond.raceEthnicity, ["White", "East Asian"]);

    const store = await learned(page);
    eq(
      "engine did not re-learn its own fill",
      store["how do you identify? (race/ethnicity)"].value,
      "White | East Asian"
    );
  } finally {
    await page.close();
  }
}

async function greenhouseLearning(browser: Browser): Promise<void> {
  suite("Greenhouse — learning");
  const page = await openGreenhouse(browser);
  try {
    await install(page, {
      profile: {},
      learned: {},
      settings: { autofillOnLoad: false, learnFields: true }
    });

    const RACE = GH.raceEthnicity;
    const key = "how do you identify? (race/ethnicity)";

    // Drive the widget the way a real click does: the menu opens on mousedown
    // and an option commits on mousedown, unmounting before any click lands.
    const picked = await page.evaluate(async (raceId: string) => {
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      const fire = (n: Element, t: string): boolean =>
        n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, view: window }));
      const ctrl = (): Element =>
        document.getElementById(raceId)!.closest("[class*='select__control']")!;
      const pick = async (text: string): Promise<boolean> => {
        document.getElementById(raceId)!.focus();
        fire(ctrl(), "mousedown");
        await sleep(120);
        const opt = Array.from(
          document.querySelectorAll(`[id^="react-select-${raceId}-option"]`)
        ).find((o) => o.textContent!.trim() === text);
        if (!opt) return false;
        fire(opt, "mousedown");
        await sleep(200);
        return true;
      };
      return (await pick("White")) && (await pick("East Asian"));
    }, RACE);
    check("picked two multi-select options", picked);
    await page.waitForTimeout(500);

    eq("multi-select stored as a joined list", (await learned(page))[key]?.value, "White | East Asian");

    // Removing one chip should update the stored answer.
    await page.evaluate((raceId: string) => {
      const ctrl = document.getElementById(raceId)!.closest("[class*='select__control']")!;
      const rm = ctrl.querySelector("[class*='multi-value__remove']")!;
      rm.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, view: window }));
    }, RACE);
    await page.waitForTimeout(600);
    eq("removing a chip updates the stored answer", (await learned(page))[key]?.value, "East Asian");

    // Clearing forgets it. The clear control has no `clear-indicator` class,
    // so it must be matched by accessible name.
    await page.evaluate((raceId: string) => {
      const ctrl = document.getElementById(raceId)!.closest("[class*='select__control']")!;
      const clear = Array.from(ctrl.querySelectorAll("button[aria-label]")).find((b) =>
        /clear/i.test(b.getAttribute("aria-label") || "")
      )!;
      clear.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, view: window }));
    }, RACE);
    await page.waitForTimeout(700);
    check("clearing the field forgets the answer", !(key in (await learned(page))));
  } finally {
    await page.close();
  }
}

async function ashbyFill(browser: Browser): Promise<void> {
  suite("Ashby — fill");
  const page = await openAshby(browser);
  try {
    await install(page, {
      profile: PROFILE,
      learned: {
        pronouns: { value: "He/him", sample: "p", ts: 1 },
        "employment status": { value: "Employed Full-Time", sample: "e", ts: 2 },
        gender: { value: "Male", sample: "g", ts: 3 },
        race: { value: "White (Not Hispanic or Latino)", sample: "r", ts: 4 },
        "veteran status": { value: "I am not a protected veteran", sample: "v", ts: 5 },
        "zip code": { value: "78701", sample: "z", ts: 6 },
        "are you over 18 years of age?": { value: "Yes", sample: "o", ts: 7 },
        "have you ever worked for fixture co or one of our companies before?": { value: "No", sample: "w", ts: 8 },
        "have you applied for employment with fixture co before?": { value: "No", sample: "a", ts: 9 },
        "i acknowledge and agree to these application conditions.": { value: "Yes", sample: "i", ts: 10 }
      },
      settings: { autofillOnLoad: false, learnFields: true }
    });

    const urlBefore = page.url();
    const first = await fill(page, 2000);
    check("filled a meaningful number of fields", first >= 13, `count=${first}`);

    // Ashby's radios are opacity:0 inputs behind styled markup, and each one's
    // label[for] is the OPTION while the fieldset's label is the QUESTION.
    eq("radio groups", await page.evaluate(readAshbyRadios), [
      "Pronouns => He/him",
      "Employment Status => Employed Full-Time",
      "Gender => Male", // not "Female": exact match must beat substring
      "Race => White (Not Hispanic or Latino)",
      "Veteran Status => I am not a protected veteran"
    ]);

    // Ashby renders Yes/No questions as <button aria-pressed>, not radios.
    const yesno = await page.evaluate(readAshbyYesNo);
    const joined = yesno.join("\n        ");
    check("all six Yes/No groups answered", yesno.length === 6 && yesno.every((l) => !l.endsWith("(none)")), joined);
    check(
      "work authorization answered from profile",
      yesno.some((l) => l.startsWith("Are you legally authorized") && l.endsWith("=> Yes")),
      joined
    );
    check(
      "sponsorship answered from profile",
      yesno.some((l) => l.includes("require sponsorship") && l.endsWith("=> No")),
      joined
    );

    // Those buttons default to type=submit; nothing may navigate.
    eq("no navigation / submission occurred", page.url(), urlBefore);

    eq("second fill is a no-op (idempotent)", await fill(page, 2000), 0);
    eq("third fill is a no-op (idempotent)", await fill(page, 2000), 0);

    eq("DOM and controlled state agree on every field", await page.evaluate(readControlledStateMismatches), []);

    // Visible text is not enough: Ashby validates the value it committed to its
    // submit payload via onChange, so every text field must have reached it.
    eq(
      "text fields reached the submit payload",
      await page.evaluate(() => {
        const c = (window as never as { __ashbyCommitted: Record<string, string> }).__ashbyCommitted;
        return ["_systemfield_name", "_systemfield_email", "_systemfield_phone"].filter(
          (id) => !c[id]
        );
      }),
      []
    );
  } finally {
    await page.close();
  }
}
/**
 * Visible text is not enough on Ashby: a field is accepted only if the engine
 * drove the value through a real edit (native setter + input event), which is
 * what commits it to the submit payload. An earlier engine blanked the field
 * first, making React coalesce the two edits into "no net change" so the value
 * showed on screen but submitted blank ("this field is required").
 */
async function ashbyCommitsSubmitPayload(browser: Browser): Promise<void> {
  suite("Ashby — commits fields to the submit payload");
  const page = await openAshby(browser);
  try {
    await install(page, {
      profile: PROFILE,
      learned: { "zip code": { value: "78701", sample: "z", ts: 6 } },
      settings: { autofillOnLoad: false, learnFields: true }
    });

    await fill(page, 2000);

    const state = await page.evaluate(() => {
      const committed = (window as never as { __ashbyCommitted: Record<string, string> })
        .__ashbyCommitted;
      const shown: Record<string, string> = {};
      ["_systemfield_name", "_systemfield_email", "_systemfield_phone", "field_linkedin"].forEach(
        (id) => {
          const el = document.getElementById(id) as HTMLInputElement | null;
          if (el) shown[id] = el.value;
        }
      );
      return { committed, shown };
    });

    // Every field the engine wrote must also have reached the submit payload.
    const notCommitted = Object.keys(state.shown).filter(
      (id) => state.shown[id] && state.committed[id] !== state.shown[id]
    );
    eq("every filled field reached the submit payload", notCommitted, []);
    eq("name committed", state.committed._systemfield_name, "Jeff Roberts");
    eq("email committed", state.committed._systemfield_email, "jeff@example.com");
    eq("phone committed", state.committed._systemfield_phone, "5125550143");
    eq(
      "linkedin committed",
      state.committed.field_linkedin,
      "https://linkedin.com/in/jeffroberts"
    );

    eq("second fill is still a no-op (idempotent)", await fill(page, 2000), 0);
  } finally {
    await page.close();
  }
}

async function ashbyLocationTypeahead(browser: Browser): Promise<void> {
  suite("Ashby — location typeahead");
  const page = await openAshby(browser);
  try {
    await install(page, {
      profile: { fullName: "Jeff Roberts", email: "jeff@example.com", location: "Austin, TX" },
      learned: {},
      settings: { autofillOnLoad: false, learnFields: true }
    });

    await fill(page, 2000);

    const loc = await page.evaluate(() => {
      const combo = document.querySelector<HTMLInputElement & { __reactValue?: string }>(
        '[role="combobox"]'
      )!;
      return {
        value: combo.value,
        state: combo.__reactValue,
        expanded: combo.getAttribute("aria-expanded"),
        openListboxes: Array.from(document.querySelectorAll('[role="listbox"]')).filter(
          (l) => !(l as HTMLElement).hidden
        ).length
      };
    });

    // "Austin, TX" appears in no suggestion verbatim. The engine must still
    // commit a real suggestion, or the form keeps loose text that it discards.
    eq("committed the canonical suggestion", loc.value, "Austin, Texas, United States");
    eq("committed value survives in the controlled state", loc.state, "Austin, Texas, United States");
    eq("suggestion menu was closed", loc.expanded, "false");
    eq("no autocomplete popup left open", loc.openListboxes, 0);

    eq("second fill is a no-op (idempotent)", await fill(page, 2000), 0);
  } finally {
    await page.close();
  }
}

async function ashbyLearning(browser: Browser): Promise<void> {
  suite("Ashby — learning");
  const page = await openAshby(browser);
  try {
    await install(page, {
      profile: { workAuthorized: "Yes", requireSponsorship: "No" },
      learned: {},
      settings: { autofillOnLoad: false, learnFields: true }
    });

    const clicked = await page.evaluate(() => {
      const clean = (t: string | null): string => (t || "").replace(/\s+/g, " ").trim();

      // A radio: question on the fieldset, option on label[for].
      const fs = Array.from(document.querySelectorAll("fieldset")).find((f) => {
        const l = Array.from(f.children).find((c) => c.tagName === "LABEL");
        return l && clean(l.textContent) === "Pronouns";
      })!;
      const radio = Array.from(fs.querySelectorAll<HTMLInputElement>("input[type=radio]")).find(
        (r) =>
          clean(document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.textContent ?? "") ===
          "They/them"
      )!;
      radio.click();

      const qOf = (g: Element): string => {
        let p: Element | null = g;
        for (let i = 0; i < 4 && p; i++) {
          p = p.parentElement;
          if (!p) break;
          const l = p.querySelector(":scope > label");
          if (l) return clean(l.textContent);
        }
        return "";
      };
      const groups = Array.from(document.querySelectorAll("[class*='_yesno_']"));
      const pickYesNo = (prefix: string, text: string): void => {
        const g = groups.find((x) => qOf(x).startsWith(prefix))!;
        Array.from(g.querySelectorAll("button"))
          .find((b) => clean(b.textContent) === text)!
          .click();
      };

      pickYesNo("Are you over 18", "Yes");
      pickYesNo("Are you legally authorized", "Yes"); // profile-backed: must NOT be learned
      return true;
    });
    check("exercised radio + button + profile-backed inputs", clicked);
    await page.waitForTimeout(700);

    const store = await learned(page);
    // Before the fix this stored key "they/them" with the value "on".
    eq("radio learned by question, not option", store.pronouns?.value, "They/them");
    eq("Yes/No button learned", store["are you over 18 years of age?"]?.value, "Yes");
    check(
      "profile-backed question was not learned",
      !Object.keys(store).some((k) => k.includes("legally authorized")),
      JSON.stringify(Object.keys(store))
    );
  } finally {
    await page.close();
  }
}

// ------------------------------------------------------------------ main ---

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: !HEADED });
  try {
    const tests = [
      greenhouseFill,
      greenhouseLearning,
      ashbyFill,
      ashbyCommitsSubmitPayload,
      ashbyLocationTypeahead,
      ashbyLearning
    ];
    for (const t of tests) {
      try {
        await t(browser);
      } catch (err) {
        check(`${t.name} threw`, false, String(err instanceof Error ? err.message : err).slice(0, 300));
      }
    }
  } finally {
    await browser.close();
  }

  suite("Offline guarantee");
  check(
    "no request escaped to the network",
    escapedRequests.length === 0,
    escapedRequests.slice(0, 5).join("\n        ")
  );

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFailed:");
    failed.forEach((f) => console.log(`  - [${f.suite}] ${f.name}`));
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

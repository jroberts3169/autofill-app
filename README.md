# Quick Apply (Autofill)

A small browser extension that autofills **your own** details on
[AshbyHQ](https://www.ashbyhq.com/), **Greenhouse**, and **Workday** job
application forms so you can apply in seconds instead of minutes. It is
**fill-only**: it never submits an application, and it never fills sign-in /
create-account screens. You always review the form and click submit yourself.

## What it does

- Runs on `*.ashbyhq.com`, `*.greenhouse.io`, `*.myworkdayjobs.com`, and
  `*.myworkdaysite.com` pages (including forms embedded via iframe).
- Fills standard fields from your saved profile: name, email, phone, address
  (line 1/2, city, state, postal code, country), LinkedIn / GitHub / portfolio,
  location, work-authorization / sponsorship, and "how did you hear about us".
- On **Workday**, matches fields by their stable `data-automation-id`
  (e.g. `formField-legalName--firstName`) and fills its button-based dropdowns
  (State, Country, source, …). The multi-step wizard is filled one page at a
  time — click **Fill** on each step (My Information, My Experience, Questions,
  …).
- On **Greenhouse**, matches the built-in fields by their stable element ids
  (`first_name`, `last_name`, `email`, `phone`) and fills its react-select
  dropdowns (sponsorship, source, custom questions) by picking the matching
  option.
- On **Ashby**, fills radio groups (Pronouns, Employment Status, EEO
  questions, …) and the large Yes/No questions, which Ashby renders as
  `<button aria-pressed>` toggles rather than form controls. Both are matched
  by the question being asked, not by the text of an individual option.
- **Never** fills sign-in / create-account screens, and never submits.
- **Learns** other questions as you fill them and auto-fills the same question
  next time it appears. Dropdown answers are learned when you pick an option,
  including multi-select questions (e.g. Greenhouse's race/ethnicity), which
  are stored as one `A | B` string and re-selected one option at a time.
  Removing a choice or clearing the field updates the stored answer too.
- Sets values the React-based forms actually register (native setter +
  `input`/`change` events).
- Shows a toast reminding you to review before submitting.

Your data lives only in the browser's extension storage on this device. There
is no network/telemetry.

## Build

The extension is written in TypeScript. `tsc` emits plain classic scripts (no
bundler, no modules) and the manifest plus HTML pages are copied beside them,
so **`dist/` is the loadable unpacked extension**.

```sh
npm install
npm run build       # tsc + copy manifest/HTML into dist/
npm run watch       # rebuild on save while developing
npm run typecheck   # extension + test sources
```

## Install (developer / unpacked)

Build first — `dist/` will not exist until you do.

### Chrome / Edge / Brave
1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`dist`** folder.

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select **`dist/manifest.json`**.

(For a permanent Firefox install you'd need to sign/package it via `web-ext`.)

> **After adding a new site (or updating the extension):** reload the extension
> *and* the application tab. Firefox treats MV3 `host_permissions` as opt-in, so
> a newly added site stays blocked until you allow it under
> `about:addons` → Quick Apply → **Permissions** → *Access your data for sites*.
> Until then the popup falls back to injecting its content script on demand when
> you open it, which keeps the **Fill** button working — but **Auto-fill on page
> load** needs the host permission, because nothing of ours runs until you click.

## Troubleshooting

- **"Can't reach this page — reload it and try again."** The content script is
  not running in that tab. Reload the extension, reload the page, and (Firefox)
  grant site access as described above.
- **The popup says "Open an Ashby, Greenhouse, or Workday application"** on what
  looks like a Greenhouse form: the form is probably embedded in an iframe on
  the company's own domain. Open the application on its `greenhouse.io` URL.

## Setup

1. Click the extension icon → **Edit profile & learned fields**.
2. Fill in your profile and **Save profile**.

## Usage

1. Open an Ashby, Greenhouse, or Workday application page (sign in first on
   Workday — login screens are never autofilled).
2. Click the extension icon. The popup reports what it found on the page —
   **Fill this application** is enabled once the form is detected.
3. Review everything, upload your resume, answer any custom questions, and
   submit yourself.
4. On Workday's multi-step wizard, click **Fill** again on each step before
   using its **Save and Continue** button.

The popup also shows a **Profile** completeness meter so you can spot missing
essentials (such as a phone number) before you start an application.

Any custom question you answer is remembered (if **Learn new fields** is on) and
managed under **Learned fields** in the options page, where you can edit or
delete individual entries.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest (Chrome + Firefox); copied into `dist/` by the build |
| `src/types.d.ts` | Shared types + the ambient `AAF` global |
| `src/common.ts` | Storage, defaults, label + Workday/Greenhouse field matchers (shared) |
| `src/content.ts` | Fill engine, learning, toast (Ashby + Greenhouse + Workday) |
| `src/popup.html/.ts` | Toolbar popup: page status, Fill button, profile meter, toggles |
| `src/options.html/.ts` | Profile editor, learned-field manager, import/export |
| `scripts/copy-assets.mjs` | Copies manifest + HTML into `dist/` after `tsc` |
| `test/fill-engine.test.ts` | Offline end-to-end checks |
| `test/fixtures/*.html` | Hand-built stand-ins for Ashby / Greenhouse / Workday forms |

## Tests

[`test/fill-engine.test.ts`](test/fill-engine.test.ts) runs the **built**
`dist/common.js` and `dist/content.js` against offline fixtures in
[`test/fixtures/`](test/fixtures). The extension is never loaded as an
extension; both files are injected into the page with a stubbed
`chrome.storage`, and the content script's own `AAF_FILL` / `AAF_STATUS`
handlers are driven directly — so the engine under test is exactly what ships.

```sh
npm install
npx playwright install chromium
npm test                 # builds first; add -- --headed to watch
```

**Nothing touches the network.** Fixtures are served by intercepting requests
to the real job-board URLs, so `location.hostname` really is `greenhouse.io`
(the engine's Greenhouse id mapping is hostname-gated). Any request that is not
a fixture is aborted and fails the run.

Covered: react-select and multi-select dropdowns, Ashby radio groups and Yes/No
button groups, the location typeahead, learning (including chip removal and
clearing), idempotency (a second fill must change nothing), DOM-vs-controlled
state parity, that each filled field reaches the form's submit payload (not just
the visible value), and that no fill ever navigates or submits.

The fixtures are hand-built reproductions of the DOM contracts observed on real
postings, not scrapes — each quirk is commented with the bug it guards against
(opacity-0 radios, aria-hidden required shims, commit-on-mousedown options,
type-less submit buttons, suggestions that never contain the typed text,
controlled inputs that only commit a value delivered through a real `input`
event). They are deliberately adversarial where it matters: the Gender options
list "Female" before "Male" so that a matcher preferring substring over exact
match fails loudly.

The trade-off is that fixtures can drift from the real sites. If a form stops
filling in the wild, fix it against the live page first, then fold the new
quirk into the fixture so it stays covered.

## Notes & limits

- Resume upload and other file inputs are intentionally never touched.
- Ashby mirrors each field's live value into a separate value that its submit
  validation reads, so filling has to look like a real edit: the engine focuses
  the field, sets the value through the native setter and fires a genuine
  `input` event (what React's `onChange` reads), then blurs — one field at a
  time, yielding briefly between fields so each commit lands before the next.
  Just assigning the value leaves the text on screen but submits blank
  ("this field is required"). An earlier version also blanked the field first,
  which made React coalesce the two edits into "no change" and never commit.
- A `<button>` with no explicit `type` defaults to submit. Ashby's Yes/No
  toggles sit outside any `<form>`, but the fill engine still refuses to click
  any option button that could submit a form.
- Dropdown and radio answers are matched by option text: an exact match wins,
  and substring matching is only used for answers of four characters or more,
  so a "No" is never turned into a "Not applicable" and a "Male" never selects
  "Female". If an answer has no matching option the field is left alone rather
  than guessed at.
- Multi-select answers are stored as `A | B`, so an option whose own text
  contains a `|` would be split incorrectly. No real option does.
- Workday renders each step on its own page; fill runs per page (click **Fill**
  on each step). Sign-in / create-account pages are never autofilled.
- Ashby, Greenhouse, and Workday can change their markup; matching is defensive
  (Workday uses stable `data-automation-id`s, Greenhouse stable element ids),
  but if a field stops filling, add it once by hand and it will be learned.

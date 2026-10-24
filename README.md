# Quick Apply (Autofill)

A small browser extension that autofills **your own** details on
[AshbyHQ](https://www.ashbyhq.com/) and **Workday** job application forms so you
can apply in seconds instead of minutes. It is **fill-only**: it never submits an
application, and it never fills sign-in / create-account screens. You always
review the form and click submit yourself.

## What it does

- Runs on `*.ashbyhq.com`, `*.myworkdayjobs.com`, and `*.myworkdaysite.com`
  pages (including forms embedded via iframe).
- Fills standard fields from your saved profile: name, email, phone, address
  (line 1/2, city, state, postal code, country), LinkedIn / GitHub / portfolio,
  location, work-authorization / sponsorship, and "how did you hear about us".
- On **Workday**, matches fields by their stable `data-automation-id`
  (e.g. `formField-legalName--firstName`) and fills its button-based dropdowns
  (State, Country, source, …). The multi-step wizard is filled one page at a
  time — click **Fill** on each step (My Information, My Experience, Questions,
  …).
- **Learns** other questions as you fill them and auto-fills the same question
  next time it appears.
- Sets values the React-based forms actually register (native setter +
  `input`/`change` events).
- Shows a toast reminding you to review before submitting.

Your data lives only in the browser's extension storage on this device. There
is no network/telemetry.

## Install (developer / unpacked)

### Chrome / Edge / Brave
1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`ashby-autofill`).

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` in this folder.

(For a permanent Firefox install you'd need to sign/package it via `web-ext`.)

## Setup

1. Click the extension icon → **Edit profile & learned fields**.
2. Fill in your profile and **Save profile**.

## Usage

1. Open an Ashby or Workday application page (sign in first on Workday — login
   screens are never autofilled).
2. Click the extension icon → **Fill this application** (or enable
   **Auto-fill on page load** in the popup).
3. Review everything, upload your resume, answer any custom questions, and
   submit yourself.
4. On Workday's multi-step wizard, click **Fill** again on each step before
   using its **Save and Continue** button.

Any custom question you answer is remembered (if **Learn new fields** is on) and
managed under **Learned fields** in the options page, where you can edit or
delete individual entries.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest (Chrome + Firefox) |
| `src/common.js` | Storage, defaults, label + Workday field matchers (shared) |
| `src/content.js` | Fill engine, learning, toast (Ashby + Workday pages) |
| `src/popup.html/.js` | Toolbar popup: Fill button + toggles |
| `src/options.html/.js` | Profile editor, learned-field manager, import/export |

## Notes & limits

- Resume upload and other file inputs are intentionally never touched.
- Custom react-select dropdowns (Ashby) and button-based listboxes (Workday)
  are best-effort; native `<select>`, text, and Yes/No radio groups are the most
  reliable.
- Workday renders each step on its own page; fill runs per page (click **Fill**
  on each step). Sign-in / create-account pages are never autofilled.
- Ashby and Workday can change their markup; matching is defensive (Workday uses
  stable `data-automation-id`s), but if a field stops filling, add it once by
  hand and it will be learned.

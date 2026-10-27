/**
 * repro-ext.mjs — reproduce the live bug using the REAL extension, loaded the
 * same way Chrome loads it: content scripts run in their isolated world.
 *
 *   node scripts/repro-ext.mjs <ashby-application-url> [--profile backup.json]
 *
 * Unlike repro-ashby.mjs (which injects the engine into the page's MAIN world),
 * this loads dist/ as an unpacked extension so content.js runs in the ISOLATED
 * world — exactly as it ships. It seeds chrome.storage with a profile and
 * autofillOnLoad=true, opens the form so the content script auto-fills, then
 * clicks Submit and reports which filled fields Ashby still rejects.
 *
 * Requires a headed context (extensions don't load in old headless).
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DIST = join(root, "dist");

const url = process.argv.find((a) => /^https?:\/\//.test(a));
const profileArg = (() => {
  const i = process.argv.indexOf("--profile");
  return i >= 0 ? process.argv[i + 1] : join(root, "backup.json");
})();

if (!url) {
  console.error("usage: node scripts/repro-ext.mjs <ashby-application-url> [--profile backup.json]");
  process.exit(2);
}

const backup = JSON.parse(readFileSync(profileArg, "utf8"));
const STORE = {
  profile: backup.profile || {},
  learned: backup.learned || {},
  // Trigger the fill by message on a warm form (like the popup), not on load.
  settings: { autofillOnLoad: false, learnFields: false }
};

// Chrome derives an unpacked extension's ID from the SHA-256 of its absolute
// directory path: first 16 bytes, each hex nibble mapped 0-f -> a-p.
function extensionIdFromPath(absPath) {
  const hex = createHash("sha256").update(absPath).digest("hex").slice(0, 32);
  let id = "";
  for (const c of hex) id += String.fromCharCode(97 + parseInt(c, 16));
  return id;
}

async function main() {
  const userDataDir = join(root, ".pw-ext-profile");
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--no-first-run"
    ]
  });

  const extId = extensionIdFromPath(realpathSync(DIST));
  console.log(`extension id (computed): ${extId}`);

  // Seed storage via the extension's own options page (has chrome.storage).
  const seed = await context.newPage();
  await seed.goto(`chrome-extension://${extId}/options.html`);
  await seed.evaluate((store) => chrome.storage.local.set(store), STORE);
  await seed.close();

  const page = await context.newPage();
  console.log(`\nLoading ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input[type=text], input[type=email]", { timeout: 20000 });
  // Let the form fully settle (warm form), like a user opening the popup.
  await page.waitForTimeout(5000);

  // Trigger the fill the same way the popup does: message the content script.
  const trigger = await context.newPage();
  await trigger.goto(`chrome-extension://${extId}/options.html`);
  const fillResult = await trigger.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "*://*.ashbyhq.com/*" });
    const tab = tabs[0];
    if (!tab) return { error: "no ashby tab found" };
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: "AAF_FILL" }, (resp) => {
        resolve({ lastError: chrome.runtime.lastError?.message, resp });
      });
    });
  });
  await trigger.close();
  console.log(`fill trigger: ${JSON.stringify(fillResult)}`);
  await page.waitForTimeout(2000);

  const shown = await page.evaluate(() => {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const out = [];
    document.querySelectorAll("input[type=text],input[type=email],input[type=tel],input[type=url]").forEach((el) => {
      const lab = clean(el.closest("[class*='fieldEntry']")?.querySelector("label")?.textContent).slice(0, 34);
      out.push(`${lab}: ${JSON.stringify(el.value).slice(0, 30)}`);
    });
    document.querySelectorAll("[class*='yesno'],[class*='YesNo']").forEach((g) => {
      let p = g, q = "";
      for (let i = 0; i < 5 && p; i++) { p = p.parentElement; const l = p && p.querySelector(":scope>label"); if (l) { q = clean(l.textContent); break; } }
      const on = Array.from(g.querySelectorAll("button")).find((b) => b.getAttribute("aria-pressed") === "true");
      out.push(`[y/n] ${q.slice(0, 28)}: ${on ? clean(on.textContent) : "(none)"}`);
    });
    return out;
  });
  console.log("\nVisible state after auto-fill:");
  shown.forEach((s) => console.log("  " + s));

  // Submit and read Ashby's validation.
  try {
    await page.locator('button:has-text("Submit Application"), button:has-text("Submit")').first().click({ timeout: 4000 });
  } catch (e) {
    console.log("submit click failed: " + e.message.split("\n")[0]);
  }
  await page.waitForTimeout(2000);

  const errors = await page.evaluate(() => {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const out = [];
    document.querySelectorAll("li p, p").forEach((p) => {
      const t = clean(p.textContent);
      if (/missing entry for required field/i.test(t)) out.push(t.slice(0, 90));
    });
    return Array.from(new Set(out));
  });
  console.log(`\nSubmit → Ashby validation errors (${errors.length}):`);
  errors.forEach((e) => console.log("  ✗ " + e));

  await context.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/* popup.js — controls the toolbar popup. */
(() => {
  const api = AAF.api;
  const $ = (id) => document.getElementById(id);
  const SUPPORTED = /(ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com)/;
  const status = $("status");
  const fillBtn = $("fill");
  let targetTabId = null;

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = kind || "";
  }

  function setChip(kind, text) {
    $("chip").className = "chip" + (kind ? " " + kind : "");
    $("chipText").textContent = text;
  }

  function siteName(url) {
    return /ashbyhq\.com/.test(url) ? "Ashby" : "Workday";
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  async function activeTab() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  function sendMessage(tabId, msg) {
    return new Promise((resolve) => {
      try {
        api.tabs.sendMessage(tabId, msg, (resp) => {
          // Access lastError to silence "no receiving end" logging.
          const err = api.runtime.lastError;
          resolve(err ? null : resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // Probes the active tab so the popup can report what it found before the
  // user clicks, rather than failing afterwards.
  async function detectPage() {
    const tab = await activeTab();
    const url = (tab && tab.url) || "";
    if (!tab || !SUPPORTED.test(url)) {
      setChip("", "Open an Ashby or Workday application");
      fillBtn.disabled = true;
      return;
    }
    const resp = await sendMessage(tab.id, { type: "AAF_STATUS" });
    if (!resp) {
      setChip("warn", "Reload this page to enable filling");
      fillBtn.disabled = true;
      return;
    }
    targetTabId = tab.id;
    fillBtn.disabled = false;
    const n = resp.fields || 0;
    if (n === 0) setChip("warn", `${siteName(url)} — no form fields found yet`);
    else setChip("ok", `${siteName(url)} — ${plural(n, "field")} detected`);
  }

  function renderProfile(profile) {
    const { filled, total, missingEssential } = AAF.profileStats(profile);
    const pct = Math.round((filled / total) * 100);
    const bar = $("profileBar");
    bar.style.width = pct + "%";
    bar.setAttribute("aria-valuenow", String(pct));
    bar.classList.toggle("low", missingEssential.length > 0);
    $("profileCount").textContent = `${filled}/${total}`;

    const hint = $("profileHint");
    if (filled === 0) {
      hint.textContent = "Add your details so there's something to fill.";
    } else if (missingEssential.length) {
      const names = missingEssential.map((k) => AAF.FIELD_LABELS[k] || k);
      hint.textContent = "Missing: " + names.join(", ");
    } else {
      hint.textContent = "";
    }
  }

  async function init() {
    const { profile, learned, settings } = await AAF.getAll();
    $("autofill").checked = !!settings.autofillOnLoad;
    $("learn").checked = !!settings.learnFields;
    renderProfile(profile);
    $("learnedCount").textContent = String(Object.keys(learned).length);
    await detectPage();
  }

  async function saveSettings() {
    const { settings } = await AAF.getAll();
    settings.autofillOnLoad = $("autofill").checked;
    settings.learnFields = $("learn").checked;
    await AAF.setSettings(settings);
  }

  fillBtn.addEventListener("click", async () => {
    if (targetTabId == null) return;
    setStatus("");
    fillBtn.disabled = true;
    fillBtn.classList.add("busy");
    fillBtn.setAttribute("aria-busy", "true");
    const resp = await sendMessage(targetTabId, { type: "AAF_FILL" });
    fillBtn.classList.remove("busy");
    fillBtn.removeAttribute("aria-busy");
    fillBtn.disabled = false;
    if (!resp) {
      setStatus("Couldn't reach the page. Try reloading it.", "err");
    } else if (!resp.count) {
      setStatus("Nothing to fill — no matching fields found.", "warn");
    } else {
      setStatus(`Filled ${plural(resp.count, "field")}.`, "ok");
    }
  });

  $("autofill").addEventListener("change", saveSettings);
  $("learn").addEventListener("change", saveSettings);

  $("options").addEventListener("click", (e) => {
    e.preventDefault();
    if (api.runtime.openOptionsPage) api.runtime.openOptionsPage();
    else window.open(api.runtime.getURL("src/options.html"));
  });

  init();
})();

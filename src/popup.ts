/* popup.ts — controls the toolbar popup. */
(() => {
  const api = AAF.api;
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

  const SUPPORTED = /(ashbyhq\.com|greenhouse\.io|myworkdayjobs\.com|myworkdaysite\.com)/;
  const status = $("status");
  const fillBtn = $<HTMLButtonElement>("fill");
  let targetTabId: number | null = null;

  function setStatus(text: string, kind?: string): void {
    status.textContent = text;
    status.className = kind || "";
  }

  function setChip(kind: string, text: string): void {
    $("chip").className = "chip" + (kind ? " " + kind : "");
    $("chipText").textContent = text;
  }

  function siteName(url: string): string {
    if (/ashbyhq\.com/.test(url)) return "Ashby";
    if (/greenhouse\.io/.test(url)) return "Greenhouse";
    return "Workday";
  }

  function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  function sendMessage<R>(tabId: number, msg: AAFMessage): Promise<R | null> {
    return new Promise((resolve) => {
      try {
        api.tabs.sendMessage(tabId, msg, (resp: R) => {
          // Access lastError to silence "no receiving end" logging.
          const err = api.runtime.lastError;
          resolve(err ? null : resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // The declarative content script does not always run: the manifest may have
  // gained a new site since the extension was loaded, or (Firefox MV3) the
  // host permission may not be granted. Opening the popup grants `activeTab`,
  // so the script can be injected on demand instead. Both files are safe to
  // run twice.
  async function injectContentScript(tabId: number): Promise<boolean> {
    if (!api.scripting || !api.scripting.executeScript) return false;
    try {
      await api.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["common.js", "content.js"]
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  // Probes the active tab so the popup can report what it found before the
  // user clicks, rather than failing afterwards.
  async function detectPage(): Promise<void> {
    const tab = await activeTab();
    const url = (tab && tab.url) || "";
    if (!tab || tab.id === undefined || !SUPPORTED.test(url)) {
      setChip("", "Open an Ashby, Greenhouse, or Workday application");
      fillBtn.disabled = true;
      return;
    }

    let resp = await sendMessage<AAFStatusResponse>(tab.id, { type: "AAF_STATUS" });
    if (!resp && (await injectContentScript(tab.id))) {
      resp = await sendMessage<AAFStatusResponse>(tab.id, { type: "AAF_STATUS" });
    }
    if (!resp) {
      setChip("warn", "Can't reach this page — reload it and try again");
      fillBtn.disabled = true;
      return;
    }

    targetTabId = tab.id;
    fillBtn.disabled = false;
    const n = resp.fields || 0;
    if (n === 0) setChip("warn", `${siteName(url)} — no form fields found yet`);
    else setChip("ok", `${siteName(url)} — ${plural(n, "field")} detected`);
  }

  function renderProfile(profile: AAFProfile): void {
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

  async function init(): Promise<void> {
    const { profile, learned, settings } = await AAF.getAll();
    $<HTMLInputElement>("autofill").checked = !!settings.autofillOnLoad;
    $<HTMLInputElement>("learn").checked = !!settings.learnFields;
    renderProfile(profile);
    $("learnedCount").textContent = String(Object.keys(learned).length);
    await detectPage();
  }

  async function saveSettings(): Promise<void> {
    const { settings } = await AAF.getAll();
    settings.autofillOnLoad = $<HTMLInputElement>("autofill").checked;
    settings.learnFields = $<HTMLInputElement>("learn").checked;
    await AAF.setSettings(settings);
  }

  fillBtn.addEventListener("click", async () => {
    if (targetTabId === null) return;
    setStatus("");
    fillBtn.disabled = true;
    fillBtn.classList.add("busy");
    fillBtn.setAttribute("aria-busy", "true");
    const resp = await sendMessage<AAFFillResponse>(targetTabId, { type: "AAF_FILL" });
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
    else window.open(api.runtime.getURL("options.html"));
  });

  init();
})();

/* popup.js — controls the toolbar popup. */
(() => {
  const api = AAF.api;
  const $ = (id) => document.getElementById(id);
  const status = $("status");

  async function init() {
    const { settings } = await AAF.getAll();
    $("autofill").checked = !!settings.autofillOnLoad;
    $("learn").checked = !!settings.learnFields;
  }

  async function saveSettings() {
    const { settings } = await AAF.getAll();
    settings.autofillOnLoad = $("autofill").checked;
    settings.learnFields = $("learn").checked;
    await AAF.setSettings(settings);
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

  $("fill").addEventListener("click", async () => {
    status.textContent = "";
    const tab = await activeTab();
    if (!tab || !/ashbyhq\.com/.test(tab.url || "")) {
      status.textContent = "Open an Ashby application page first.";
      return;
    }
    $("fill").disabled = true;
    const resp = await sendMessage(tab.id, { type: "AAF_FILL" });
    $("fill").disabled = false;
    if (!resp) {
      status.textContent = "Couldn't reach the page. Try reloading it.";
    } else {
      status.textContent = `Filled ${resp.count} field${resp.count === 1 ? "" : "s"}.`;
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

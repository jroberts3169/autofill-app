/* options.ts — profile editor + learned-field manager + import/export. */
(() => {
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

  const PROFILE_FIELDS: AAFProfileKey[] = [
    "firstName",
    "lastName",
    "fullName",
    "email",
    "phone",
    "linkedin",
    "github",
    "portfolio",
    "location",
    "addressLine1",
    "addressLine2",
    "city",
    "state",
    "postalCode",
    "country",
    "workAuthorized",
    "requireSponsorship",
    "hearAbout"
  ];

  function flash(el: HTMLElement, text: string): void {
    el.textContent = text;
    setTimeout(() => (el.textContent = ""), 1800);
  }

  async function loadProfile(): Promise<void> {
    const { profile } = await AAF.getAll();
    for (const key of PROFILE_FIELDS) {
      const input = $<HTMLInputElement>(key);
      if (input) input.value = profile[key] || "";
    }
  }

  $("save").addEventListener("click", async () => {
    const { profile } = await AAF.getAll();
    for (const key of PROFILE_FIELDS) {
      const input = $<HTMLInputElement>(key);
      if (input) profile[key] = input.value.trim();
    }
    await AAF.setProfile(profile);
    flash($("saved"), "Saved ✓");
  });

  // ---------- Learned fields ----------

  async function renderLearned(): Promise<void> {
    const { learned } = await AAF.getAll();
    const body = $("learnedBody");
    body.innerHTML = "";
    const keys = Object.keys(learned).sort();
    if (keys.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="3" class="empty">Nothing learned yet.</td>';
      body.appendChild(tr);
      return;
    }
    for (const key of keys) {
      const entry = learned[key];
      const tr = document.createElement("tr");

      const tdLabel = document.createElement("td");
      tdLabel.textContent = entry.sample || key;

      const tdVal = document.createElement("td");
      const input = document.createElement("input");
      input.type = "text";
      input.value = entry.value || "";
      input.dataset.key = key;
      tdVal.appendChild(input);

      const tdDel = document.createElement("td");
      tdDel.className = "del";
      const btn = document.createElement("button");
      btn.textContent = "Delete";
      btn.addEventListener("click", async () => {
        const { learned: cur } = await AAF.getAll();
        delete cur[key];
        await AAF.setLearned(cur);
        renderLearned();
      });
      tdDel.appendChild(btn);

      tr.append(tdLabel, tdVal, tdDel);
      body.appendChild(tr);
    }
  }

  $("saveLearned").addEventListener("click", async () => {
    const { learned } = await AAF.getAll();
    const inputs = $("learnedBody").querySelectorAll<HTMLInputElement>("input[data-key]");
    inputs.forEach((inp) => {
      const key = inp.dataset.key;
      if (key && learned[key]) learned[key].value = inp.value;
    });
    await AAF.setLearned(learned);
    flash($("learnedSaved"), "Saved ✓");
  });

  $("clearLearned").addEventListener("click", async () => {
    if (!confirm("Delete all learned fields?")) return;
    await AAF.setLearned({});
    renderLearned();
    flash($("learnedSaved"), "Cleared");
  });

  // ---------- Import / export ----------

  $("export").addEventListener("click", async () => {
    const { profile, learned, settings } = await AAF.getAll();
    $<HTMLTextAreaElement>("ioBox").value = JSON.stringify({ profile, learned, settings }, null, 2);
  });

  $("import").addEventListener("click", async () => {
    try {
      const data = JSON.parse($<HTMLTextAreaElement>("ioBox").value) as Partial<AAFState>;
      if (data.profile) await AAF.setProfile({ ...AAF.DEFAULTS.profile, ...data.profile });
      if (data.learned) await AAF.setLearned(data.learned);
      if (data.settings) await AAF.setSettings({ ...AAF.DEFAULTS.settings, ...data.settings });
      await loadProfile();
      await renderLearned();
      alert("Imported ✓");
    } catch (e) {
      alert("Invalid JSON: " + (e instanceof Error ? e.message : String(e)));
    }
  });

  loadProfile();
  renderLearned();
})();

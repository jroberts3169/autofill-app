/*
 * content.js — runs on AshbyHQ and Workday application pages.
 * - Fills known profile fields + previously learned fields.
 * - Learns new field values as you type them (change events).
 * - Never submits, and never fills sign-in / create-account screens.
 */
(() => {
  "use strict";

  let STATE = null;
  let autofilledForForm = false;

  async function loadState() {
    STATE = await AAF.getAll();
  }

  AAF.api.storage.onChanged.addListener((changes, area) => {
    if (area === "local") loadState();
  });

  // ---------- DOM helpers ----------

  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function cleanText(t) {
    return (t || "").replace(/\s+/g, " ").trim();
  }

  // Best-effort label resolution for a form control.
  function labelText(el) {
    const alb = el.getAttribute && el.getAttribute("aria-labelledby");
    if (alb) {
      const t = alb
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n ? n.textContent : "";
        })
        .join(" ");
      if (cleanText(t)) return cleanText(t);
    }

    const al = el.getAttribute && el.getAttribute("aria-label");
    if (al) return cleanText(al);

    if (el.id) {
      const l = document.querySelector(`label[for="${esc(el.id)}"]`);
      if (l) return cleanText(l.textContent);
    }

    const wrap = el.closest("label");
    if (wrap) return cleanText(wrap.textContent);

    // Walk up a few ancestors looking for a nearby label/legend.
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const lbl = node.querySelector(":scope > label, :scope > legend, :scope label, :scope legend");
      if (lbl && cleanText(lbl.textContent) && cleanText(lbl.textContent).length <= 120) {
        return cleanText(lbl.textContent);
      }
      if (node.matches && node.matches("form, [class*='application-form'], main, body")) break;
    }

    if (el.placeholder) return cleanText(el.placeholder);
    if (el.name) return cleanText(el.name);
    return "";
  }

  // ---------- React-aware value setting ----------

  function setNativeValue(el, value) {
    const tag = el.tagName;
    const proto =
      tag === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : tag === "SELECT"
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillTextLike(el, value) {
    if (!value) return false;
    if (cleanText(el.value) === cleanText(value)) return false; // already set

    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    const setVal = (v) => {
      if (desc && desc.set) desc.set.call(el, v);
      else el.value = v;
    };

    // Workday inputs are React-controlled: if React doesn't observe a genuine
    // edit, its next render writes its own (empty) state back and the field
    // ends up "valid but blank". Emulate a real edit:
    //  1. focus,
    //  2. blank the field first so React's value tracker always sees a change,
    //  3. set the value and fire real InputEvents (what React's onChange reads),
    //  4. defer blur so validation runs AFTER React commits — not before.
    el.focus();
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    setVal("");
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" })
    );

    setVal(value);
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: value })
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));

    setTimeout(() => {
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      el.blur();
    }, 0);
    return true;
  }

  function fillNativeSelect(el, value) {
    if (!value) return false;
    const want = value.toLowerCase();
    let match = null;
    for (const opt of el.options) {
      const text = cleanText(opt.textContent).toLowerCase();
      if (text === want || opt.value.toLowerCase() === want) {
        match = opt;
        break;
      }
    }
    if (!match) {
      for (const opt of el.options) {
        if (cleanText(opt.textContent).toLowerCase().includes(want)) {
          match = opt;
          break;
        }
      }
    }
    if (!match || el.value === match.value) return false;
    setNativeValue(el, match.value);
    return true;
  }

  // Yes/No and other radio groups.
  function fillRadioGroup(radios, value) {
    if (!value) return false;
    const want = value.toLowerCase();
    for (const r of radios) {
      const lbl = labelText(r).toLowerCase();
      const optText = cleanText(
        (r.closest("label") ? r.closest("label").textContent : "") || lbl
      ).toLowerCase();
      if (r.value.toLowerCase() === want || optText === want || optText.includes(want)) {
        if (!r.checked) {
          r.focus();
          r.click();
        }
        return true;
      }
    }
    return false;
  }

  // Best-effort react-select / custom combobox.
  function fillCombobox(container, value) {
    if (!value) return false;
    try {
      const control = container.querySelector("[class*='control'], [role='combobox']") || container;
      control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      control.click();
      const want = value.toLowerCase();
      const options = document.querySelectorAll("[role='option'], [class*='option']");
      for (const opt of options) {
        if (cleanText(opt.textContent).toLowerCase().includes(want)) {
          opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          opt.click();
          return true;
        }
      }
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  // ---------- Workday support ----------

  // Poll `fn` until it returns a truthy value or the timeout elapses.
  function waitFor(fn, timeout = 1500, interval = 60) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let r = null;
        try {
          r = fn();
        } catch (_) {
          /* ignore */
        }
        if (r) return resolve(r);
        if (Date.now() - start >= timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  // The Workday form field wrapping a control, e.g. formField-legalName--firstName.
  function workdayField(el) {
    return el.closest ? el.closest("[data-automation-id^='formField-']") : null;
  }

  // Map a control to a profile key via its Workday formField automation id.
  function workdayKeyForControl(el) {
    const field = workdayField(el);
    if (!field) return null;
    const aid = field.getAttribute("data-automation-id") || "";
    return AAF.workdayFieldKey(aid.replace(/^formField-/, ""));
  }

  // A control that belongs to a Workday custom dropdown / multiselect widget —
  // these are driven by their <button>/search input, not by the raw field, so
  // the main text pass must skip them.
  function isWorkdayWidgetControl(el) {
    const field = workdayField(el);
    if (!field) return false;
    return !!(
      field.querySelector("button[aria-haspopup='listbox']") ||
      field.querySelector("[data-automation-id='multiSelectContainer']")
    );
  }

  // Never autofill on a sign-in / create-account screen.
  function isLoginPage() {
    if (document.querySelector("input[type='password']")) return true;
    return !!document.querySelector(
      "[data-automation-id='signInContent'], [data-automation-id='createAccountPage'], [data-automation-id='authViewTitle']"
    );
  }

  // Fill a Workday button-based dropdown (aria-haspopup="listbox"). Opens the
  // menu, waits for the detached option list, and clicks the best match.
  async function fillWorkdayDropdown(button, value) {
    if (!value) return false;
    const want = value.toLowerCase();
    const current = cleanText(button.textContent).toLowerCase();
    if (current && current !== "select one" && (current === want || current.includes(want))) {
      return false; // already set
    }
    button.focus();
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    button.click();

    const opt = await waitFor(() => {
      const list = document.querySelectorAll(
        "[role='option'], [data-automation-id='promptOption']"
      );
      let partial = null;
      for (const o of list) {
        if (!isVisible(o)) continue;
        const t = cleanText(
          o.getAttribute("data-automation-label") || o.textContent || ""
        ).toLowerCase();
        if (!t) continue;
        if (t === want) return o;
        if (!partial && t.includes(want)) partial = o;
      }
      return partial;
    }, 1500);

    if (!opt) {
      button.click(); // close the menu we opened
      return false;
    }
    opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    opt.click();
    return true;
  }

  // ---------- Control discovery ----------

  function getControls() {
    const nodes = Array.from(
      document.querySelectorAll("input, textarea, select")
    ).filter((el) => {
      const type = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image", "file", "password"].includes(type)) return false;
      if (el.disabled || el.readOnly) return false;
      return isVisible(el);
    });
    return nodes;
  }

  function readControlValue(el) {
    const type = (el.type || "").toLowerCase();
    if (type === "checkbox") return el.checked ? "Yes" : "No";
    if (type === "radio") {
      if (!el.checked) return "";
      const wrap = el.closest("label");
      return cleanText(wrap ? wrap.textContent : el.value) || el.value;
    }
    if (el.tagName === "SELECT") {
      const opt = el.options[el.selectedIndex];
      return opt ? cleanText(opt.textContent) : el.value;
    }
    return el.value || "";
  }

  // ---------- Fill orchestration ----------

  async function fillAll() {
    if (!STATE) await loadState();

    // Honor "never fill login": bail out on sign-in / create-account screens.
    if (isLoginPage()) {
      toast("Sign in first — login pages are never autofilled.");
      return 0;
    }

    const controls = getControls();
    let filled = 0;
    const seenRadioGroups = new Set();

    for (const el of controls) {
      // Workday dropdown / multiselect widgets are handled in a dedicated pass.
      if (isWorkdayWidgetControl(el)) continue;

      const raw = labelText(el);
      const norm = AAF.normalizeLabel(raw);
      if (!norm) continue;

      const type = (el.type || "").toLowerCase();

      // Determine desired value: Workday field id first, then label-based
      // profile match, then the learned store.
      let value = "";
      const profileKey = workdayKeyForControl(el) || AAF.matchProfileKey(norm);
      if (profileKey) {
        value = AAF.profileValue(STATE.profile, profileKey);
      } else if (STATE.learned[norm]) {
        value = STATE.learned[norm].value;
      }
      if (!value) continue;

      try {
        if (type === "radio") {
          if (seenRadioGroups.has(el.name)) continue;
          seenRadioGroups.add(el.name);
          const radios = Array.from(
            document.querySelectorAll(`input[type="radio"][name="${esc(el.name)}"]`)
          );
          if (fillRadioGroup(radios, value)) filled++;
        } else if (el.tagName === "SELECT") {
          if (fillNativeSelect(el, value)) filled++;
        } else {
          if (fillTextLike(el, value)) filled++;
        }
      } catch (e) {
        /* keep going */
      }
    }

    // Attempt custom comboboxes (react-select) for known dropdown-ish fields.
    const comboLabels = document.querySelectorAll("[role='combobox']");
    for (const combo of comboLabels) {
      const raw = labelText(combo);
      const norm = AAF.normalizeLabel(raw);
      if (!norm) continue;
      let value = "";
      const key = AAF.matchProfileKey(norm);
      if (key) value = AAF.profileValue(STATE.profile, key);
      else if (STATE.learned[norm]) value = STATE.learned[norm].value;
      if (!value) continue;
      const container = combo.closest("[class*='select'], [class*='field'], div") || combo.parentElement;
      if (container && fillCombobox(container, value)) filled++;
    }

    // Workday button-based dropdowns (State, Country, "How did you hear", etc.).
    const wdButtons = document.querySelectorAll("button[aria-haspopup='listbox']");
    for (const btn of wdButtons) {
      if (!isVisible(btn)) continue;
      const norm = AAF.normalizeLabel(labelText(btn));
      let value = "";
      const key = workdayKeyForControl(btn) || AAF.matchProfileKey(norm);
      if (key) value = AAF.profileValue(STATE.profile, key);
      else if (norm && STATE.learned[norm]) value = STATE.learned[norm].value;
      if (!value) continue;
      try {
        if (await fillWorkdayDropdown(btn, value)) filled++;
      } catch (e) {
        /* keep going */
      }
    }

    if (filled > 0) toast(`Autofilled ${filled} field${filled === 1 ? "" : "s"} — review before submitting.`);
    else toast("Nothing to autofill here yet.");
    return filled;
  }

  // ---------- Learning ----------

  function isLearnable(el) {
    if (!el || !el.tagName) return false;
    const type = (el.type || "").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image", "file", "password"].includes(type)) return false;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
    return false;
  }

  function onChangeCapture(e) {
    if (!STATE || !STATE.settings.learnFields) return;
    const el = e.target;
    if (!isLearnable(el)) return;
    // Workday dropdowns store opaque GUIDs in a hidden input — don't learn those.
    if (isWorkdayWidgetControl(el)) return;

    const raw = labelText(el);
    const norm = AAF.normalizeLabel(raw);
    if (!norm) return;
    if (AAF.matchProfileKey(norm)) return; // covered by profile already
    if (workdayKeyForControl(el)) return; // covered by a Workday profile field

    const value = readControlValue(el);
    if (value == null || cleanText(value) === "") return;

    const learned = {
      ...STATE.learned,
      [norm]: { value, sample: cleanText(raw).slice(0, 80), ts: Date.now() }
    };
    STATE.learned = learned;
    AAF.setLearned(learned);
  }

  // ---------- Toast ----------

  let toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = [
        "position:fixed",
        "z-index:2147483647",
        "bottom:20px",
        "right:20px",
        "max-width:320px",
        "padding:12px 14px",
        "background:#111827",
        "color:#fff",
        "font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
        "border-radius:8px",
        "box-shadow:0 6px 24px rgba(0,0,0,.28)",
        "opacity:0",
        "transition:opacity .2s ease"
      ].join(";");
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(() => (toastEl.style.opacity = "1"));
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => {
      if (toastEl) toastEl.style.opacity = "0";
    }, 3500);
  }

  // ---------- Auto-fill on load ----------

  function maybeAutofill() {
    if (autofilledForForm) return;
    if (!STATE || !STATE.settings.autofillOnLoad) return;
    const controls = getControls();
    if (controls.length >= 2) {
      autofilledForForm = true;
      fillAll();
    }
  }

  const observer = new MutationObserver(() => {
    // Reset the guard if navigation swapped the form (SPA route change).
    maybeAutofill();
  });

  // ---------- Messaging ----------

  AAF.api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "AAF_FILL") {
      (async () => {
        if (!STATE) await loadState();
        const count = await fillAll();
        sendResponse({ ok: true, count });
      })();
      return true; // async
    }
    if (msg.type === "AAF_STATUS") {
      sendResponse({ ok: true, fields: getControls().length });
      return false;
    }
  });

  // ---------- Init ----------

  (async () => {
    await loadState();
    document.addEventListener("change", onChangeCapture, true);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    maybeAutofill();
  })();
})();

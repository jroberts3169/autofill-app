/*
 * content.ts — runs on AshbyHQ, Greenhouse, and Workday application pages.
 * - Fills known profile fields + previously learned fields.
 * - Learns new field values as you type them (change events) and as you pick
 *   dropdown options, including multi-select answers.
 * - Never submits, and never fills sign-in / create-account screens.
 */
(() => {
  "use strict";

  // The popup injects this file on demand when the declarative content script
  // did not run. Bail out if an instance is already live in this frame,
  // otherwise every message would get two listeners and fills would double up.
  if (window.__AAF_CONTENT_LOADED__) return;
  window.__AAF_CONTENT_LOADED__ = true;

  /** Any control the fill engine can write to. */
  type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

  let STATE: AAFState | null = null;
  let autofilledForForm = false;

  async function loadState(): Promise<void> {
    STATE = await AAF.getAll();
  }

  AAF.api.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") loadState();
  });

  // ---------- DOM helpers ----------

  const esc = (s: string): string =>
    window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");

  function isVisible(el: Element | null): boolean {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function cleanText(t: string | null | undefined): string {
    return (t || "").replace(/\s+/g, " ").trim();
  }

  // Best-effort label resolution for a form control.
  function labelText(el: Element): string {
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
    let node: Element | null = el;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const lbl = node.querySelector(
        ":scope > label, :scope > legend, :scope label, :scope legend"
      );
      if (lbl && cleanText(lbl.textContent) && cleanText(lbl.textContent).length <= 120) {
        return cleanText(lbl.textContent);
      }
      if (node.matches && node.matches("form, [class*='application-form'], main, body")) break;
    }

    const input = el as HTMLInputElement;
    if (input.placeholder) return cleanText(input.placeholder);
    if (input.name) return cleanText(input.name);
    return "";
  }

  // ---------- React-aware value setting ----------

  function valueSetter(el: FormControl): ((v: string) => void) | null {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) {
      const set = desc.set;
      return (v: string) => set.call(el, v);
    }
    return null;
  }

  function setNativeValue(el: FormControl, value: string): void {
    const set = valueSetter(el);
    if (set) set(value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillTextLike(el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
    if (!value) return false;
    if (cleanText(el.value) === cleanText(value)) return false; // already set

    const nativeSet = valueSetter(el);
    const setVal = (v: string): void => {
      if (nativeSet) nativeSet(v);
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
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));

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

  function fillNativeSelect(el: HTMLSelectElement, value: string): boolean {
    if (!value) return false;
    const want = value.toLowerCase();
    let match: HTMLOptionElement | null = null;
    for (const opt of Array.from(el.options)) {
      const text = cleanText(opt.textContent).toLowerCase();
      if (text === want || opt.value.toLowerCase() === want) {
        match = opt;
        break;
      }
    }
    if (!match) {
      for (const opt of Array.from(el.options)) {
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

  // ---------- Radio groups ----------

  // The visible text of one radio option.
  function radioOptionText(r: HTMLInputElement): string {
    if (r.id) {
      const l = document.querySelector(`label[for="${esc(r.id)}"]`);
      if (l && cleanText(l.textContent)) return cleanText(l.textContent);
    }
    const wrap = r.closest("label");
    if (wrap && cleanText(wrap.textContent)) return cleanText(wrap.textContent);
    const al = r.getAttribute("aria-label");
    if (al) return cleanText(al);
    return cleanText(r.value);
  }

  // The question a radio group asks. Ashby renders the question as the
  // fieldset's own <label> and gives every option its own label[for], so
  // labelText() on a radio returns the option ("She/her") instead of the
  // question ("Pronouns").
  function radioGroupLabel(r: HTMLInputElement): string {
    const group = r.closest("fieldset, [role='radiogroup']");
    if (group) {
      const direct = group.getAttribute("aria-label");
      if (direct) return cleanText(direct);

      const optionIds = new Set(
        Array.from(group.querySelectorAll<HTMLInputElement>("input[type='radio']"))
          .map((x) => x.id)
          .filter(Boolean)
      );
      for (const node of Array.from(group.querySelectorAll("legend, label"))) {
        const forId = node.getAttribute("for");
        if (forId && optionIds.has(forId)) continue; // an option's own label
        const t = cleanText(node.textContent);
        if (t) return t;
      }
    }
    return labelText(r);
  }

  // All radios belonging to the same question.
  function radioGroupMembers(r: HTMLInputElement): HTMLInputElement[] {
    if (r.name) {
      return Array.from(
        document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${esc(r.name)}"]`)
      );
    }
    const group = r.closest("fieldset, [role='radiogroup']");
    return group
      ? Array.from(group.querySelectorAll<HTMLInputElement>("input[type='radio']"))
      : [r];
  }

  // Yes/No and other radio groups.
  function fillRadioGroup(radios: HTMLInputElement[], value: string): boolean {
    if (!value) return false;
    const want = cleanText(value).toLowerCase();
    const opts = radios.map((r) => ({
      r,
      text: radioOptionText(r).toLowerCase(),
      value: String(r.value || "").toLowerCase()
    }));

    let match = opts.find((o) => o.text === want || o.value === want);
    // Substring matching only for distinctive answers, so "No" can never
    // select "Not currently employed".
    if (!match && want.length >= 4) match = opts.find((o) => o.text.includes(want));
    if (!match || match.r.checked) return false;

    match.r.focus();
    match.r.click();
    return true;
  }

  // ---------- Button-based option groups ----------

  interface ButtonGroup {
    container: Element;
    buttons: HTMLButtonElement[];
  }

  // Ashby renders Yes/No questions as a pair of <button aria-pressed> toggles
  // instead of radios, so they are invisible to getControls() and need their
  // own pass.
  function buttonOptionGroups(): ButtonGroup[] {
    const groups = new Map<Element, HTMLButtonElement[]>();
    document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]").forEach((btn) => {
      if (!isVisible(btn) || btn.disabled) return;
      const container = btn.parentElement;
      if (!container) return;
      const existing = groups.get(container);
      if (existing) existing.push(btn);
      else groups.set(container, [btn]);
    });
    const out: ButtonGroup[] = [];
    groups.forEach((buttons, container) => {
      if (buttons.length >= 2) out.push({ container, buttons });
    });
    return out;
  }

  // The question such a group asks, taken from the surrounding field entry.
  function buttonGroupLabel(container: Element): string {
    let node: Element | null = container;
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const lab = node.querySelector(":scope > label, :scope > legend");
      if (lab && cleanText(lab.textContent)) return cleanText(lab.textContent);
    }
    return "";
  }

  function fillButtonGroup(buttons: HTMLButtonElement[], value: string): boolean {
    if (!value) return false;
    const want = cleanText(value).toLowerCase();
    const opts = buttons.map((b) => ({ b, text: cleanText(b.textContent).toLowerCase() }));

    let match = opts.find((o) => o.text === want);
    if (!match && want.length >= 4) match = opts.find((o) => o.text.includes(want));
    if (!match) return false;
    if (match.b.getAttribute("aria-pressed") === "true") return false; // already set

    // A <button> without an explicit type defaults to submit. Ashby's toggles
    // sit outside any <form>, but never click one that could submit a form.
    const btnType = (match.b.getAttribute("type") || "submit").toLowerCase();
    if (btnType === "submit" && match.b.closest("form")) return false;

    match.b.focus();
    match.b.click();
    return true;
  }

  // ---------- Custom comboboxes ----------

  // Best-effort react-select / custom combobox (Greenhouse, Ashby).
  //
  // react-select ignores synthetic key events, so the menu has to be opened by
  // a mousedown on the control. Options render asynchronously, and the menu is
  // often portaled out of the field, so matches are scoped by the option id
  // react-select derives from the input id ("react-select-<inputId>-option-N").
  //
  // Multi-selects (e.g. Greenhouse's race/ethnicity question) hold several
  // answers at once, so the stored value may list more than one. Each is
  // picked in turn, skipping any already shown as a chip.
  async function fillReactSelect(input: HTMLInputElement, value: string): Promise<boolean> {
    if (!value) return false;
    const wants = AAF.splitMulti(value);
    if (!wants.length) return false;

    const isReactSelect = !!input.closest("[class*='select__control']");
    const control =
      input.closest("[class*='select__control']") ||
      input.closest("[class*='select__container']") ||
      input.parentElement;
    if (!control) return false;

    const fire = (node: Element, type: string): boolean =>
      node.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, view: window })
      );

    const selector = input.id
      ? `[id^="react-select-${esc(input.id)}-option"]`
      : "[role='option']";

    // Tiered matching, loosest last. A location typeahead offers
    // "Austin, Texas, United States" for a stored "Austin, TX", so the first
    // comma-segment is allowed to match the start of an option.
    const matches = (text: string, want: string): boolean => {
      if (!text) return false;
      if (text === want) return true;
      if (want.length >= 4 && text.includes(want)) return true;
      const head = want.split(",")[0].trim();
      return head.length >= 3 && text.startsWith(head);
    };

    // Whatever the control currently shows: multi-select chips, the single
    // selected value, or — for a plain typeahead that is not react-select —
    // the text already sitting in the input.
    const selected = (): string[] => {
      const chips = Array.from(control.querySelectorAll("[class*='multi-value__label']"))
        .map((e) => cleanText(e.textContent).toLowerCase())
        .filter(Boolean);
      if (chips.length) return chips;
      const sv = control.querySelector("[class*='single-value']");
      if (sv) return [cleanText(sv.textContent).toLowerCase()];
      if (!isReactSelect && cleanText(input.value)) {
        return [cleanText(input.value).toLowerCase()];
      }
      return [];
    };

    const findOption = (want: string) => (): Element | null => {
      const list = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      if (!list.length) return null;
      const head = want.split(",")[0].trim();
      let partial: Element | null = null;
      let prefix: Element | null = null;
      for (const o of list) {
        const t = cleanText(o.textContent).toLowerCase();
        if (!t) continue;
        if (t === want) return o;
        // Substring matching is only safe for distinctive answers — it must
        // never turn a "No" into "Not applicable".
        if (!partial && want.length >= 4 && t.includes(want)) partial = o;
        if (!prefix && head.length >= 3 && t.startsWith(head)) prefix = o;
      }
      return partial || prefix;
    };

    let picked = 0;
    let alreadySet = 0;

    for (const raw of wants) {
      const want = raw.toLowerCase();
      if (selected().some((s) => matches(s, want))) {
        alreadySet++;
        continue;
      }

      input.focus();
      fire(control, "mousedown");
      fire(control, "mouseup");
      fire(control, "click");

      let opt = await waitFor(findOption(want), 900);

      // Typeahead comboboxes show nothing until something is typed.
      if (!opt && !input.readOnly) {
        const nativeSet = valueSetter(input);
        if (nativeSet) nativeSet(raw);
        else input.value = raw;
        input.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: raw })
        );
        // Suggestions are often fetched, so give them longer than the
        // already-rendered case.
        opt = await waitFor(findOption(want), 1200);
      }

      if (!opt) continue;

      fire(opt, "mousedown");
      fire(opt, "mouseup");
      fire(opt, "click");
      picked++;
      // Let React commit before reading chips or reopening the menu.
      await waitFor(() => (selected().some((s) => matches(s, want)) ? true : null), 500);
    }

    if (picked > 0) return true;
    // Every answer was already in place, so the menu was never opened.
    if (alreadySet === wants.length) return false;

    // Nothing matched. Always close the menu — leaving an autocomplete popup
    // hanging open is both confusing and leaves the widget mid-interaction.
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    input.blur();
    // react-select discards typed text on blur. A plain typeahead may keep it,
    // which is still better than an empty field — but only count it if it
    // actually survived.
    if (isReactSelect) return false;
    return !!cleanText(input.value);
  }

  // A react-select search input. These look like plain text inputs, so the
  // text pass must skip them — typing into one without picking an option
  // leaves the field blank once React re-renders.
  function isComboboxInput(el: Element): boolean {
    if (!el || !el.getAttribute) return false;
    if (el.getAttribute("role") === "combobox") return true;
    return !!(el.closest && el.closest("[class*='select__input-container']"));
  }

  // ---------- Workday support ----------

  // Poll `fn` until it returns a truthy value or the timeout elapses.
  function waitFor<T>(fn: () => T | null, timeout = 1500, interval = 60): Promise<T | null> {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = (): void => {
        let r: T | null = null;
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
  function workdayField(el: Element): Element | null {
    return el.closest ? el.closest("[data-automation-id^='formField-']") : null;
  }

  // Map a control to a profile key via its Workday formField automation id.
  function workdayKeyForControl(el: Element): AAFProfileKey | null {
    const field = workdayField(el);
    if (!field) return null;
    const aid = field.getAttribute("data-automation-id") || "";
    return AAF.workdayFieldKey(aid.replace(/^formField-/, ""));
  }

  // A control that belongs to a Workday custom dropdown / multiselect widget —
  // these are driven by their <button>/search input, not by the raw field, so
  // the main text pass must skip them.
  function isWorkdayWidgetControl(el: Element): boolean {
    const field = workdayField(el);
    if (!field) return false;
    return !!(
      field.querySelector("button[aria-haspopup='listbox']") ||
      field.querySelector("[data-automation-id='multiSelectContainer']")
    );
  }

  // Never autofill on a sign-in / create-account screen.
  function isLoginPage(): boolean {
    if (document.querySelector("input[type='password']")) return true;
    return !!document.querySelector(
      "[data-automation-id='signInContent'], [data-automation-id='createAccountPage'], [data-automation-id='authViewTitle']"
    );
  }

  // Fill a Workday button-based dropdown (aria-haspopup="listbox"). Opens the
  // menu, waits for the detached option list, and clicks the best match.
  async function fillWorkdayDropdown(button: HTMLButtonElement, value: string): Promise<boolean> {
    if (!value) return false;
    const want = value.toLowerCase();
    const current = cleanText(button.textContent).toLowerCase();
    if (current && current !== "select one" && (current === want || current.includes(want))) {
      return false; // already set
    }
    button.focus();
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    button.click();

    const opt = await waitFor<Element>(() => {
      const list = document.querySelectorAll("[role='option'], [data-automation-id='promptOption']");
      let partial: Element | null = null;
      for (const o of Array.from(list)) {
        if (!isVisible(o)) continue;
        const t = cleanText(o.getAttribute("data-automation-label") || o.textContent || "").toLowerCase();
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
    (opt as HTMLElement).click();
    return true;
  }

  // ---------- Greenhouse support ----------

  function isGreenhouse(): boolean {
    return /(^|\.)greenhouse\.io$/.test(location.hostname);
  }

  // Map a control to a profile key via its Greenhouse element id.
  function greenhouseKeyForControl(el: Element): AAFProfileKey | null {
    if (!isGreenhouse() || !el.id) return null;
    return AAF.greenhouseFieldKey(el.id);
  }

  // ---------- Control discovery ----------

  function getControls(): FormControl[] {
    return Array.from(
      document.querySelectorAll<FormControl>("input, textarea, select")
    ).filter((el) => {
      const type = ((el as HTMLInputElement).type || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image", "file", "password"].includes(type)) {
        return false;
      }
      if (el.disabled || (el as HTMLInputElement).readOnly) return false;
      // Greenhouse's react-select renders an aria-hidden input per dropdown
      // purely to drive native "required" validation. It has a real bounding
      // box, so it has to be excluded explicitly or the fill engine writes the
      // answer into a field nobody can see. Note this cannot key off opacity:
      // Ashby's real radios are opacity-0 inputs behind styled markup.
      if (el.getAttribute("aria-hidden") === "true") return false;
      if (el.tabIndex < 0) return false;
      return isVisible(el);
    });
  }

  function readControlValue(el: FormControl): string {
    const type = ((el as HTMLInputElement).type || "").toLowerCase();
    if (type === "checkbox") return (el as HTMLInputElement).checked ? "Yes" : "No";
    if (type === "radio") {
      const radio = el as HTMLInputElement;
      if (!radio.checked) return "";
      return radioOptionText(radio);
    }
    if (el.tagName === "SELECT") {
      const sel = el as HTMLSelectElement;
      const opt = sel.options[sel.selectedIndex];
      return opt ? cleanText(opt.textContent) : sel.value;
    }
    return el.value || "";
  }

  // ---------- Fill orchestration ----------

  // True while a fill is running, so the learning listeners ignore the
  // selections this extension makes itself.
  let filling = false;

  async function fillAll(): Promise<number> {
    if (filling) return 0;
    filling = true;
    try {
      return await runFill();
    } finally {
      // Learning listeners read state slightly after React commits, so keep
      // the guard up a moment longer than the fill itself.
      setTimeout(() => {
        filling = false;
      }, 600);
    }
  }

  async function runFill(): Promise<number> {
    if (!STATE) await loadState();
    const state = STATE as AAFState;

    // Honor "never fill login": bail out on sign-in / create-account screens.
    if (isLoginPage()) {
      toast("Sign in first — login pages are never autofilled.");
      return 0;
    }

    const controls = getControls();
    let filled = 0;
    const seenRadioGroups = new Set<unknown>();

    for (const el of controls) {
      // Workday dropdown / multiselect widgets are handled in a dedicated pass.
      if (isWorkdayWidgetControl(el)) continue;
      // react-select search inputs are handled by the combobox pass below.
      if (isComboboxInput(el)) continue;

      const type = ((el as HTMLInputElement).type || "").toLowerCase();
      const isRadio = type === "radio";
      // A radio must be matched against its question, not its own option text.
      const raw = isRadio ? radioGroupLabel(el as HTMLInputElement) : labelText(el);
      const norm = AAF.normalizeLabel(raw);
      if (!norm) continue;

      // Determine desired value: Workday / Greenhouse field id first, then
      // label-based profile match, then the learned store.
      let value = "";
      const profileKey =
        workdayKeyForControl(el) || greenhouseKeyForControl(el) || AAF.matchProfileKey(norm);
      if (profileKey) {
        value = AAF.profileValue(state.profile, profileKey);
      } else if (state.learned[norm]) {
        value = state.learned[norm].value;
      }
      if (!value) continue;

      try {
        if (isRadio) {
          const radio = el as HTMLInputElement;
          // Group by name when there is one, otherwise by enclosing fieldset.
          const groupKey =
            radio.name || radio.closest("fieldset, [role='radiogroup']") || radio;
          if (seenRadioGroups.has(groupKey)) continue;
          seenRadioGroups.add(groupKey);
          if (fillRadioGroup(radioGroupMembers(radio), value)) filled++;
        } else if (el.tagName === "SELECT") {
          if (fillNativeSelect(el as HTMLSelectElement, value)) filled++;
        } else {
          if (fillTextLike(el as HTMLInputElement, value)) filled++;
        }
      } catch (e) {
        /* keep going */
      }
    }

    // Custom comboboxes (react-select on Greenhouse and Ashby).
    const combos = document.querySelectorAll<HTMLInputElement>("[role='combobox']");
    for (const combo of Array.from(combos)) {
      if (!isVisible(combo) || combo.disabled) continue;
      const raw = labelText(combo);
      const norm = AAF.normalizeLabel(raw);
      if (!norm) continue;
      let value = "";
      const key = greenhouseKeyForControl(combo) || AAF.matchProfileKey(norm);
      if (key) value = AAF.profileValue(state.profile, key);
      else if (state.learned[norm]) value = state.learned[norm].value;
      if (!value) continue;
      try {
        if (await fillReactSelect(combo, value)) filled++;
      } catch (e) {
        /* keep going */
      }
    }

    // Button-based option groups (Ashby's Yes/No toggles).
    for (const group of buttonOptionGroups()) {
      const raw = buttonGroupLabel(group.container);
      const norm = AAF.normalizeLabel(raw);
      if (!norm) continue;
      let value = "";
      const key = AAF.matchProfileKey(norm);
      if (key) value = AAF.profileValue(state.profile, key);
      else if (state.learned[norm]) value = state.learned[norm].value;
      if (!value) continue;
      try {
        if (fillButtonGroup(group.buttons, value)) filled++;
      } catch (e) {
        /* keep going */
      }
    }

    // Workday button-based dropdowns (State, Country, "How did you hear", etc.).
    const wdButtons = document.querySelectorAll<HTMLButtonElement>(
      "button[aria-haspopup='listbox']"
    );
    for (const btn of Array.from(wdButtons)) {
      if (!isVisible(btn)) continue;
      const norm = AAF.normalizeLabel(labelText(btn));
      let value = "";
      const key = workdayKeyForControl(btn) || AAF.matchProfileKey(norm);
      if (key) value = AAF.profileValue(state.profile, key);
      else if (norm && state.learned[norm]) value = state.learned[norm].value;
      if (!value) continue;
      try {
        if (await fillWorkdayDropdown(btn, value)) filled++;
      } catch (e) {
        /* keep going */
      }
    }

    if (filled > 0) {
      toast(`Autofilled ${filled} field${filled === 1 ? "" : "s"} — review before submitting.`);
    } else {
      toast("Nothing to autofill here yet.");
    }
    return filled;
  }

  // ---------- Learning ----------

  function isLearnable(el: Element | null): el is FormControl {
    if (!el || !el.tagName) return false;
    const type = ((el as HTMLInputElement).type || "").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image", "file", "password"].includes(type)) {
      return false;
    }
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
  }

  function onChangeCapture(e: Event): void {
    if (!STATE || !STATE.settings.learnFields || filling) return;
    const el = e.target as Element | null;
    if (!isLearnable(el)) return;
    // Workday dropdowns store opaque GUIDs in a hidden input — don't learn those.
    if (isWorkdayWidgetControl(el)) return;
    // react-select fires change events for each keystroke in its search box,
    // so learning here would capture partial text. Selections are learned by
    // onSelectPickCapture instead.
    if (isComboboxInput(el)) return;

    const raw =
      ((el as HTMLInputElement).type || "").toLowerCase() === "radio"
        ? radioGroupLabel(el as HTMLInputElement)
        : labelText(el);
    const norm = AAF.normalizeLabel(raw);
    if (!norm) return;
    if (AAF.matchProfileKey(norm)) return; // covered by profile already
    if (workdayKeyForControl(el)) return; // covered by a Workday profile field
    if (greenhouseKeyForControl(el)) return; // covered by a Greenhouse profile field

    const value = readControlValue(el);
    if (value == null || cleanText(value) === "") return;

    remember(norm, raw, value);
  }

  // Learn react-select answers when the selection changes, since the
  // underlying input never holds the selected value. This listens on mousedown
  // because react-select commits the choice there and unmounts the option, so
  // a real user's subsequent click event never lands on it. Removing a chip or
  // clearing the field is handled too, so the stored answer stays in sync.
  function onSelectPickCapture(e: Event): void {
    if (!STATE || !STATE.settings.learnFields || filling) return;
    const target = e.target as Element | null;
    if (!target || !target.closest) return;

    const opt = target.closest("[role='option']");
    // Greenhouse swaps react-select's default indicators for its own icon
    // buttons, so match the standard class names *and* fall back to the
    // accessible name. Scoping to a select control happens below.
    const remover =
      target.closest("[class*='multi-value__remove'], [class*='clear-indicator']") ||
      (() => {
        const btn = target.closest("button[aria-label]");
        if (!btn) return null;
        return /\b(clear|remove)\b/i.test(btn.getAttribute("aria-label") || "") ? btn : null;
      })();
    if (!opt && !remover) return;

    let input: HTMLInputElement | null = null;
    if (opt) {
      const m = /^react-select-(.+)-option-\d+$/.exec(opt.id || "");
      if (!m) return;
      input = document.getElementById(m[1]) as HTMLInputElement | null;
    } else if (remover) {
      const control = remover.closest("[class*='select__control']");
      input = control ? control.querySelector<HTMLInputElement>("[role='combobox']") : null;
    }
    if (!input) return;
    const resolved = input;

    const raw = labelText(resolved);
    const norm = AAF.normalizeLabel(raw);
    if (!norm) return;
    if (AAF.matchProfileKey(norm)) return;
    if (greenhouseKeyForControl(resolved)) return;

    const clicked = opt ? cleanText(opt.textContent) : "";

    // React has not committed the change yet, so read the control afterwards.
    // A multi-select must be stored as the full set of chips, not just the one
    // that was clicked.
    setTimeout(() => {
      if (!STATE || !STATE.settings.learnFields) return;
      const control = resolved.closest("[class*='select__control']");
      const chips = control
        ? Array.from(control.querySelectorAll("[class*='multi-value__label']"))
            .map((n) => cleanText(n.textContent))
            .filter(Boolean)
        : [];

      let value = "";
      if (chips.length) {
        value = AAF.joinMulti(chips);
      } else {
        const sv = control && control.querySelector("[class*='single-value']");
        value = sv ? cleanText(sv.textContent) : remover ? "" : clicked;
      }

      if (value) remember(norm, raw, value);
      else forget(norm);
    }, 250);
  }

  // Learn Yes/No button toggles when the user picks one.
  function onButtonOptionCapture(e: Event): void {
    if (!STATE || !STATE.settings.learnFields || filling) return;
    const target = e.target as Element | null;
    const btn = target && target.closest ? target.closest("button[aria-pressed]") : null;
    if (!btn) return;
    const container = btn.parentElement;
    if (!container || container.querySelectorAll("button[aria-pressed]").length < 2) return;

    const raw = buttonGroupLabel(container);
    const norm = AAF.normalizeLabel(raw);
    if (!norm) return;
    if (AAF.matchProfileKey(norm)) return; // covered by profile already

    const value = cleanText(btn.textContent);
    if (value) remember(norm, raw, value);
  }

  function forget(norm: string): void {
    if (!STATE || !STATE.learned[norm]) return;
    const learned = { ...STATE.learned };
    delete learned[norm];
    STATE.learned = learned;
    AAF.setLearned(learned);
  }

  function remember(norm: string, raw: string, value: string): void {
    if (!STATE) return;
    const learned: AAFLearned = {
      ...STATE.learned,
      [norm]: { value, sample: cleanText(raw).slice(0, 80), ts: Date.now() }
    };
    STATE.learned = learned;
    AAF.setLearned(learned);
  }

  // ---------- Toast ----------

  let toastEl: HTMLDivElement | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function toast(msg: string): void {
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
    const el = toastEl;
    el.textContent = msg;
    requestAnimationFrame(() => (el.style.opacity = "1"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.opacity = "0";
    }, 3500);
  }

  // ---------- Auto-fill on load ----------

  function maybeAutofill(): void {
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

  AAF.api.runtime.onMessage.addListener((msg: AAFMessage, _sender, sendResponse) => {
    if (!msg || !msg.type) return undefined;
    if (msg.type === "AAF_FILL") {
      (async () => {
        if (!STATE) await loadState();
        const count = await fillAll();
        sendResponse({ ok: true, count } satisfies AAFFillResponse);
      })();
      return true; // async
    }
    if (msg.type === "AAF_STATUS") {
      sendResponse({ ok: true, fields: getControls().length } satisfies AAFStatusResponse);
      return false;
    }
    return undefined;
  });

  // ---------- Init ----------

  (async () => {
    await loadState();
    document.addEventListener("change", onChangeCapture, true);
    document.addEventListener("mousedown", onSelectPickCapture, true);
    document.addEventListener("click", onButtonOptionCapture, true);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    maybeAutofill();
  })();
})();

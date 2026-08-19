/*
 * common.js — shared storage, defaults, and label-matching logic.
 * Loaded in the content script, popup, and options page.
 * Exposes a single global `AAF`.
 */
const AAF = (() => {
  // Cross-browser API handle (Chrome uses `chrome`, Firefox exposes `browser`).
  const api = (typeof browser !== "undefined" && browser.storage) ? browser : chrome;

  const DEFAULTS = {
    profile: {
      firstName: "",
      lastName: "",
      fullName: "",
      email: "",
      phone: "",
      linkedin: "",
      github: "",
      portfolio: "",
      location: "",
      workAuthorized: "Yes",
      requireSponsorship: "No",
      hearAbout: ""
    },
    // Learned fields: normalizedLabel -> { value, sample, ts }
    learned: {},
    settings: {
      autofillOnLoad: false,
      learnFields: true
    }
  };

  async function getAll() {
    const stored = await api.storage.local.get(["profile", "learned", "settings"]);
    return {
      profile: { ...DEFAULTS.profile, ...(stored.profile || {}) },
      learned: { ...(stored.learned || {}) },
      settings: { ...DEFAULTS.settings, ...(stored.settings || {}) }
    };
  }

  const setProfile = (p) => api.storage.local.set({ profile: p });
  const setLearned = (l) => api.storage.local.set({ learned: l });
  const setSettings = (s) => api.storage.local.set({ settings: s });

  function normalizeLabel(s) {
    return (s || "")
      .replace(/\*/g, " ")
      .replace(/\(required\)/gi, " ")
      .replace(/\(optional\)/gi, " ")
      .replace(/required/gi, " ")
      .replace(/[:：]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // Ordered: more specific labels first so "first name" wins over generic "name".
  const MATCHERS = [
    { key: "firstName", test: (l) => /\b(first|given)\s*name\b/.test(l) },
    { key: "lastName", test: (l) => /\b(last|family|sur)\s*name\b/.test(l) },
    { key: "fullName", test: (l) => l === "name" || /\b(full|legal|your)\s*name\b/.test(l) },
    { key: "email", test: (l) => /\be-?mail\b/.test(l) },
    { key: "phone", test: (l) => /\b(phone|mobile|telephone|cell)\b/.test(l) },
    { key: "linkedin", test: (l) => /linkedin/.test(l) },
    { key: "github", test: (l) => /github/.test(l) },
    { key: "portfolio", test: (l) => /\b(portfolio|personal\s*(site|website)|website|web\s*site|your\s*url)\b/.test(l) },
    { key: "location", test: (l) => /\b(city|location|where.*(based|located|live))\b/.test(l) },
    { key: "requireSponsorship", test: (l) => /\bsponsor(ship)?\b/.test(l) },
    { key: "workAuthorized", test: (l) => /\b(authoriz|authoris|legally.*work|eligible.*work|right to work)\b/.test(l) },
    { key: "hearAbout", test: (l) => /\bhear\b.*\babout\b|how.*find.*(us|this|role)/.test(l) }
  ];

  // Returns a profile key for a normalized label, or null.
  function matchProfileKey(normLabel) {
    for (const m of MATCHERS) {
      if (m.test(normLabel)) return m.key;
    }
    return null;
  }

  // Resolve the string value to place in a field for a given profile key.
  function profileValue(profile, key) {
    if (key === "fullName" && !profile.fullName) {
      const composed = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
      return composed || "";
    }
    return profile[key] || "";
  }

  return {
    api,
    DEFAULTS,
    getAll,
    setProfile,
    setLearned,
    setSettings,
    normalizeLabel,
    MATCHERS,
    matchProfileKey,
    profileValue
  };
})();

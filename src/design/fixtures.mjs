// Mock data for the Figma state exporter (export-states.mjs).
//
// Every code in here is MADE UP. Never put real codes in these fixtures:
// the exported HTML/PNGs leave the machine (they go to a designer), and any
// real game code is a live redeemable secret (see CLAUDE.md, verified-code
// pool). DAPPERLLAMA and friends exist only in this file.

export const CODE = "DAPPERLLAMA"; // the "correct" code in every fixture
export const CODE_MISREAD = "DAPPERLIAMA"; // tier-1's plausible misread (L→I)

export const ACCOUNTS_CONNECTED = [{
  label: "patron@example.com",
  cookies: { fixture: "1" },
  expired: false,
  players: [{ pid: 1, name: "Carl" }, { pid: 2, name: "Maple" }],
  selectedPids: [1, 2],
}];

export const ACCOUNTS_TWO = [
  ...ACCOUNTS_CONNECTED,
  {
    label: "family@example.com",
    cookies: { fixture: "2" },
    expired: false,
    players: [{ pid: 3, name: "Junior" }],
    selectedPids: [3],
  },
];

export const ACCOUNTS_EXPIRED = [{
  ...ACCOUNTS_CONNECTED[0],
  expired: true,
}];

// /api/submit responses. Shapes mirror server.ts handleSubmit: results[] per
// account with {label, outcome, points?, messages?: [{outcome, text}], error?}.
const success = (label, player, opts = {}) => ({
  outcome: "success",
  text: `${player} redeemed code "${CODE}" for 100 Summer Game 2026 points. `
    + `You found a Lawn Code on Fifth Ave! ${opts.hidden || ""}`.trim(),
});

export const SUBMIT_ALLOK_SINGLE = {
  code: CODE,
  results: [{
    label: "patron@example.com",
    outcome: "success",
    points: 100,
    messages: [success("patron@example.com", "Carl")],
  }],
};

export const SUBMIT_ALLOK_MULTI = {
  code: CODE,
  results: [
    {
      label: "patron@example.com",
      outcome: "success",
      points: 100,
      messages: [
        success("patron@example.com", "Carl", { hidden: "Have a sunny summer!" }),
        success("patron@example.com", "Maple"),
      ],
    },
    {
      label: "family@example.com",
      outcome: "already_redeemed",
      messages: [{ outcome: "already_redeemed", text: `Code "${CODE}" has already been redeemed by Junior.` }],
    },
  ],
};

export const SUBMIT_MIXED = {
  code: CODE_MISREAD,
  results: [
    {
      label: "patron@example.com",
      outcome: "success",
      points: 100,
      messages: [success("patron@example.com", "Carl")],
    },
    {
      label: "family@example.com",
      outcome: "not_recognized",
      messages: [{ outcome: "not_recognized", text: `Code "${CODE_MISREAD}" is not recognized.` }],
    },
  ],
};

export const SESSION = { sessionId: "design-fixture", storeImages: false, extractMode: "full" };

// /api/dash-stats fixture — plausible numbers, every widget populated.
const lat = (n, med, p90) => ({ n, med, p90 });
const buckets = (t1, poolT1, caught, poolT2, both, gateFail = 2, gatePassed = 1) => ({
  t1Correct: t1, poolT1, t1WrongT2Caught: caught, poolT2, bothWrong: both,
  t1WrongGateFail: gateFail, t1WrongGatePassed: gatePassed,
});
const dayRow = (key, sealed, b, sessions) => ({
  key, sealed, buckets: b, completed: sessions - 3, abandoned: 2, manualSessions: 1, sessions,
  lat: {
    extractTotal: lat(sessions, 540, 1350),
    gcv: lat(sessions, 390, 940),
    claude: lat(4, 1700, 2400),
    client: lat(sessions, 6200, 14800),
  },
});

export const DASH_STATS = {
  generatedAt: "2026-07-18T14:00:00Z",
  totals: {
    sessions: 212, completed: 181, abandoned: 19, manualSessions: 12,
    t1Correct: { n: 151, d: 181 },
    t2CorrectWhenRun: { n: 24, d: 30 },
    gatePassRate: { n: 158, d: 181 },
    lat: { extractTotal: lat(181, 520, 1400) },
  },
  visits: {
    total: 87,
    byDay: [
      { day: "2026-07-18", n: 9 },
      { day: "2026-07-17", n: 14 },
      { day: "2026-07-16", n: 11 },
    ],
  },
  byDay: [
    dayRow("2026-07-18", false, buckets(21, 1, 3, 0, 1), 28),
    dayRow("2026-07-17", false, buckets(25, 0, 4, 1, 2), 34),
    dayRow("2026-07-16", true, buckets(18, 1, 2, 0, 1), 24),
    dayRow("2026-07-15", true, buckets(23, 0, 3, 0, 2), 30),
  ],
  byVersion: [
    dayRow("1.3.0", false, buckets(46, 2, 7, 1, 3), 62),
    dayRow("1.2.5", false, buckets(52, 0, 8, 0, 5), 68),
    dayRow("1.2.4", false, buckets(29, 0, 5, 0, 4), 41),
  ],
};

// Injected via Page.addScriptToEvaluateOnNewDocument so it runs before the
// page's own script: dash.html fetches /api/dash-stats during load, so the
// stub must already be in place. Per-state /api/submit payloads are set later
// via window.__stubs (fetch reads it at call time).
export function bootstrapScript() {
  const fixed = {
    "/api/session": SESSION,
    "/api/visit": {},
    "/api/verdict": {},
    "/api/dash-stats": DASH_STATS,
  };
  return `(() => {
  window.__stubs = ${JSON.stringify(fixed)};
  const real = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const path = String(url);
    for (const key of Object.keys(window.__stubs)) {
      if (path.includes(key)) {
        return Promise.resolve(new Response(JSON.stringify(window.__stubs[key]),
          { status: 200, headers: { "content-type": "application/json" } }));
      }
    }
    return real(url, opts);
  };
  // Synthetic handwriting-ish crop so no real sign photo ships to the designer.
  window.__makeCrop = (text) => {
    const c = document.createElement("canvas");
    c.width = 1200; c.height = 360;
    const g = c.getContext("2d");
    g.fillStyle = "#f2eee3"; g.fillRect(0, 0, 1200, 360);
    g.strokeStyle = "#d8d2c0"; g.lineWidth = 3;
    g.strokeRect(24, 24, 1152, 312);
    g.fillStyle = "#20328c";
    g.font = "700 130px 'Segoe Print','Comic Sans MS',cursive";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.translate(600, 185); g.rotate(-0.015);
    g.fillText(text, 0, 0);
    return c.toDataURL("image/jpeg", 0.85);
  };
})();`;
}

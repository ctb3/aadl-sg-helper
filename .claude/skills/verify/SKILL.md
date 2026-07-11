---
name: verify
description: Build/launch/drive recipe for verifying app (src/app) changes end-to-end from this WSL environment
---

# Verifying the app from WSL

## Launch

- `npm run app` (background) — serves on :8080. NOTE: `npx tsx` now runs
  **WSL** node (env drifted from the old Windows-node setup), so the server
  listens WSL-side; Windows reaches it via localhost forwarding.
- Windows→WSL localhost works (curl.exe, Chrome → :8080 fine).
  WSL→Windows localhost does NOT (WSL node can't reach a Windows Chrome's
  debug port).

## Drive the client (real browser, no Playwright needed)

1. Headless Chrome with CDP, background:
   `"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new
   --disable-gpu --no-first-run --remote-debugging-port=9223
   --user-data-dir="C:\\src\\aadl-sg-helper\\out\\chrome-cdp" about:blank`
2. Drive it over the CDP websocket with **Windows node** (`node.exe`, has
   global WebSocket; WSL node can't reach :9223): see `out/uitest.mjs` /
   `out/uitest2.mjs` for working drivers (Runtime.evaluate to click real
   buttons, Page.captureScreenshot for evidence).
3. Real account connect works headless with the .env AADL test creds
   (players 57569/57743). Screenshot AFTER a ~500ms settle — the `.view`
   fade animation washes out mid-transition captures.
4. `/api/submit` and `/api/dash-stats` need live AWS creds (S3 writes) —
   expired SSO ⇒ 500s that are env, not the change. `aws sso login` first,
   or stub `window.fetch` for `/api/submit` in-page to drive the client
   rendering alone.

## Gotchas

- Kill order: TaskStop on the WSL wrapper ORPHANS the Windows chrome.exe —
  find pid via `netstat.exe -ano | grep :9223`, then
  `powershell.exe -Command "Stop-Process -Id <pid> -Force"`.
- curl.exe `-o` needs a Windows path (`C:\...`), not `/mnt/c/...`.
- `--window-size=420,...` screenshots clip ~60px on the right (window vs
  viewport); use `Emulation.setDeviceMetricsOverride` via CDP instead.
- First visit shows the how-to overlay (`howtoSeen` in localStorage) — any
  `home()` after `localStorage.clear()` lands on v-howto, not v-home.
- `npx tsx infra/apitest.ts http://localhost:8080` = server API smoke
  (no trailing slash; `--full` = paid path).

# Debug Session: http-500-runtime [OPEN]

## Symptom

- WebUI `Dashboard` and `Chat` load, but `/api/status`, `/api/roles`, `/api/metrics`, `/api/sessions` return HTTP 500.
- `Chat` role dropdown is empty.
- Sending a message shows `...` and browser console reports `[ws] send dropped, not open`.

## Expected

- `/api/status` and `/api/roles` should return 200.
- Chat role dropdown should load role options.
- WebSocket should open and chat should receive streamed reply.

## Hypotheses

1. `serve-http` process is not stably alive, so Vite proxy gets upstream failure.
2. `serve-http` is alive, but shared request-path initialization throws before route handlers complete.
3. Vite dev proxy or frontend dev env is returning a proxy-layer 500 instead of the backend body.
4. HTTP 500 and WS failure share the same backend startup/runtime fault.

## Plan

1. Start backend and frontend in runtime mode and capture logs.
2. Hit `/status` and `/roles` directly, bypassing browser.
3. Add minimal instrumentation only if logs are insufficient.
4. Confirm or reject hypotheses with runtime evidence before any fix.

## Evidence Log

- `node bin/perseng.js serve-http` restarted successfully and kept serving on `http://127.0.0.1:7717`.
- Direct backend checks returned 200:
  - `GET http://127.0.0.1:7717/status`
  - `GET http://127.0.0.1:7717/roles`
- Vite dev server restarted successfully on `http://localhost:5173`.
- Proxy checks returned 200:
  - `GET http://localhost:5173/api/status`
  - `GET http://localhost:5173/api/roles`
- Browser hard-refresh verification passed:
  - Dashboard no longer shows HTTP 500
  - Chat no longer shows HTTP 500
  - role dropdown contains 6 roles
  - test message succeeded and received reply containing `测试成功`
  - browser console errors: none

## Hypothesis Status

- H1 `serve-http` process not stably alive: partially supported for the previous failure window, but not reproducible after restart.
- H2 shared route initialization throws consistently: rejected by direct `/status` and `/roles` returning 200.
- H3 Vite proxy/frontend dev env consistently returns proxy-layer 500: rejected by proxied `/api/status` and `/api/roles` returning 200.
- H4 HTTP 500 and WS failure share a transient backend/runtime fault: still plausible as an intermittent runtime-state issue, but currently not reproducible.

## Interim Conclusion

- No stable code-path bug is currently reproducible.
- Strongest evidence points to a transient runtime state problem during the previous failure window:
  - stale or broken backend/dev-server process state, and/or
  - stale browser tab state before hard refresh.

# Spec 1 — Local dashboard server security

**Status:** ✅ landed on `main` (reconciled 2026-06-22) · **Priority:** P0 (release gate) · **Size:** S–M · **Owner:** TBD

> **Reconciliation (2026-06-22):** shipped. `COACH_HOST` now defaults to `127.0.0.1` (LAN bind is explicit opt-in via `COACH_LAN=1`) and every route is token-gated behind a host allow-list. The "Problem" / "current behaviour" below describes the PRE-fix state, kept for context.

## Problem
`src/server.ts` binds `0.0.0.0` (all LAN interfaces) with **no authentication** and exposes endpoints that
**write to AI Endurance** (`/confirm-proposal`, `/refresh`) and **spend LLM budget** (`/ask`, `/act`). There is
no `Host`/origin validation (so a malicious web page can DNS-rebind to `http://<mac-ip>:3000` and drive these
endpoints), no request body-size limit (`readBody` buffers unbounded input; an aborted request never resolves),
and no `server.on('error')`. The file's own header claims "creds never leave the Mac" — true for creds, but the
_effects_ (plan mutation, spend) are reachable by anything on the network.

## Goals
- No mutating or LLM endpoint is reachable without the operator's intent.
- Safe to run on the LAN for phone use, without exposing writes/spend off-device.
- Defends against DNS-rebinding and trivially-large/aborted requests.

## Non-goals
- Full multi-user auth / TLS. This is a single-operator local tool.

## Current behaviour (file:line)
- `server.ts:~30` `HOST = process.env.COACH_HOST ?? "0.0.0.0"`, `:~218` `server.listen(PORT, HOST)`, no error handler.
- `readBody` (`server.ts:~100`) — unbounded; resolves only on `end` (no `aborted`/`error`).
- Routes: `/ask`, `/insight-feedback`, `/act`, `/confirm-proposal`, `/decline-proposal`, `/refresh`, `/`.

## Proposed design
1. **Default to `localhost`.** `COACH_HOST` default → `127.0.0.1`. LAN exposure becomes explicit opt-in.
2. **Pairing token.** On first run, generate a random token in `~/.endurance-coach/dashboard.token`. The
   dashboard HTML embeds it (served only to a request that already has it, or via a one-time `/pair?token=`
   that sets a `Secure`,`SameSite=Strict`,`HttpOnly` cookie). All **mutating + LLM routes** require the cookie
   or an `Authorization: Bearer <token>` header; `GET /` (read-only render) may stay open on `localhost`.
3. **`Host` allowlist.** Reject requests whose `Host` isn't `localhost[:port]` / the configured LAN IP — kills
   DNS-rebinding.
4. **Body cap + robustness.** Reject bodies > 64 KB; handle `req.on('aborted'|'error')`; add `server.on('error')`.
5. **Method/route hygiene.** 405 for wrong method; tiny per-route rate limit (e.g. token-bucket) on `/ask`,`/act`.

## API / contract changes
- New env: `COACH_HOST` default change; `COACH_LAN=1` to bind `0.0.0.0`; `COACH_TOKEN` override.
- New route `GET /pair` (sets cookie). Mutating routes return `401` without a valid token.

## Acceptance criteria
- With defaults, the server binds `127.0.0.1`; `curl` from another host cannot reach it.
- With `COACH_LAN=1`, a phone on the LAN works **only after** visiting the pairing link; an unauthenticated
  `POST /confirm-proposal` returns `401` and performs no write.
- A request with a foreign `Host` header is rejected `403`.
- A 1 MB POST is rejected `413`; an aborted upload doesn't leak a pending promise.

## Test plan
- Unit/integration: spin the server on an ephemeral port; assert 401 on mutating routes without token, 200 with;
  403 on bad `Host`; 413 on oversized body. Assert `GET /` renders read-only without token on localhost.

## Risks / rollout
- Don't break the existing launchd/pm2 setup: document the one-time pairing step in README + `serve:install`
  output. Provide `COACH_LAN=1` for the current phone workflow.

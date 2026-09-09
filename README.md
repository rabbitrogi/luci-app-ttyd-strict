# luci-app-ttyd-strict

Strict single-session, on-demand ttyd terminal for LuCI — a hardening
fork of the stock `luci-app-ttyd` (design rationale:
[`../upstream-issue-luci-app-ttyd.md`](../upstream-issue-luci-app-ttyd.md),
proposal 1).

## Model

- ttyd exists **only while the LuCI terminal page is open**. The page
  starts it via rpcd on load; ttyd runs with `-o` (`--once`): exactly
  **one** websocket client is accepted, everyone else is refused, and
  the process exits by itself when that client disconnects (page close
  or refresh tears the session down).
- Before starting, the port is probed (listener inode → owning pid via
  `/proc/*/fd`, live clients via `netstat`):
  - port free → start;
  - ttyd running with **no client** (stale refresh) → reaped and
    restarted automatically, logged;
  - ttyd running **with a client** → never killed silently. The LuCI
    page shows a modal with pid / uptime / client endpoints (also
    written to the system log) and the user decides whether to take
    the session over (`session_takeover`);
  - port held by a **non-ttyd** process → reported, never touched.
- Orphan pidfiles (ttyd `--once` exited) are reaped on the next probe.
- All decisions go to `logger`, tag `ttyd-strict` (`logread | grep
  ttyd-strict`).

## Layout

| path | role |
| --- | --- |
| `root/usr/libexec/rpcd/ttyd-strict` | rpcd plugin: probe / start / takeover / stop |
| `htdocs/.../view/ttyd-strict/term.js` | LuCI view: auto-start, busy modal, status poll |
| `root/usr/share/rpcd/acl.d/ttyd-strict.json` | ACL grants |
| `root/etc/config/ttyd-strict` | uci: interface / port / credential / command |
| `root/etc/uci-defaults/40_ttyd-strict` | first boot: default config, disable stock ttyd service |
| `tests/sandbox-test.sh` | host-side branch tests for the plugin (no device needed) |

## Config

```
uci set ttyd-strict.strict.command='/bin/login -f root'   # passwordless
uci set ttyd-strict.strict.interface='lan'                # bind device
uci set ttyd-strict.strict.port='7681'
uci commit ttyd-strict
```

Passwordless login is defensible here *only* because the session is
gated by LuCI auth plus the single-client guarantee — the whole point
of this fork.

## Notes / limitations

- The stock persistent ttyd service is disabled on install (its uci
  config is left intact for rollback). The stock luci-app-ttyd page,
  if still installed, will simply find the port occupied by our
  on-demand instance.
- **Bind the interface you actually browse LuCI through.** `interface
  'lan'` resolves via netifd to e.g. `br-lan`/`eth0` — if you open
  LuCI via a different address (WAN-side mgmt IP, another NIC), the
  iframe points at that address while ttyd listens elsewhere and you
  get a dead terminal. Set `uci ttyd-strict.strict.interface` to the
  interface/device of your access path, a raw IP, or `0.0.0.0`.
- ttyd's `--once` does not reject the second websocket at the TCP
  layer: an intruder completing the handshake gets a black screen (no
  pty, no shell) and is dropped seconds later. Security-wise the slot
  is exclusive in practice, but `session_status.client_count` may
  briefly read 2 during that window (verified on-device).
- If a Wi-Fi hiccup drops the websocket, `--once` ends the session;
  the page's status poll auto-starts a fresh one (≥15 s apart). A
  browser tab frozen in the background (headless, OS suspending tabs)
  drops the websocket the same way — foreground use is unaffected.
- Run `bash tests/sandbox-test.sh` after touching the plugin — it
  covers all probe/start/takeover/stop branches against a simulated
  /proc + netstat world. On-device E2E results (OpenWrt 25.12.5):
  auto-start, refresh-restart, busy dialog, takeover and slot
  exclusion all verified; see the repo commit history notes.

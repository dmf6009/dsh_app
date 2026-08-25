# Runtime Protocol v1 (Phase 0)

JSONL-over-stdio framing between the DSH Desktop main process (client) and a
DSH runtime process (`dsh --profile desktop --stdio`, or the Phase 0 reference
stub). One JSON object per line, UTF-8, `\n` terminated.

Source of truth for the type layer: `src/shared/protocol/types.ts`.
Framing/tolerance rules: `src/shared/protocol/codec.ts`.

## Envelope

Every frame carries exactly:

| field | type     | notes                          |
| ----- | -------- | ------------------------------ |
| `v`   | `1`      | protocol version               |
| `type`| `string` | one of the names below         |

Additional per-type fields are documented in `types.ts`. Unknown extra fields
must be preserved, never rejected.

## Commands — Desktop → DSH

| type     | fields                                             | meaning |
| -------- | -------------------------------------------------- | ------- |
| `run`    | `run_id`, `session_id`, `workspace`, `message`     | start one agent run |
| `cancel` | `run_id?`                                          | cancel the active run |

## Events — DSH → Desktop (§21 full set)

Connection/session: `ready`, `session_created`
Run lifecycle: `run_started`, `message_delta`, `message_completed`,
`plan_updated`, `tool_started`, `tool_output`, `tool_completed`,
`file_read`, `file_changed`, `approval_required`, `approval_resolved`,
`error`, `run_completed`, `run_cancelled`.

`done` is accepted as a documented alias of `run_completed`; both are terminal
(`TERMINAL_EVENT_TYPES = ['run_completed', 'done', 'run_cancelled']`).
After a terminal frame the run is over; no further frames may belong to it.

## Framing rules

1. **Line length cap.** Default `8 MiB` (`DEFAULT_MAX_LINE_BYTES`). A line that
   exceeds the cap is reported as `{ reason: 'line_too_long' }` and dropped
   until the next newline; the decoder stays memory-bounded meanwhile.
2. **Malformed input never crashes the decoder.** Parse/envelope failures come
   back as `invalid` reports with reasons
   `json_parse_error | not_an_object | bad_envelope | line_too_long`.
   Decoding continues with the next line.
3. **Blank lines** (empty or whitespace-only) are separators and are skipped.
4. **CRLF tolerated**; trailing `\r` is trimmed.
5. **flush()** treats a trailing unterminated line as one final frame attempt
   (a writer that died mid-frame surfaces as `json_parse_error`, not a hang).

## Minimal event set implemented in Phase 0

The renderer consumes: `ready`, `run_started`, `message_delta`,
`message_completed`, `tool_started`, `tool_output`, `tool_completed`, `done`,
`error`, `run_cancelled` — plus graceful display of `plan_updated`,
`file_read`, `file_changed`. All §21 names exist in the type union so later
phases only add behavior, not plumbing.

## Reference stub

`scripts/stub-runtime.mjs` (zero-dependency Node ESM) replays a canned
"fix flaky login 500" scenario with the same framing rules:

```
ready → run_started → message_delta ×7 → message_completed
      → tool_started(shell) → tool_output ×2 → tool_completed(ok)
      → done
```

On `cancel` it stops streaming immediately, emits `run_cancelled`
(`reason: 'client_requested'`) and exits 0. Env knobs:
`STUB_DELTA_DELAY_MS` (default 90), `STUB_MAX_LINE_BYTES` (default 1 MiB).

## Verification

- `npm test` — codec unit tests, process manager tests, stub protocol
  consistency self-test, RuntimeClient integration tests.
- `npm run smoke:protocol` — human-visible frame stream vs. the stub.
- `npm run smoke:dsh` — optional probe of a real `dsh --profile desktop`
  (SKIPs cleanly until the desktop profile exists).
- `npm run smoke:app` — boots Electron itself under xvfb with `DSH_SMOKE=1`
  and asserts the closed loop through the real IPC/main-process stack.

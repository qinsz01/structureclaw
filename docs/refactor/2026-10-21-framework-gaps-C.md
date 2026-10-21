# Attachment framework verification — track C (2026-10-21)

Branch: `fix/framework-gaps-C`. Scope: O1 DXF evidence, O2 clarification attachments,
O3 JSON/TSV uploads. No benchmark files, freeze manifests, ablation profile version,
or other tracks' evidence checks, prompts, routing, templates or adapters were changed.
No push was performed.

## Root causes and changes

| Item | Root cause | Change |
|---|---|---|
| O1 | DIMENSION extraction retained only its label and one point; common drawing annotations counted as unsupported geometry. | Extract actual measurements, text overrides, definition points and insertion units. Count ignored annotation entities explicitly. Preserve unsupported curved-polyline, unreadable and truncated-content failures. Include source-frame coordinates, line lengths and dimensions in the existing file-evidence source record. |
| O2 | The normal composer could upload files, but `/stream/resume` accepted only text and bypassed the attachment pipeline. | Carry attachment references in resume requests, reuse parsing and vision summarization, merge file evidence and allowed attachment paths into the checkpoint, and persist attachment metadata with the reply. The existing upload control is reused. |
| O3 | Upload and browser allowlists omitted JSON/TSV; JSON fell through to plain-text reading. | Admit both formats. Parse JSON strictly as data, recognize V2 models through the canonical validator, and offer explicit `analyze_file(importModel=true)` import through the existing model boundary and revision history. Ordinary JSON records become tables; TSV uses the CSV parser with a tab delimiter. |

Upload limits remain 50 MB; parsing rejects files over 10 MB before reading content.
JSON code is never evaluated. Invalid model candidates remain data with a validation
error, and cannot be imported as models. Parsing and importing do not waive the
existing engineering evidence checks.

## Commits

- `e556958` — DXF measurements and annotation classification.
- `0076181` — clarification attachment parsing, checkpointing and persistence.
- `dbb9770` — JSON/TSV uploads, JSON model import, DXF evidence candidates and tests.
- `099a1e8` — update only the `analyze_file` schema hash for the new import option.

## Verification

Dependencies installed with both requested `npm ci` commands and Prisma generation.
The old worktree-local `backend/dist` was moved aside before the clean build.
An ignored `backend/.venv` junction points to the specified shared Python environment
so tests that create their own settings directories can discover the same interpreter.
After `npm run build --prefix frontend`, the existing CLI `runFrontendBuild` helper
produced the freshness stamp required by E2E without rebuilding a backend that was
already running tests. No CLI start command was used.

| Check | Result |
|---|---|
| Backend Prisma generation, clean build, lint, dependency rules | Passed |
| Full Jest (`backend/` working directory) | 200 suites / 2,822 tests / 57 snapshots passed |
| Python suite | 1,271 passed |
| `validate-agent-orchestration`, `validate-chat-stream-contract`, `validate-analyze-contract` | Passed |
| Frontend type-check, lint, production build | Passed |
| Frontend unit suite | 46 files passed, 2 skipped; 355 tests passed, 6 TODOs |
| Frontend integration suite | 12 files / 93 tests passed |
| Default E2E on port 31655 | 52 passed, 12 live-provider tests skipped (31.3 min) |

The first full Jest run had 198 passing suites and two failing suites (four tests):
three worker failures caused by Python discovery in temporary settings directories,
and the expected schema-hash change. The junction and single-hash snapshot update
address those causes. A subsequent root-directory Jest invocation passed the
snapshot but failed four cwd-dependent fixture suites; the final full invocation
uses `backend/` as its working directory. Final results are recorded above.

Existing DXF fixtures were read from the preserved supplement copy, without changing
`tests/llm-benchmark`: `beam-simple-6m.dxf` returned 2 lines; the simple and complex
arch-frame fixtures returned 26 and 61 lines. Both arch-frame files counted one arc
as an annotation. All three were complete with metre insertion units. New ezdxf
test drawings cover dimensions, override text, symbols, circles, arcs and hatches;
curved-polyline and truncation cases remain explicitly incomplete.

## Live checks (one trial each)

Backend: port 31635, runtime data at
`G:/StructureClaw-All/verification/framework-gaps-20261021/C/data`.
Only `llm.*` was copied from the user's settings; Python was set explicitly to
`G:/StructureClaw-All/sclaw_data/.venv/Scripts/python.exe`. Model: `glm-5.3`.

| Trial | Outcome |
|---|---|
| Dimensioned DXF upload and analysis | Passed in 741 s. Read 6000 mm dimension, 1 structural line, 1 text annotation, and ignored ARC/CIRCLE/HATCH counts of 1 each. Current OpenSees result: reactions +5/+5 kN, midspan moment 15 kN·m and deflection −1.092 mm. |
| Clarification reply carrying section CSV | Attachment transport/parsing passed (60 s for reply); analysis incomplete. The agent quoted A=0.012 m², Iy=0.0002 m⁴, Iz=0.0004 m⁴ and J=0.00001 m⁴ correctly, retained the CSV evidence, then asked to confirm those same values. |
| StructureModel v2 JSON upload and analysis | Recognition/import passed (revision 1, 2 original nodes); analysis unverified after 536 s / 15 tool calls. The verification fixture used noncanonical material units, producing a model/evidence mismatch; attempts to edit then stopped on section confirmation. |

The DXF trial required 25 tool calls, including failed build/review attempts before
successful mapping, validation and analysis. This verifies reachability and the
final numerical result, not a smooth or efficient agent workflow. The attachment
evidence-binding and clarification-guard work belongs to track A.

Raw test logs, the live harness, generated DXF/CSV/JSON inputs, transcripts and
saved input reviews are in
`G:/StructureClaw-All/verification/framework-gaps-20261021/C/`.
The live harness uses precreated isolated conversation IDs; the missing database
records were supplied during the first trial before final persistence, without
restarting or replaying that trial.

## Open items

- The CSV reply still stops for `sectionRecords` / `sectionConfirmation`; no analysis run exists. Attachment numbers reach the agent, but the existing section evidence path requires another confirmation. Track A owns that evidence binding; no extra user reply or trial was fabricated.
- The JSON live fixture was schema-valid but used E=206000000 and fy=355000 with a kN/m² instruction, whereas the V2 contract stores both in MPa. This was a verification-input mistake, not an importer numerical failure. The original input and transcript are preserved. A separate `cantilever-v2-canonical.json` uses E=206000 and fy=355 MPa for a future integrated check; it has not been run. The requested single live trial was not replayed.
- All started live and E2E servers have exited; ports 31635 and 31655 are free. Final Jest also completed, with no worktree backend server process remaining.
- Repeat integrated capability acceptance after the other tracks are merged; these
  checks are not claims that 300 benchmark tasks have passed.

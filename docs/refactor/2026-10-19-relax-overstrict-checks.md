# Plan: relax over-strict checks (for Codex execution)

Repo `structureclaw`. Work on a new branch `fix/relax-strictness` cut from `work/research-next`. Commit locally; never push to `upstream`. Do not touch `tests/llm-benchmark`.

## Evidence: the failed session

Conversation `cmvembhjr0000powm12r6szsf`, 2026-10-19 10:11–10:50. The run record is `sclaw_data/run-records/9c6e14ad-08bc-43db-8630-5dc9a56c98c8.json` and the messages are in `sclaw_data/data/structureclaw.db`.

The user sent "设计一个简支梁，跨度10m，梁中间荷载1kN". The turn took 38 minutes, asked 4 clarifications, made 3 `build_model` calls (all failed), 24 LLM calls and 2 recoveries, and **never produced a result**.

| # | What happened | Over-strict mechanism | Where |
|---|---|---|---|
| 1 | The user answered "Q235，工字钢 I20a". The agent then asked a second question: "confirm the catalogue values?" | Without a catalogue the agent may not use its own knowledge of standard section values. It has to ask the user. | prompts and draft readiness (`templateProperties` missing) |
| 2 | Catalogue A=35.578 cm² was rejected against sharp-corner geometry 35.204 cm² | Explicit properties must equal the geometry derived from `shape`. Catalogue values include fillets, so they always differ by 1–3 %. | `skill-shared/python/structure_protocol/section_properties.py:117-127` |
| 3 | After that, Iy=2.3545e-05 was rejected against 2.35452664e-05, a 5-significant-figure rounding | `rel_tol=1e-6` | same lines |
| 4 | "Recovery budget 2/2 exhausted". The user then confirmed the exact value and was still told to send a new message. | `maxRecoveriesPerTurn=2` counts validator rejections and internal extractor retries. The budget does not reset after the user answers a clarification, because resume continues the same turn. | `runtime/run-policy.ts:38`, `run-context.ts`, resume path |
| 5 | Every clarification answer needs another `extract_draft_params` call: 54k-char prompt, 130–160 s, up to 10k output tokens | Answers are never merged into the draft directly. Each one triggers a full re-extraction. | `tools/ask-clarification.ts:43`, `param-extractor.ts` |
| 6 | The guard flagged "0.5 kN" (=P/2, derived from the user's 1 kN) and spent an extra LLM call | answer-integrity accepts products of user inputs but not simple statics derived from them | `delivery/answer-integrity.ts` |
| 7 | Every assistant message was persisted twice | persistence bug (an interrupt/resume stream writes the same text twice) | `services/chat-persistence.ts`, `api/chat-sse.ts` |
| 8 | The final answer told the user to "send a new message to reset the budget" | internal mechanism leaked to the user | budget error text + prompt |

**Root cause.** The system treats every inconsistency as a hard error and wants the user to resolve it. A good engineer would accept reasonable inputs, record the assumption and carry on.

## Principles

1. **User input wins; the system records, it does not veto.** If something the user gave is inconsistent but usable, adopt it and write a note in the result/report: which value was used, and how it compares with the alternative. Hard rejection is only for physically impossible or uncomputable input: negative, zero, non-finite, or wrong type.
2. **The LLM may use common engineering knowledge** such as standard section tables and material constants. It must state the values and the source in its answer ("按 GB/T 706 I20a：A=35.578 cm²，Ix=2370 cm⁴，请核对"). The system does not check those values against a catalogue.
3. **A question to the user is a last resort.** Ask only when an input that affects the result truly cannot be determined. Never ask the user to settle consistency, precision or format problems. The system resolves those itself.
4. **Budgets limit runaway loops, not normal correction.** A tool rejection that came with a clear repair hint does not consume the recovery budget. A user answer resets the per-turn budgets. Budget mechanics are never shown to the user.

## Changes

### C1. Section geometry vs properties: warn, don't block
File: `section_properties.py` (`validate`, lines ~112-127).
- When both `properties` and `shape` are present, explicit properties are authoritative.
- Relative difference ≤ 5 %: accept, and record `extra.property_geometry_delta = {A: +1.06%, Iy: +0.66%}` together with a note, en and zh: "截面属性采用用户/目录值，与不计圆角的几何值相差 x%".
- Relative difference > 5 %: still accept, but emit a warning diagnostic (not an error). It appears as an assumption/warning in the analysis result and the report.
- Keep hard errors only for non-finite or non-positive values, and for `Wnx` greater than the gross modulus × (1+5 %).
- The `type` vs `shape.kind` check and the legacy width/height vs shape check: change from error to warning, use the `shape` value, and record the conflict.
- Make the `extra.derived_properties` provenance check (line 62) a warning as well.
- Tests: update `regression/test_physical_properties.py` and `engineering-analysis-control.test.mjs:116`. Add cases for the catalogue I20a (A=35.578, Iy=2370 cm⁴ with shape 200×100×7×11.4), which must build and analyse with a delta note, and for a 5-significant-figure rounded Iy, which must be accepted silently.

### C2. Allow the LLM to use standard section values
- System prompt (zh and en): drop the restriction on catalogue values. Add one principle: "可采用常用标准型钢/材料表数值，须在回答中写明取值和来源，供用户核对 / You may use common standard section and material table values; state the values and their source in the answer for the user to verify."
- Extractor prompt: a section designation can be filled with `properties` (A, Iy, Iz, J if known) plus `shape`, with `extra.source = "LLM: GB/T 706 table value, unverified"`. Do not leave `templateProperties` missing.
- Surface `extra.source` in the analysis summary and the report as an assumption that needs checking.
- Do not add a catalogue back to the repository.

### C3. Recovery budget accounting
Files: `runtime/run-context.ts`, `agent-langgraph/sequential-tools.ts`, `guards/tool-guards.ts`, the resume path in `agent-service.ts`.
- A structured tool rejection carrying `hint` or `errorCode` (validation-type) is not a "recovery". Repeated identical failures are already caught by the `REPEATED_FAILED_CALL` guard (2×), and that is the real loop protection.
- "Recovery" counts only internal fallbacks that the system itself triggers, such as rule fallback after an invalid extractor output.
- On resume after `ask_user_clarification`, reset `recoveriesUsed`, the guard rejection counter and the no-progress counter for the continuing turn. A user answer is new information.
- Default `maxRecoveriesPerTurn` stays 2. Keep it in the `no-repair` profile semantics (0).
- Change the `RECOVERY_BUDGET_EXHAUSTED` text to an LLM-facing hint only. Prompt principle: never tell the user about budgets or ask them to "send a new message"; say what is blocked and what input would unblock it.

### C4. Merge clarification answers without full re-extraction
- Preferred: `ask_user_clarification` returns the answer, and the LLM calls `extract_draft_params` with only the answer text plus the existing draft. Add a lightweight "patch" mode in `param-extractor.ts` that builds a short prompt with the current draft summary and the answer, and returns a patch only. The target is a prompt under 10k chars and an answer in under 20 s.
- Lean alternative: if the patch mode is simple, reuse the existing extractor with a trimmed prompt (no full skill catalogue, no examples) when `draftState` already exists and `requestScope` is unchanged.
- Measure the extractor prompt size and latency before and after, and report both.

### C5. Answer-integrity guard: fewer false corrections
File: `delivery/answer-integrity.ts`, `answer-review.ts`.
- Accept values obtainable from user inputs by one elementary operation (×, ÷ by small integers 2, 3, 4, 8, sums). That covers P/2, PL/4 and wL²/8 when the inputs are present.
- Accept numbers that appear in any tool result of the conversation (not only this turn), any value with an explicit source citation, and any value the answer itself labels as an estimate or assumption ("约", "估算", "假定", "approximately", "assumed").
- When there are no analysis results at all (the turn ended without a model), do not request a correction; at most append the note.
- Keep the corpus tests. Add this session's "0.5 kN" as a true negative, so it must not be flagged.

### C6. Duplicate assistant messages
Reproduce with an interrupt/resume conversation in the characterization harness: count persisted assistant messages and expect each text once. Then fix the double write in the persistence/SSE path.

### C7. Prompt cleanup for clarification behaviour
One principle line, zh and en: "只在结果真正依赖、且无法合理确定的输入上提问；一次把需要的问题问全；一致性、精度、格式问题自行处理并说明 / Ask only for inputs the result truly depends on and that cannot reasonably be determined; ask everything needed at once; resolve consistency, precision and format issues yourself and state what you did."

## Acceptance

Automated, all must pass:
- `rm -rf backend/dist`; then `db:generate`, `build`, `lint`, `check:deps`
- full Jest
- `test:python`
- `node tests/runner.mjs analysis-regression`
- the 3 validators
- frontend `type-check`, `test:run`, `test:run:integration`

Update characterization snapshots only for intended prompt or tool-schema changes, and bump `ABLATION_PROFILES_VERSION`.

New characterization (scripted LLM) replaying this session's shape:
- "Q235，工字钢 I20a", with the LLM supplying catalogue A and Iy: builds and analyses with a delta note, at most one clarification.
- A rounded Iy is accepted.
- Clarification resume resets the budget.
- No duplicate messages.

Live, real LLM, in an isolated `SCLAW_DATA_DIR` on a free port via `node backend/dist/index.js`, **not** `./sclaw start`:

| Case | Runs | Must |
|---|---|---|
| "设计一个简支梁，跨度10m，梁中间荷载1kN", answer "Q235钢，工字钢 I20a" | 3 | ≤ 1 clarification, results R=0.5 kN and M=2.5 kN·m; deflection uses the stated I20a values with the source shown; total turn < 5 min of system time |
| Same but answer "Q235，I20a 尺寸 200×100×7×11.4" | 2 | 0 extra questions, sharp-corner note |
| `npm run test:live` (existing suites) | 2 | all pass |
| Run-record check | all | `recoveries` 0–1, no `RECOVERY_BUDGET_EXHAUSTED`, no budget text in user-visible answers |

Report: commits, before/after numbers for this session shape (questions, LLM calls, extractor prompt size and latency, wall time), snapshot diff summary, test summary lines, live table.

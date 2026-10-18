# LLM Integration Fixtures

- `backend/src/agent-skills/**/__tests__/**/*.test.mjs` is for ordinary skill tests.
  These tests must be deterministic and must not call a real external LLM service.
- Real-LLM fixtures live next to the owning skill under `backend/src/agent-skills/**/__llm_tests__/`.
  This folder keeps only their discovery helpers (`lib/`); `tests/regression/backend-validations.js`
  validates the fixtures. There is no runner subcommand for executing them: real-LLM quality runs
  through `tests/llm-benchmark`, and the default-workflow acceptance check is
  `npm run test:live --prefix backend` (see `docs/testing.md`).

## Fixture Rules

- Skill-aware fixtures use the v2 shape: document-level `family`, `scenarios[]`, `scenarioId`, and
  per-variant `enabledSkillIds`, `fallbackPolicy` and `expect`.
- Legacy v1 fixtures with `testCases[]` and `assertions` are still accepted by discovery.

## Commands

```bash
npm run test:skills
node --test tests/llm-integration/lib/*.test.cjs
```

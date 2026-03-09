---
phase: 6
slug: pages-accessibility
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.0.18 |
| **Config file** | frontend/vitest.config.ts |
| **Quick run command** | `cd frontend && npm test` |
| **Full suite command** | `cd frontend && npm run test:run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd frontend && npm test`
- **After every plan wave:** Run `cd frontend && npm run test:run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | PAGE-01 | integration | `npm test -- tests/integration/home-page.test.tsx` | ❌ W0 | ⬜ pending |
| 06-01-02 | 01 | 1 | PAGE-01 | unit | `npm test -- tests/app/home` | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 1 | PAGE-02 | integration | `npm test -- tests/integration/console-page.test.tsx` | ✅ | ⬜ pending |
| 06-03-01 | 03 | 2 | ACCS-01 | unit | `npm test -- tests/accessibility/keyboard.test.tsx` | ❌ W0 | ⬜ pending |
| 06-03-02 | 03 | 2 | ACCS-01 | unit | `npm test -- tests/components/dialog.test.tsx` | ✅ | ⬜ pending |
| 06-04-01 | 04 | 2 | ACCS-02 | unit | `npm test -- tests/accessibility/focus-management.test.tsx` | ❌ W0 | ⬜ pending |
| 06-05-01 | 05 | 2 | ACCS-03 | unit | `npm test -- tests/accessibility/semantic.test.tsx` | ❌ W0 | ⬜ pending |
| 06-06-01 | 06 | 2 | ACCS-04 | unit | `npm test -- tests/accessibility/aria-labels.test.tsx` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/integration/home-page.test.tsx` — stubs for PAGE-01
- [ ] `tests/accessibility/keyboard.test.tsx` — stubs for ACCS-01
- [ ] `tests/accessibility/semantic.test.tsx` — stubs for ACCS-03
- [ ] `tests/accessibility/aria-labels.test.tsx` — stubs for ACCS-04
- [ ] `tests/accessibility/focus-management.test.tsx` — stubs for ACCS-02

*Existing infrastructure: `tests/integration/console-page.test.tsx` and `tests/components/dialog.test.tsx` already exist.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Screen reader announces dynamic content | ACCS-02, ACCS-04 | Requires actual screen reader software | 1. Enable VoiceOver/NVDA 2. Navigate to console 3. Trigger error/result 4. Verify announcement |
| Visual focus indicator visible | ACCS-01 | Visual verification needed | 1. Tab through all interactive elements 2. Verify visible focus ring on each |
| Logical tab order | ACCS-01 | Complex cross-component testing | 1. Tab from top to bottom of console page 2. Verify order follows visual layout |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

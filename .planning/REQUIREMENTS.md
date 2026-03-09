# Requirements: StructureClaw Frontend

**Defined:** 2026-03-09
**Core Value:** Beautiful, professional, easy-to-use structural engineering AI workbench

## v1 Requirements

Frontend rewrite requirements, all implemented in v1.

### Design System

- [x] **DSGN-01**: Establish design tokens (colors, fonts, spacing, border-radius, shadows)
- [x] **DSGN-02**: Configure Geist font (Sans + Mono)
- [x] **DSGN-03**: Tailwind custom configuration (extend theme)
- [x] **DSGN-04**: `cn()` utility function (clsx + tailwind-merge)
- [x] **DSGN-05**: Dark/Light/System tri-state theme switching
- [x] **DSGN-06**: Custom theme accent color
- [x] **DSGN-07**: Glassmorphism effect component variants

### Components

- [ ] **COMP-01**: Button component (multiple sizes, multiple variants)
- [ ] **COMP-02**: Card component
- [ ] **COMP-03**: Input component
- [ ] **COMP-04**: Textarea component
- [ ] **COMP-05**: Select component
- [ ] **COMP-06**: Dialog/Modal component
- [ ] **COMP-07**: Toast notification component (Sonner)
- [ ] **COMP-08**: Skeleton loading component
- [ ] **COMP-09**: Badge component
- [ ] **COMP-10**: Command Palette (Cmd/Ctrl+K)
- [ ] **COMP-11**: Micro-interaction animations (hover, click, transition)

### Layout

- [ ] **LAYT-01**: Responsive sidebar navigation
- [ ] **LAYT-02**: Top status bar
- [ ] **LAYT-03**: Route grouping (marketing/console)
- [ ] **LAYT-04**: Root layout Provider wrapping
- [ ] **LAYT-05**: Draggable split panel layout

### Pages

- [ ] **PAGE-01**: Home page rewrite (product showcase + quick entry)
- [ ] **PAGE-02**: Console page rewrite

### Console

- [ ] **CONS-01**: Endpoint selection UI (agent-run, chat-message, chat-execute)
- [ ] **CONS-02**: Mode selection UI (chat, execute, auto)
- [ ] **CONS-03**: Message input area
- [ ] **CONS-04**: Model JSON input area (collapsible)
- [ ] **CONS-05**: Configuration options panel (analysisType, reportFormat, reportOutput)
- [ ] **CONS-06**: Checkbox group (includeModel, autoAnalyze, autoCodeCheck, includeReport)
- [ ] **CONS-07**: Execute button (sync + SSE streaming)
- [ ] **CONS-08**: Execution result display (traceId, status, response)
- [ ] **CONS-09**: Metrics display (toolCount, durationMs, etc.)
- [ ] **CONS-10**: Tool call timeline (execution order, status, duration)
- [ ] **CONS-11**: Artifacts list display
- [ ] **CONS-12**: SSE streaming execution support
- [ ] **CONS-13**: Flow state indicator (connecting, receiving, complete)
- [ ] **CONS-14**: Debug output panel (Raw JSON + Stream Frames)
- [ ] **CONS-15**: Error state display
- [ ] **CONS-16**: Clarification question display (missing parameter prompt)
- [ ] **CONS-17**: Report summary display

### State & Data

- [ ] **STAT-01**: Zustand store factory pattern (SSR compatible)
- [ ] **STAT-02**: API client layer (fetch wrapper)
- [ ] **STAT-03**: SSE streaming hook
- [ ] **STAT-04**: Theme state management

### Accessibility

- [ ] **ACCS-01**: Keyboard navigation support (Tab, Enter, Escape)
- [ ] **ACCS-02**: Focus management
- [ ] **ACCS-03**: Semantic HTML
- [ ] **ACCS-04**: ARIA labels

## v2 Requirements

Features for future versions.

### Advanced Features

- **ADV-01**: Internationalization (i18n)
- **ADV-02**: Result visualization charts (displacement diagram, internal force diagram)
- **ADV-03**: Model 3D preview
- **ADV-04**: History management
- **ADV-05**: User settings persistence

## Out of Scope

Explicitly excluded features to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Backend API changes | Frontend rewrite does not involve backend |
| Core analysis engine changes | Frontend rewrite does not involve analysis engine |
| Mobile App | This round only does Web responsive |
| Internationalization (i18n) | Keep Chinese for now |
| User authentication system | Use existing backend authentication |
| Database changes | Use existing backend data layer |

## Traceability

Which phase covers which requirement. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| DSGN-01 | Phase 1 | Complete |
| DSGN-02 | Phase 1 | Complete |
| DSGN-03 | Phase 1 | Complete |
| DSGN-04 | Phase 1 | Complete |
| DSGN-05 | Phase 1 | Complete |
| DSGN-06 | Phase 1 | Complete |
| DSGN-07 | Phase 1 | Complete |
| COMP-01 | Phase 2 | Pending |
| COMP-02 | Phase 2 | Pending |
| COMP-03 | Phase 2 | Pending |
| COMP-04 | Phase 2 | Pending |
| COMP-05 | Phase 2 | Pending |
| COMP-06 | Phase 2 | Pending |
| COMP-07 | Phase 2 | Pending |
| COMP-08 | Phase 2 | Pending |
| COMP-09 | Phase 2 | Pending |
| COMP-10 | Phase 2 | Pending |
| COMP-11 | Phase 2 | Pending |
| LAYT-01 | Phase 3 | Pending |
| LAYT-02 | Phase 3 | Pending |
| LAYT-03 | Phase 3 | Pending |
| LAYT-04 | Phase 3 | Pending |
| LAYT-05 | Phase 3 | Pending |
| STAT-01 | Phase 4 | Pending |
| STAT-02 | Phase 4 | Pending |
| STAT-03 | Phase 4 | Pending |
| STAT-04 | Phase 4 | Pending |
| CONS-01 | Phase 5 | Pending |
| CONS-02 | Phase 5 | Pending |
| CONS-03 | Phase 5 | Pending |
| CONS-04 | Phase 5 | Pending |
| CONS-05 | Phase 5 | Pending |
| CONS-06 | Phase 5 | Pending |
| CONS-07 | Phase 5 | Pending |
| CONS-08 | Phase 5 | Pending |
| CONS-09 | Phase 5 | Pending |
| CONS-10 | Phase 5 | Pending |
| CONS-11 | Phase 5 | Pending |
| CONS-12 | Phase 5 | Pending |
| CONS-13 | Phase 5 | Pending |
| CONS-14 | Phase 5 | Pending |
| CONS-15 | Phase 5 | Pending |
| CONS-16 | Phase 5 | Pending |
| CONS-17 | Phase 5 | Pending |
| PAGE-01 | Phase 6 | Pending |
| PAGE-02 | Phase 6 | Pending |
| ACCS-01 | Phase 6 | Pending |
| ACCS-02 | Phase 6 | Pending |
| ACCS-03 | Phase 6 | Pending |
| ACCS-04 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 47 total
- Mapped to phases: 47
- Unmapped: 0

---
*Requirements defined: 2026-03-09*
*Last updated: 2026-03-09 after roadmap creation*

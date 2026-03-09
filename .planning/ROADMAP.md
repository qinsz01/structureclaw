# Roadmap: StructureClaw Frontend

## Overview

This roadmap transforms StructureClaw from a debug-style interface into a polished, Linear/Notion-inspired engineering workbench for structural engineers. The journey builds from design tokens through components to a complete console feature, culminating in polished pages with accessibility validation.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Design System Foundation** - Establish visual language with tokens, fonts, and theme support
- [ ] **Phase 2: Component Library** - Build reusable UI primitives with shadcn/ui patterns
- [ ] **Phase 3: Layout System** - Create responsive app shell with sidebar and header
- [ ] **Phase 4: State & API Layer** - Implement Zustand stores and API client with SSE support
- [ ] **Phase 5: Console Feature** - Rebuild the core console with all existing functionality
- [ ] **Phase 6: Pages & Accessibility** - Compose pages and validate keyboard/ARIA support

## Phase Details

### Phase 1: Design System Foundation
**Goal**: Establish a consistent visual language that enables dark/light/system theme switching from day one
**Depends on**: Nothing (first phase)
**Requirements**: DSGN-01, DSGN-02, DSGN-03, DSGN-04, DSGN-05, DSGN-06, DSGN-07
**Success Criteria** (what must be TRUE):
  1. All colors are defined as CSS custom properties (semantic tokens, not hardcoded values)
  2. Geist font (Sans + Mono) renders correctly across the application
  3. User can switch between light, dark, and system theme preferences without page flash
  4. Custom theme accent color can be applied and persists across sessions
  5. Glassmorphism effect utility classes are available for component use
**Plans**: 6 plans in 3 waves

Plans:
- [ ] 01-00: Wave 0 - Vitest test infrastructure and test stubs
- [ ] 01-01: Design tokens and CSS variables (DSGN-01, DSGN-03)
- [ ] 01-02: Geist font configuration (DSGN-02)
- [ ] 01-03: cn() utility verification and tests (DSGN-04)
- [ ] 01-04: Theme provider with tri-state support (DSGN-05)
- [ ] 01-05: Accent color and glassmorphism utilities (DSGN-06, DSGN-07)

### Phase 2: Component Library
**Goal**: Provide a complete set of UI primitives that embody the Linear/Notion aesthetic
**Depends on**: Phase 1
**Requirements**: COMP-01, COMP-02, COMP-03, COMP-04, COMP-05, COMP-06, COMP-07, COMP-08, COMP-09, COMP-10, COMP-11
**Success Criteria** (what must be TRUE):
  1. Developer can use Button with multiple sizes (sm, md, lg) and variants (default, destructive, outline, ghost)
  2. Form inputs (Input, Textarea, Select) have consistent styling and focus states
  3. Modal dialogs open/close smoothly and trap focus correctly
  4. Toast notifications appear at bottom-right and auto-dismiss after 4 seconds
  5. Command palette opens with Cmd/Ctrl+K and provides fuzzy search
  6. All components have smooth hover/click micro-interactions
**Plans**: TBD

Plans:
- [ ] 02-01: Base form components (Button, Input, Textarea, Select)
- [ ] 02-02: Container components (Card, Dialog, Badge)
- [ ] 02-03: Feedback components (Toast, Skeleton)
- [ ] 02-04: Command palette and micro-interactions

### Phase 3: Layout System
**Goal**: Provide a responsive app shell that works across desktop and tablet viewports
**Depends on**: Phase 2
**Requirements**: LAYT-01, LAYT-02, LAYT-03, LAYT-04, LAYT-05
**Success Criteria** (what must be TRUE):
  1. Sidebar navigation collapses/expands on desktop and is accessible on tablet
  2. Top status bar displays current context and global actions
  3. Routes are grouped into marketing (public) and console (authenticated) sections
  4. All providers (theme, toast, etc.) are properly wrapped in root layout
  5. Split panel layout supports draggable resizing between content areas
**Plans**: TBD

Plans:
- [ ] 03-01: Responsive sidebar and header
- [ ] 03-02: Route groups and root layout providers
- [ ] 03-03: Split panel layout component

### Phase 4: State & API Layer
**Goal**: Establish a type-safe data layer that maintains API contract compliance
**Depends on**: Phase 3
**Requirements**: STAT-01, STAT-02, STAT-03, STAT-04
**Success Criteria** (what must be TRUE):
  1. Zustand stores use factory pattern for SSR compatibility
  2. API client centralizes fetch logic with consistent error handling
  3. SSE hook properly manages connection lifecycle (connect, reconnect, cleanup)
  4. Theme preference persists in localStorage and syncs across tabs
**Plans**: TBD

Plans:
- [ ] 04-01: Zustand store factory setup
- [ ] 04-02: API client with contract tests
- [ ] 04-03: SSE streaming hook with lifecycle management

### Phase 5: Console Feature
**Goal**: Deliver the complete console experience with all existing functionality in the new design
**Depends on**: Phase 4
**Requirements**: CONS-01, CONS-02, CONS-03, CONS-04, CONS-05, CONS-06, CONS-07, CONS-08, CONS-09, CONS-10, CONS-11, CONS-12, CONS-13, CONS-14, CONS-15, CONS-16, CONS-17
**Success Criteria** (what must be TRUE):
  1. User can select endpoint (agent-run, chat-message, chat-execute) and mode (chat, execute, auto)
  2. User can input message text and optionally expand JSON model input area
  3. User can configure analysis options (analysisType, reportFormat, reportOutput) via checkboxes
  4. User can execute requests with streaming SSE and see real-time status indicator
  5. User can view execution results including traceId, status, response, and metrics
  6. User can see tool call timeline with execution order, status, and duration
  7. User can view artifacts list and debug output (raw JSON, stream frames)
  8. User receives clear error messages and clarification prompts when applicable
  9. User can see report summary after successful execution
**Plans**: TBD

Plans:
- [ ] 05-01: Console input controls (endpoint, mode, message, model JSON)
- [ ] 05-02: Configuration panel (options, checkboxes, execute button)
- [ ] 05-03: Result display (status, metrics, timeline)
- [ ] 05-04: Artifacts and debug output
- [ ] 05-05: SSE streaming and flow state indicator
- [ ] 05-06: Error states and clarification prompts

### Phase 6: Pages & Accessibility
**Goal**: Complete the application with polished pages and validated accessibility
**Depends on**: Phase 5
**Requirements**: PAGE-01, PAGE-02, ACCS-01, ACCS-02, ACCS-03, ACCS-04
**Success Criteria** (what must be TRUE):
  1. Home page showcases product value and provides quick entry points to console
  2. Console page composes all feature components into a cohesive experience
  3. All interactive elements are reachable via Tab keyboard navigation
  4. Focus is properly managed when modals/dropdowns open and close
  5. All components use semantic HTML elements with appropriate ARIA labels
**Plans**: TBD

Plans:
- [ ] 06-01: Home page rewrite
- [ ] 06-02: Console page composition
- [ ] 06-03: Keyboard navigation and focus management
- [ ] 06-04: ARIA labels and semantic HTML audit

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Design System Foundation | 4/6 | In Progress|  |
| 2. Component Library | 0/4 | Not started | - |
| 3. Layout System | 0/3 | Not started | - |
| 4. State & API Layer | 0/3 | Not started | - |
| 5. Console Feature | 0/6 | Not started | - |
| 6. Pages & Accessibility | 0/4 | Not started | - |

---
*Roadmap created: 2026-03-09*
*Granularity: standard*
*Total phases: 6*
*Phase 1 planned: 2026-03-09*

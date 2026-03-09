# Phase 6: Pages & Accessibility - Research

**Researched:** 2026-03-10
**Domain:** Page composition, WCAG 2.1 accessibility, keyboard navigation, focus management
**Confidence:** HIGH

## Summary

This phase focuses on two distinct but related concerns: (1) completing the application's main pages with polished UX, and (2) ensuring comprehensive accessibility compliance through keyboard navigation, focus management, and proper ARIA implementation.

**Key insight:** The project already uses Radix UI primitives (@radix-ui/react-dialog, @radix-ui/react-select, etc.) which provide built-in accessibility features. The accessibility work should leverage these existing foundations rather than building custom solutions.

**Primary recommendation:** Compose existing console components into a polished home page and console page, then audit and enhance keyboard navigation and ARIA labels. The focus trap and keyboard handling from Radix UI already handles most complex patterns (dialogs, selects).

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PAGE-01 | Home page rewrite (product showcase + quick entry) | SaaS landing page patterns: hero section, value proposition, CTA buttons, dark/light theme support |
| PAGE-02 | Console page rewrite | Compose existing console components (EndpointSelector, MessageInput, ConfigPanel, ExecuteButton, ResultDisplay, etc.) into cohesive SplitPanel layout |
| ACCS-01 | Keyboard navigation support (Tab, Enter, Escape) | WCAG 2.1.1 Level A compliance; use focus-visible styles; verify tab order; leverage Radix UI built-in keyboard handling |
| ACCS-02 | Focus management | Use Radix UI focus trap for dialogs; ensure focus returns when modals close; manage focus on dynamic content |
| ACCS-03 | Semantic HTML | Use native elements (button, input, select, label); proper heading hierarchy; landmarks (main, nav, header) |
| ACCS-04 | ARIA labels | aria-label for icon-only buttons; aria-labelledby for form controls; aria-describedby for help text; screen reader text (sr-only) |

</phase_requirements>

## Standard Stack

### Core (Already Installed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @radix-ui/react-dialog | ^1.1.15 | Modal dialogs with focus trap | Built-in accessibility, focus management, keyboard handling |
| @radix-ui/react-select | ^2.2.6 | Accessible select dropdowns | Full keyboard navigation, ARIA support |
| @radix-ui/react-checkbox | ^1.3.3 | Accessible checkboxes | Proper ARIA states |
| @radix-ui/react-tooltip | ^1.2.8 | Accessible tooltips | Keyboard dismissible, proper labeling |
| @radix-ui/react-collapsible | ^1.1.12 | Collapsible panels | Keyboard accessible |
| lucide-react | ^0.363.0 | Icon library | Used for visual elements; needs aria-label when decorative |

### Supporting (For Testing)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @testing-library/react | ^16.3.2 | React testing | Testing component accessibility |
| @testing-library/user-event | ^14.6.1 | User interaction simulation | Testing keyboard interactions |
| vitest | ^4.0.18 | Test framework | Already configured |

### Recommended Additions

| Library | Purpose | Why |
|---------|---------|-----|
| jest-axe | Automated accessibility testing | Catches WCAG violations in CI |

**Installation (for accessibility testing):**
```bash
npm install --save-dev jest-axe @types/jest-axe
```

## Architecture Patterns

### Recommended Home Page Structure

```
src/app/(marketing)/page.tsx
├── Hero Section
│   ├── Headline + Value Proposition
│   ├── Description
│   └── CTA Button (Link to /console)
├── Features Grid (optional, based on time)
│   ├── Feature Card 1
│   ├── Feature Card 2
│   └── Feature Card 3
└── Footer (minimal)
```

### Current Console Page Structure (Already Implemented)

```
src/app/(console)/console/page.tsx
├── SplitPanel (40/60)
│   ├── Left Panel (Input Controls)
│   │   ├── EndpointSelector
│   │   ├── MessageInput
│   │   ├── ModelJsonPanel
│   │   ├── ConfigPanel
│   │   ├── StatusIndicator
│   │   └── ExecuteButton
│   └── Right Panel (Results)
│       ├── ErrorDisplay
│       ├── ClarificationPrompt
│       ├── ResultDisplay
│       ├── ArtifactsList
│       └── DebugOutput
```

### Pattern 1: Semantic Page Structure

**What:** Use HTML5 landmarks and proper heading hierarchy for screen reader navigation.

**When to use:** All pages must have this structure.

**Example:**
```tsx
// src/app/(marketing)/page.tsx
export default function HomePage() {
  return (
    <main className="...">
      <section aria-labelledby="hero-heading">
        <h1 id="hero-heading" className="text-4xl font-bold">
          StructureClaw
        </h1>
        <p className="text-muted-foreground">
          {description}
        </p>
        <Link href="/console">
          <Button size="lg" aria-label="Go to Agent Console">
            Enter Console
          </Button>
        </Link>
      </section>
    </main>
  )
}
```

### Pattern 2: Accessible Form Controls

**What:** Every form control must have an associated label, either via `htmlFor`/`id` or `aria-labelledby`.

**When to use:** All inputs, selects, textareas.

**Example (already in EndpointSelector):**
```tsx
<div className="space-y-2">
  <label htmlFor="endpoint-select" className="text-sm font-medium">
    Endpoint
  </label>
  <Select value={endpoint} onValueChange={...}>
    <SelectTrigger id="endpoint-select" aria-label="Endpoint">
      <SelectValue placeholder="Select endpoint" />
    </SelectTrigger>
    ...
  </Select>
</div>
```

### Pattern 3: Keyboard Navigation Testing

**What:** Test that all interactive elements are reachable and operable via keyboard.

**Test pattern:**
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

it('all buttons are reachable via Tab', async () => {
  const user = userEvent.setup()
  render(<MyComponent />)

  const buttons = screen.getAllByRole('button')
  for (const button of buttons) {
    await user.tab() // Move focus to next element
    expect(button).toHaveFocus()
  }
})

it('Escape closes dialogs', async () => {
  const user = userEvent.setup()
  render(<DialogComponent defaultOpen />)

  expect(screen.getByRole('dialog')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
```

### Pattern 4: Focus Management on Dynamic Content

**What:** When content appears/disappears, manage focus appropriately.

**When to use:** Error messages, clarification prompts, result displays.

**Example:**
```tsx
import { useEffect, useRef } from 'react'

export function ErrorDisplay({ error }: { error: string | null }) {
  const alertRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (error && alertRef.current) {
      // Focus the alert when error appears
      alertRef.current.focus()
    }
  }, [error])

  if (!error) return null

  return (
    <div
      ref={alertRef}
      role="alert"
      aria-live="polite"
      tabIndex={-1}
      className="..."
    >
      {error}
    </div>
  )
}
```

### Pattern 5: Screen Reader Only Text

**What:** Provide context for screen readers without visual clutter.

**Example:**
```tsx
<span className="sr-only">Close dialog</span>
```

The `sr-only` class should be defined in Tailwind config or CSS:
```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}
```

### Anti-Patterns to Avoid

- **Using div instead of button:** Use `<button>` for clickable actions. If styling requires, use `asChild` with Radix Slot.
- **Missing focus styles:** Never remove `focus-visible` styles. The Button component already has these.
- **Generic link text:** Avoid "Click here" - use descriptive text like "Go to Console".
- **aria-label overuse:** Prefer visible labels with `htmlFor`/`id` association over `aria-label`.
- **Positive tabindex:** Never use `tabindex > 0`. Use `tabindex={0}` only for non-interactive elements that should be focusable, `tabindex={-1}` for programmatic focus.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Focus trap for modals | Custom focus management | Radix Dialog (already in use) | Handles edge cases, escape key, focus restoration |
| Custom select dropdown | div-based select | Radix Select (already in use) | Keyboard navigation, ARIA, positioning |
| Custom checkbox | Styled div | Radix Checkbox (already in use) | ARIA states, keyboard activation |
| Skip to main content link | Custom implementation | Standard anchor link | Simple pattern, well-supported |
| Focus visible polyfill | Custom JS | Tailwind `focus-visible:` variants | Already configured |

**Key insight:** The project already uses shadcn/ui components backed by Radix UI primitives. These handle the complex accessibility patterns. The work in this phase is primarily:
1. Composing pages correctly with semantic HTML
2. Adding proper labels and ARIA attributes
3. Testing keyboard navigation
4. Managing focus on dynamic content

## Common Pitfalls

### Pitfall 1: Missing aria-label on Icon-Only Buttons

**What goes wrong:** Buttons with only an icon have no accessible name.

**Why it happens:** The icon is decorative, so there's no text content.

**How to avoid:** Always add `aria-label` to icon-only buttons.

**Warning signs:** Button with no visible text, screen reader announces "button" with no context.

```tsx
// BAD
<Button variant="ghost" size="icon">
  <X className="h-4 w-4" />
</Button>

// GOOD
<Button variant="ghost" size="icon" aria-label="Close">
  <X className="h-4 w-4" />
</Button>

// ALSO GOOD (sr-only text)
<Button variant="ghost" size="icon">
  <X className="h-4 w-4" />
  <span className="sr-only">Close</span>
</Button>
```

### Pitfall 2: Focus Not Restored After Modal Close

**What goes wrong:** After closing a dialog, focus is lost (returns to body).

**Why it happens:** Focus management not implemented.

**How to avoid:** Radix Dialog handles this automatically - ensure you're using it correctly.

**Warning signs:** Tab order resets after closing a modal.

```tsx
// Radix Dialog already handles focus restoration
// Just ensure you're using DialogTrigger properly
<Dialog>
  <DialogTrigger asChild>
    <Button>Open</Button> {/* Focus returns here after close */}
  </DialogTrigger>
  <DialogContent>...</DialogContent>
</Dialog>
```

### Pitfall 3: Dynamic Content Not Announced

**What goes wrong:** Screen readers don't announce when content appears (errors, results).

**Why it happens:** No ARIA live region.

**How to avoid:** Use `role="alert"` or `aria-live="polite"` on containers that receive dynamic content.

**Warning signs:** Error messages or results appear but screen reader doesn't announce them.

```tsx
// For errors (interruptive, high priority)
<div role="alert" aria-live="assertive">
  {error}
</div>

// For general updates (non-interruptive)
<div aria-live="polite">
  {result}
</div>
```

### Pitfall 4: Incorrect Heading Hierarchy

**What goes wrong:** Headings skip levels (h1 -> h3) or have multiple h1s.

**Why it happens:** Styling concerns override semantic concerns.

**How to avoid:** Use headings for structure, style with Tailwind classes.

**Warning signs:** Multiple `<h1>` tags, skipped heading levels.

```tsx
// BAD - h2 for styling
<h2 className="text-4xl font-bold">Hero Title</h2>

// GOOD - h1 for main title, Tailwind for size
<h1 className="text-4xl font-bold">Hero Title</h1>
<h2 className="text-2xl font-semibold">Section Title</h2>
```

### Pitfall 5: Non-Interactive Elements in Tab Order

**What goes wrong:** divs or spans are focusable but not operable.

**Why it happens:** Developer adds `tabindex={0}` to make something "clickable".

**How to avoid:** Use semantic elements. If it's clickable, use a button.

**Warning signs:** Focus stops on non-interactive elements, nothing happens on Enter/Space.

```tsx
// BAD
<div onClick={handleClick} tabIndex={0}>
  Click me
</div>

// GOOD
<button onClick={handleClick}>
  Click me
</button>

// If it MUST be a div (rare), add keyboard handler
<div
  onClick={handleClick}
  onKeyDown={(e) => e.key === 'Enter' && handleClick()}
  tabIndex={0}
  role="button"
>
  Click me
</div>
```

## Code Examples

### Home Page with Accessibility

```tsx
// src/app/(marketing)/page.tsx
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import Link from 'next/link'
import { ArrowRight, Zap, Shield, FileText } from 'lucide-react'

const features = [
  {
    icon: Zap,
    title: 'AI-Powered Analysis',
    description: 'Automatic structural analysis with intelligent code checking'
  },
  {
    icon: Shield,
    title: 'GB50017 Compliant',
    description: 'Built-in Chinese steel structure code verification'
  },
  {
    icon: FileText,
    title: 'Auto Report Generation',
    description: 'Generate professional reports in Markdown and JSON formats'
  }
]

export default function HomePage() {
  return (
    <main className="flex flex-col min-h-[calc(100vh-3.5rem)]">
      {/* Hero Section */}
      <section
        className="flex flex-col items-center justify-center flex-1 gap-8 p-8"
        aria-labelledby="hero-heading"
      >
        <h1 id="hero-heading" className="text-4xl font-bold tracking-tight sm:text-5xl">
          StructureClaw
        </h1>
        <p className="text-muted-foreground text-center max-w-md text-lg">
          AI-powered structural engineering workbench - Beautiful, Professional, Easy-to-use
        </p>
        <Link href="/console">
          <Button size="lg" aria-label="Enter the Agent Console">
            Enter Console
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </Link>
      </section>

      {/* Features Section */}
      <section
        className="px-8 pb-12"
        aria-labelledby="features-heading"
      >
        <h2 id="features-heading" className="sr-only">
          Features
        </h2>
        <div className="grid gap-6 md:grid-cols-3 max-w-4xl mx-auto">
          {features.map((feature) => (
            <Card key={feature.title}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <feature.icon className="h-5 w-5" aria-hidden="true" />
                  {feature.title}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription>{feature.description}</CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </main>
  )
}
```

### Accessible Error Display with Focus Management

```tsx
// src/components/console/error-display.tsx
'use client'

import { useEffect, useRef } from 'react'
import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ErrorDisplayProps {
  error: string | null
  className?: string
}

export function ErrorDisplay({ error, className }: ErrorDisplayProps) {
  const alertRef = useRef<HTMLDivElement>(null)

  // Focus the alert when error appears for screen readers
  useEffect(() => {
    if (error && alertRef.current) {
      alertRef.current.focus()
    }
  }, [error])

  if (!error) return null

  return (
    <div
      ref={alertRef}
      role="alert"
      aria-live="assertive"
      tabIndex={-1}
      className={cn(
        'flex items-start gap-3 p-4 rounded-lg bg-destructive/10 text-destructive border border-destructive/20',
        className
      )}
    >
      <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium">Error</p>
        <p className="text-sm opacity-90">{error}</p>
      </div>
    </div>
  )
}
```

### Keyboard Navigation Test Pattern

```tsx
// tests/accessibility/keyboard-navigation.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomePage } from '@/app/(marketing)/page'

describe('Keyboard Navigation (ACCS-01)', () => {
  it('all interactive elements on home page are reachable via Tab', async () => {
    const user = userEvent.setup()
    render(<HomePage />)

    // First tab should reach the Enter Console button
    await user.tab()
    const consoleButton = screen.getByRole('link', { name: /enter.*console/i })
    expect(consoleButton).toHaveFocus()
  })

  it('Enter activates buttons', async () => {
    const user = userEvent.setup()
    render(<HomePage />)

    await user.tab()
    await user.keyboard('{Enter}')

    // Link should be activated (would navigate to /console)
    // In test environment, we verify the element has focus and is a link
    const consoleButton = screen.getByRole('link', { name: /enter.*console/i })
    expect(consoleButton).toHaveFocus()
  })
})

describe('Dialog Keyboard Handling', () => {
  it('Escape closes dialog', async () => {
    const user = userEvent.setup()
    // ... test dialog escape behavior
  })

  it('Tab is trapped within open dialog', async () => {
    const user = userEvent.setup()
    // ... test focus trap
  })
})
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual focus management | Radix UI primitives handle focus | Since project start | Reduced complexity, better accessibility |
| Custom ARIA implementation | Radix UI provides ARIA attributes | Since project start | More consistent, tested patterns |
| jest + react-testing-library | vitest + @testing-library/react | Phase 1 | Faster tests, ESM-native |

**Deprecated/outdated:**
- Manual focus trapping: Use Radix Dialog which handles this automatically
- Positive tabindex values: Never appropriate, breaks natural tab order
- Using div with onClick for buttons: Always use semantic `<button>` element

## Open Questions

1. **Should we add jest-axe for automated accessibility testing?**
   - What we know: The project uses vitest; jest-axe is Jest-focused but has vitest-axe variant
   - What's unclear: Whether the setup complexity is worth it for a single phase
   - Recommendation: Consider manual accessibility testing checklist for this phase; add automated testing in future if needed

2. **How comprehensive should the home page be?**
   - What we know: Current page is minimal; requirements say "product showcase + quick entry"
   - What's unclear: Scope of "showcase" - full features section or minimal hero
   - Recommendation: Implement hero + 3 feature cards for balance of polish and scope

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | frontend/vitest.config.ts |
| Quick run command | `cd frontend && npm test` |
| Full suite command | `cd frontend && npm run test:run` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PAGE-01 | Home page renders with hero and CTA | integration | `npm test -- tests/integration/home-page.test.tsx` | Wave 0 |
| PAGE-02 | Console page composes all components | integration | `npm test -- tests/integration/console-page.test.tsx` | Yes |
| ACCS-01 | Tab reaches all interactive elements | unit | `npm test -- tests/accessibility/keyboard.test.tsx` | Wave 0 |
| ACCS-01 | Escape closes dialogs | unit | `npm test -- tests/components/dialog.test.tsx` | Yes |
| ACCS-02 | Focus trapped in dialogs | unit | `npm test -- tests/components/dialog.test.tsx` | Partial |
| ACCS-02 | Focus returns after dialog close | unit | `npm test -- tests/components/dialog.test.tsx` | Wave 0 |
| ACCS-03 | Semantic HTML landmarks present | unit | `npm test -- tests/accessibility/semantic.test.tsx` | Wave 0 |
| ACCS-04 | ARIA labels on all controls | unit | `npm test -- tests/accessibility/aria-labels.test.tsx` | Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test` (watch mode for quick feedback)
- **Per wave merge:** `npm run test:run` (full suite)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `tests/integration/home-page.test.tsx` - covers PAGE-01
- [ ] `tests/accessibility/keyboard.test.tsx` - covers ACCS-01
- [ ] `tests/accessibility/semantic.test.tsx` - covers ACCS-03
- [ ] `tests/accessibility/aria-labels.test.tsx` - covers ACCS-04
- [ ] `tests/accessibility/focus-management.test.tsx` - covers ACCS-02

## Sources

### Primary (HIGH confidence)

- [Radix UI Accessibility Documentation](https://www.radix-ui.com/primitives/docs/overview/accessibility) - Official docs covering WAI-ARIA compliance, focus management, keyboard navigation
- Project source code analysis - Existing components already use Radix primitives with built-in accessibility

### Secondary (MEDIUM confidence)

- [WCAG 2.1.1 Keyboard (Level A) Guide](https://testparty.ai/blog/wcag-2-1-1-keyboard-2025-guide) - Complete guide to keyboard accessibility requirements
- [React Accessibility Best Practices](https://www.allaccessible.org/blog/react-accessibility-best-practices-guide) - WCAG 2.2 AA compliant patterns
- [How to Build Keyboard-Navigable Components in React](https://oneuptime.com/blog/post/2026-01-15-keyboard-navigable-components-react/view) - Focus management patterns
- [ARIA Labels Implementation Guide](https://www.allaccessible.org/blog/implementing-aria-labels-for-web-accessibility) - aria-label, aria-labelledby, aria-describedby usage

### Tertiary (LOW confidence)

- [SaaS Landing Page Examples](https://saaslandingpage.com/) - Design inspiration for home page structure
- [Next.js Landing Page Patterns](https://anotherwrapper.com/blog/next-js-landing-page-template) - Hero section patterns

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All components already in use, well-documented Radix UI patterns
- Architecture: HIGH - Clear patterns from WCAG and Radix documentation
- Pitfalls: HIGH - Common accessibility issues well-documented in web standards

**Research date:** 2026-03-10
**Valid until:** 30 days (stable standards - WCAG 2.1 is stable, Radix patterns are consistent)

# Plan: result visualization cleanup (for Codex execution)

Repo `structureclaw`. Create the branch `fix/visualization` from `work/research-next`. Commit locally only; never push and never touch `tests/llm-benchmark`. Frontend work only, unless a data field is genuinely missing: that one exception is backend `memberResponses` plumbing, and is explicitly allowed.

## Evidence

The audit (2026-10-19) has screenshots and click diffs in `G:\StructureClaw-All\viz-audit\` (`results.json`, `audit.log`, `*-before.png` / `*-after.png`). It ran three models: a simple beam, the 2D frame INT-074 and the 3D frame INT-074.

The core problem: each view reads only part of the toolbar state, yet the toolbar shows every control in every view. As a result:

- **Controls that don't work:**
  - "显示未变形" / Undeformed Overlay: drawn as a 1 px, 45 % grey line that sits exactly on the cyan grid axis, so it is invisible.
  - Deformation scale: shown in every view. Every slider tick refits the camera, and the value resets when the case changes.
  - Force component buttons: locked to M2 by the result workspace.
  - Legend toggle in Model view.
  - Grid-plane buttons in 2D.
  - Double-click "fit": only clears the selection.
- **Controls that work but give wrong output:**
  - Forces view paints each member one flat colour from max|value|. It never draws N/V/M diagrams, even though `memberResponses` already carries 81–162 samples per member.
  - The reaction colour bar has a floor of 1.
  - The buckling legend gradient does not match the colour of the members.
  - 3D plane presets remap the axes instead of moving the camera.
  - Exported PNGs have a transparent background and no legend or labels.
  - "Query this object" closes the viewer.
  - Toggle states leak across sessions.
  - 2D free joints are drawn as partial supports.
  - Labels wrap one character per line in 3D.
  - The status shows raw floats such as `-2.500000000000001`.
- **Duplication and dead code:**
  - `getCaseLabel` is defined twice.
  - The buckling legend is computed twice.
  - The extension registry's `isAvailable` and `renderAside` are never called.
  - `maxUtilization` is unused.
  - Hover/selection colour logic is repeated five times.
  - About 80 hardcoded colours bypass the design tokens.
  - There are inline zh/en strings.

## Target design

### State model (single source of truth)

One reducer or Zustand slice, `vizState`:

```text
{ view, caseKey, component, deformScale, showOriginal, showLoads, showLabels, showLegend, selection }
```

Each view declares its applicable controls:

| View | Available when | Controls |
|---|---|---|
| Model | always | loads (if the case has loads), labels |
| Deformed | displacements exist and the run is not a stiffness placeholder | scale (no camera refit while dragging), "原始形状 / Original shape" toggle, labels, legend |
| Diagram | memberResponses exist | component: N / V / M, plus V2/V3/M2/M3/T for 3D; labels, legend |
| Reactions | reactions exist | labels, legend |
| Buckling / Utilization | only when that data exists | mode selector / legend |

The toolbar renders only the controls of the active view. A view that does not apply is not shown. Never show a disabled button that does nothing.

State resets to defaults when the viewer opens for a different run or figure. Within the same session it persists.

### Ownership

The result workspace owns `run`, `case` and `object`. The viewer shows the case as read-only and offers a "切换工况" link back to the workspace. It must not keep a second case selector that does nothing.

The viewer owns `view`, `component` and the display toggles. Remove the viewer's duplicate metric buttons that only round-trip to the workspace.

"查询此对象 / Query this object" runs the query in place and shows the value in the side panel. The viewer stays open.

### Drawing

| Element | Requirement |
|---|---|
| Original shape | Dashed line in a token colour that contrasts with both the grid and the deformed shape, e.g. neutral-300 dashed at full opacity. Draw it above the grid. |
| Diagrams | Real N/V/M diagrams from `memberResponses` samples. Fill the area perpendicular to the member in its local plane, with sign colouring (positive and negative). Label the peak and the end values in display units. Choose the diagram scale so the largest ordinate is about 15 % of the model size, with a slider to adjust it. Keep the old single-colour member tint only as a fallback when there are no samples. |
| Reactions | Force arrows and moment arcs with numeric labels. Colour bar range is exactly [0, max\|R\|] with no floor. Envelopes draw arrows for max/min, or say clearly that they are unavailable. |
| Loads | Point and nodal arrows point toward the node; their tail is the offset end. Distributed loads keep their current form. |
| Supports | A support marker is drawn only when an in-plane DOF is restrained (2D) or any translational DOF is restrained (3D). Out-of-plane constraints of 2D models are not supports. |
| Labels | Fixed-width, no-wrap pills in 3D. |
| Colours | All scene and toolbar colours come from design tokens or CSS variables. Light and dark themes must both look intentional. "No data" members are neutral grey, not 0 % blue. |
| Camera | Fit/reset, plus double-click to fit (matching the hint). In 3D, view presets Front / Side / Top / Iso move the camera instead of remapping the axes. 2D shows only Fit. Fix the skewed initial 2D camera: wait for the fit animation to finish before the focus controller moves the camera. |
| Export | One "导出图片 / Export image" action. Opaque background matching the theme. Includes title (structure, run, case), legend with units, labels if they are on, and a scale bar or deformation factor note. Default 2×. |

### Cleanup

- Delete:
  - the duplicated `getCaseLabel`
  - the unused buckling legend code path
  - the unused `isAvailable` / `renderAside` registry API, or wire them in if the new view model needs them (prefer deletion)
  - `maxUtilization`
- Merge the five copies of the hover/selection colour logic into one helper.
- Move inline zh/en strings into the i18n message files (`lib/i18n/messages/visualization.ts`):
  - modal "Query this object"
  - the native-station panel
  - the units panel `q:` / `A:`
- Show only units relevant to the current view.
- Native-station panel units come from the snapshot units, not hardcoded kN / kN·m.
- Status values use the shared number formatter with significant digits (e.g. `-2.50 kN·m`).

## Tests

- **Unit (Vitest):**
  - view → controls mapping
  - state reset on a new figure
  - diagram geometry: sign and ordinate scaling for a simply supported beam (M parabola or triangle) and a cantilever
  - support-marker rule for 2D free joints
  - colour-bar range
  - number formatting
- **Component tests:**
  - The toolbar renders only applicable controls, for Model / Deformed / Diagram / Reactions and for a placeholder (force-only) run.
  - "Query this object" keeps the viewer open.
- **Playwright e2e:** extend `frontend/tests/e2e/specs/engineering-workflow.spec.ts`, or add `visualization.spec.ts`, using the existing e2e fixtures (beam, plus a 2D frame and a 3D frame model). For every visible control, assert a visible effect: the canvas pixel diff over a threshold, or the DOM/legend change. Specifically:
  - toggling the original shape changes pixels by more than a threshold in Deformed view;
  - the diagram view shows a non-uniform filled diagram with a peak label of 2.5 kN·m for the beam;
  - an exported PNG is opaque and contains the legend.
  - Screenshot each view at 1440 and 768 width, in light and dark themes, and in zh and en. Store the screenshots as test artifacts, not as strict visual baselines.
- **Regression:** `type-check`, `lint`, `test:run`, `test:run:integration` and `build` must pass, and all existing e2e specs must still pass.

## Acceptance

- Re-run the audit script `G:\StructureClaw-All\viz-audit\audit.mjs`, adapted to the new controls, for the beam, the 2D frame and the 3D frame. Every visible control must produce a visible effect (class a). Report the table again.
- Manual screenshots of each view for the three models in `G:\StructureClaw-All\verification\visualization-20261019\`.
- Do not disturb the user's dev servers (31415 / 3000). Use e2e port 31595 and stop every process you start.

## Report

- commits
- before/after control table
- screenshots paths
- test summary lines
- anything left open

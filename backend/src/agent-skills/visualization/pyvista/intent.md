
# PyVista Visualization Skill

Generates high-quality 3D scientific visualizations using PyVista (VTK-based) for structural analysis results.

## Purpose

Renders solid/shell element meshes, stress contours, deformation fields, and isosurfaces that go beyond the
wire-frame beam/truss renderer. Produces publication-quality images and optionally exports `.vtk` / `.vtp` files
for downstream use in ParaView or other VTK-compatible tools.

## Capabilities

- **Surface mesh rendering**: triangulated shell and solid element surfaces with smooth shading
- **Scalar contour plots**: von Mises stress, principal stresses, displacement magnitude, temperature
- **Isosurface extraction**: constant-value surfaces through 3D scalar fields
- **Deformation animation**: time-step or load-step sweep exported as GIF / MP4
- **VTK export**: `.vtk` / `.vtp` unstructured grid files for ParaView

## Input

Expects `analysis.data` to contain:
- `nodes`: list of `{id, x, y, z}` objects
- `elements`: list with `type` in `['quad4', 'tri3', 'hex8', 'tet4', 'shell']` and `nodes` array
- `results.nodeStress` or `results.nodeDisplacement`: scalar/vector fields keyed by node id

## Output

Returns a `VisualizationHints` object with `plotlyChartSpec` set to a base64-encoded PNG or an inline
Plotly figure spec for embedding in the chat response, plus a `statusMessage` describing the render.

## Activation

This skill is **not loaded by default**. It activates when the user explicitly requests 3D mesh
visualization, contour plots, or PyVista/VTK rendering for solid or shell element models.

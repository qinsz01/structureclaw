# V2.2 material, section and code-check acceptance

V2.2 keeps one physical model and adds typed design inputs. This is a capability
acceptance record, not a claim that every GB clause or every commercial solver
path is implemented. Historical paper data and frozen benchmark answers are not
rewritten.

## Persisted inputs

| Field | Meaning and units |
| --- | --- |
| `material.G` | Explicit shear modulus, MPa. OpenSees uses it; absent G is derived as E/(2(1+nu)). Effective settings record the source. |
| `material.design` | Declared `f`, `fv`, `fc`, `ft`, `ftk`, `Ec`, `Es`, `fy`, `fyv`, `fy_compression` in MPa; `ecu`, `alpha1`, `beta1` are dimensionless. Top-level `fy` retains its historical yield-strength meaning. |
| `element.design` | `l0`, `h0`, `crackWidthLimit` in mm; explicit stability, slenderness, width/thickness and serviceability coefficients. No field overrides solver results. |
| `element.design.reinforcement` | `{confirmed, values, source?}`. Areas are mm²; diameters, spacing and cover are mm. Migrating old flat fields does not invent confirmation. |
| `element.design.serviceability_result_keys` | Explicit result selections, e.g. `case:S` or `combination:SLS`. No inferred switch from an ultimate combination to serviceability. |
| `story.load_area_m2` | Explicit actual loaded area. A regular 3D frame template records its known rectangular area; a commercial adapter cannot infer an irregular floor from the entire model bounding box. |
| `analysis_control.mass_source`, `mass_directions` | Adds `floor-seismic`; optional nonempty unique translational directions. The common mass assembler enforces engine/method applicability. |

Known historical top-level/extra design fields migrate once, with contradictions
rejected. Legacy section G migrates to its assigned material. Unassigned section
G remains recorded as historical evidence, and is not silently discarded.

## One section source

Section geometry is mm; A is m², I/J are m⁴ and elastic moduli Wx/Wz are m³.
Supported rectangle, circular, symmetric H/I and box geometric A/I must agree
with supplied values within a frozen serialization tolerance (relative 1e-6).
Net modulus cannot exceed gross modulus. Missing properties derive from geometry
with recorded method/fields. Circular J is exact; rectangular and thin-wall H
derived J carry the documented geometric approximation. Explicit noncircular J
is retained as the declared torsional property.

Uncalibrated standard catalog names cannot override numerical geometry. Templates
use explicit H×B×tw×tf dimensions, not the former inconsistent H catalog table.
Rolled profiles with fillets and other unverified geometry/property combinations
remain rejected until a reviewed mapping is provided.

Planar principal rotations 0/90/180/270 degrees are supported by consistently
swapping Iy/Iz in assembly, recovery and checking. General 2D rotations still need
a compatible 3D model. Weak-axis H-section shear is not synthesized from the
strong-axis web rule; the relevant reviewed shear data must be supplied.

## Real result consumption

Checks consume simultaneous signed station vectors tied to the run and model.
Demand/capacity outputs include their actual units (N, N·mm, MPa or mm), rather
than displaying a normalized ratio as if it were a physical quantity.

Service deflection is the transverse recovered displacement relative to the
straight chord between the physical member ends. Rigid translation and equal
support settlement are excluded. The output explicitly labels its maximum as
sampled member recovery; it is not a continuous extremum proof or a new cracked,
creep or nonlinear RC stiffness model. Only an explicitly selected service case
supplies deflection and service moment. Missing data remains `input_required`.

Solid sections do not receive thin-plate local buckling checks. Zero reinforcement
spacing is a real inequality failure with measured and minimum values; it no
longer fabricates utilization 99. Full RC eccentric-compression capacity and
unverified biaxial/torsional interactions retain their explicit unsupported scope.

## Reproducible checks

`backend/tests/engineering-code-check-acceptance.mjs` performs ten native OpenSees
runs through the real analysis service and code-check worker. Its independent
references are fixed in the script before invoking the implementation:

- Steel beam stress and relative deflection: pass, fail and missing design strength.
- Steel axial column stability: pass, fail and missing stability coefficient.
- RC rectangular beam flexural capacity: pass, fail and missing reinforcement area.
- Common 20 mm support settlement, and principal 90-degree section rotation.
- Run provenance and demand/capacity units throughout the bridge.

The native tolerance is absolute 1e-8 plus relative 1e-8. Separate Python tests
verify explicit-G 3D torsion and equivalent 2D/3D principal-axis rotations.
Neither mocks nor these elastic examples substitute for commercial native
acceptance, all engineering combinations, or complete normative coverage.

Run from the repository root after `npm --prefix backend run build`:

```powershell
$env:SCLAW_DATA_DIR = 'G:/StructureClaw-All/sclaw_data'
node backend/tests/engineering-code-check-acceptance.mjs
```

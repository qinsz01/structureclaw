# Detached House Workflow Guidance

DETACHED_HOUSE_WORKFLOW_GUIDANCE

Use the detached-house tools as a stateful design chain. Each tool reads and updates the `designBasis` artifact; do not pass the full design JSON unless the tool schema explicitly asks for it.

Call at most one state-mutating detached_house_* tool in one assistant response. Wait for its result, inspect the updated design state, then decide the next tool call. This is especially important for per-floor tools because they update the same `designBasis` artifact.

## Order

1. Create or reuse `designBasis`: `detached_house_create_design_basis`.
2. Classify roles: `detached_house_classify_floor_roles`.
3. Generate rooms one floor at a time with `detached_house_generate_floor_rooms`.
   - Respect explicit user priority. If the user says to start with the first floor, generate the first floor first.
   - Otherwise choose the floor that best anchors repeated stair and wet zones, then continue floor by floor.
   - Upper residential floors should normally contain bedrooms, bathrooms, family/study spaces, and circulation; do not add ground-floor public program there unless requested.
4. After a reliable anchor layout exists, call `detached_house_derive_global_constraints_from_layout`.
5. Use `detached_house_propagate_floor_rooms` only for floors that are genuinely similar to a reference floor. Use `detached_house_generate_floor_rooms` for ground-public floors, setback floors, roof/terrace levels, or floors with different requirements.
6. Generate walls, doors/windows, and beams per floor, waiting for each floor result before calling the next floor.
7. Typical downstream sequence: `detached_house_generate_floor_walls` per floor -> `detached_house_reconcile_global_constraints` -> `detached_house_generate_column_grid` -> `detached_house_place_doors_windows` per floor -> `detached_house_generate_beam_layout` per floor -> `detached_house_size_members` -> `detached_house_validate_residential_design`.
8. For structural analysis, call `detached_house_build_analysis_model`, then `validate_model` and `run_analysis`.

## Generate vs Propagate

Propagate when the target floor has the same role family, compatible outline, and explicit `reference_floor_id`, or when the user asks for similar repeated floors. Generate when the floor role changes, the outline has setbacks or terraces, the floor is the ground/public level, or the user gives different requirements.

## Design Priorities

Keep stair cores aligned across floors, stack wet/service zones where possible, preserve clear circulation from entry to stair, keep bedrooms private, and maintain regular structural spacing. Treat these as design guidance, not rigid geometry rules; if user instructions conflict, follow the user and surface the tradeoff.

# Detached House Design Intent

Use this skill when the user wants a detached house, single-family house, standalone residence, villa, or similar low-rise residential building design. The user may provide only text, or text plus drawings/outline geometry.

If no detached-house `designBasis` artifact exists, start by calling `detached_house_create_design_basis` with the original user intent and any parsed drawing or outline data. If a detached-house `designBasis` already exists, continue from the artifact state instead of recreating it unless the user asks to restart.

Do not use the traditional `build_model` flow for detached-house API output. When the user wants structural analysis, call `detached_house_build_analysis_model` first, then use the normal validation and analysis tools.

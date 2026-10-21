# Skill and provider runtime status

The eight selectable skills are structure modelling methods: beam, column, double-span-beam,
frame, concrete-frame, portal-frame, truss and generic. Each has a manifest, stage guidance and
handler in backend/src/agent-skills/structure-type/. Automatic LLM routing is the default.

Provider metadata is separate in backend/src/providers/catalog.yaml. The catalog currently has
six solver modes (OpenSees static/dynamic/seismic/nonlinear, PKPM static, YJK static), four design
codes (GB50010/GB50011/GB50017/JGJ3), four input parsers (DXF, tabular, image, PDF), and two report
exporters (built-in and PKPM calculation book). Existing execution files remain in their domain
paths. GET /api/v1/agent/providers reports installed/configured status and explicit enables.
Commercial licence status remains unknown until a real job proves it.

Shared guidance for loads, supports, combinations, input interpretation, validation and results
lives in engineering/knowledge.ts and follows the knowledge run-policy switch. These topics,
validation, post-processing and visualization are no longer selectable skills. Memory and shell
remain tools; the duplicate skill-creation and section placeholder handlers are removed. The
section-common polygon integration is retained in shared structure_protocol/section_properties.py
with numerical tests. Approximate bridge/irregular placeholders are not retained.

The legacy domain enum and analysisSkillId/codeCheckSkillId API field names remain compatible.
Saved provider ids become provider preferences; text-only and removed ids become logged no-ops.
Neither requires selecting a solver or a code as a modelling skill.

Update this status together with the catalog and both architecture documents whenever providers
or structure skills change. Environment readiness and implemented physical scope are separate
claims; a configured provider does not imply every requested analysis is supported.

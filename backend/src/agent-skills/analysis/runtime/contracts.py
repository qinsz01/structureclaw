from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from typing_extensions import TypedDict


class AnalysisResultMeta(TypedDict, total=False):
    engineId: str
    engineName: str
    engineVersion: str
    engineKind: str
    selectionMode: str
    fallbackFrom: Optional[str]
    analysisSkillId: str
    analysisSkillIds: List[str]
    analysisAdapterKey: str
    analysisType: str
    elapsedMs: float


class AnalysisResult(TypedDict, total=False):
    """Return type for all run_analysis() implementations.

    status="success"  → detailed contains computed results; warnings may be non-empty.
    status="partial"  → computation completed with degraded fidelity; warnings explain why.

    Failures must raise RuntimeError (or EngineNotAvailableError), NOT return
    a result dict. The selected engine's failure is preserved without substitution.
    """

    status: Literal["success", "partial"]
    summary: Dict[str, Any]
    detailed: Dict[str, Any]
    warnings: List[str]
    meta: AnalysisResultMeta


class EngineNotAvailableError(RuntimeError):
    """Raised when an engine cannot be used (not installed, licence expired, etc.).

    The error propagates to the API layer as a failure of the selected engine.
    """

    error_code = "ENGINE_UNAVAILABLE"

    def __init__(self, engine: str, reason: str) -> None:
        self.engine = engine
        self.reason = reason
        super().__init__(f"Engine '{engine}' unavailable: {reason}")


class AnalysisCapabilityError(RuntimeError):
    """Raised when an engine cannot represent or execute a valid requested input."""

    error_code = "ENGINE_INPUT_UNSUPPORTED"

    def __init__(self, engine: str, capability: str, reason: str) -> None:
        self.engine = engine
        self.capability = capability
        self.reason = reason
        self.meta = {
            "failureKind": "capability-boundary",
            "engine": engine,
            "capability": capability,
        }
        self.detail = {
            "engine": engine,
            "capability": capability,
            "reason": reason,
        }
        super().__init__(reason)


# ---------------------------------------------------------------------------
# Protocol contract — documentation only, NOT an ABC
# ---------------------------------------------------------------------------
# Every analysis skill runtime.py MUST expose:
#
#   def run_analysis(model, parameters: Dict[str, Any]) -> AnalysisResult
#
# Execution lifecycle enforced by registry.py:
#   1. registry selects engine → finds matching skill → imports runtime.py
#   2. calls run_analysis(model, parameters)
#   3. SUCCESS  → return AnalysisResult(status="success", summary=..., detailed=...)
#   4. FAILURE  → raise RuntimeError  (do NOT return an error dict)
#   5. ENGINE UNAVAILABLE → raise EngineNotAvailableError
#   6. registry preserves the selected engine's failure without substitution
#
# Result collection:
#   registry._run_python_analysis() injects "meta" into the returned dict.
#   Skill run_analysis() must NOT set meta; it is owned by the registry.

"""Typed input failures; solver convergence failures remain execution errors."""


class OpenSeesInputError(ValueError):
    error_code = "ANALYSIS_INPUT_INVALID"


class OpenSeesMissingInputError(OpenSeesInputError):
    error_code = "ANALYSIS_INPUT_REQUIRED"


class OpenSeesCapabilityError(OpenSeesInputError):
    error_code = "ENGINE_INPUT_UNSUPPORTED"

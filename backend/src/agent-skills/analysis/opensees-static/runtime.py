from __future__ import annotations

from opensees_static_analysis import OpenSeesStaticExecutor
from opensees_static_loads import StaticLoadContext
from opensees_shared.tags import OpenSeesTagMapper


class OpenSeesStaticAnalyzer(StaticLoadContext, OpenSeesTagMapper):
    def __init__(self, model):
        StaticLoadContext.__init__(self, model)
        OpenSeesTagMapper.__init__(self, model)


def run_analysis(model, parameters):
    try:
        import openseespy.opensees as ops
    except Exception as error:
        from contracts import EngineNotAvailableError
        raise EngineNotAvailableError('builtin-opensees', f'OpenSeesPy is not available: {error}') from error
    return OpenSeesStaticExecutor(OpenSeesStaticAnalyzer(model)).run(parameters)

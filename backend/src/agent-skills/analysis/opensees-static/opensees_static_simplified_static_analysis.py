"""Compatibility import for the load context; numerical solving delegates to OpenSees."""
from opensees_static_loads import StaticLoadContext


class StaticAnalyzer(StaticLoadContext):
    def run(self, parameters):
        from opensees_static_analysis import OpenSeesStaticExecutor
        return OpenSeesStaticExecutor(self).run(parameters)

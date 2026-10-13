import copy
import importlib.util
import sys
import unittest
from pathlib import Path

ADAPTER = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ADAPTER), str(ADAPTER.parent / 'runtime')]
spec = importlib.util.spec_from_file_location('yjk_selection_runtime', ADAPTER / 'runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class SelectionTests(unittest.TestCase):
    def payload(self):
        context = dict(engine='yjk', engineVersion='test', physicalModelHash='model',
                       stiffnessHash='stiffness', settingsHash='settings', linearStatic=True,
                       effectiveSettingsVerified=True, stationConventionsVerified=True)
        def case(value):
            return dict(status='success', forceSemantics='simultaneous-signed-stations',
                nativeContext=copy.deepcopy(context),
                units=dict(displacement='m', rotation='rad', force='kN', moment='kN.m'),
                displacements={'n': dict(ux=value, uy=0, uz=0, rx=0, ry=0, rz=0)},
                reactions={'b': dict(fx=-value, fy=0, fz=0, mx=0, my=0, mz=0, R=abs(value))},
                forces={'e': {'N': value}},
                memberStations={'e': [dict(positionM=0, side='right', referenceFrame='element-local',
                    components=dict(N=value, Vy=0, Vz=0, T=0, My=0, Mz=0))]})
        return {'caseResults': {'D': case(2), 'D_eq': case(-1)}, 'summary': {'maxDisplacement': 99}}

    def test_named_selection_does_not_use_other_dead_case_or_across_case_envelope(self):
        original = self.payload()
        result = runtime._select_verified_results(original, ['D_eq'], None)
        self.assertEqual(result['displacements']['n']['ux'], -1)
        self.assertEqual(result['summary']['maxDisplacement'], 1)
        self.assertEqual(set(result['caseResults']), {'D', 'D_eq'})
        self.assertEqual(original['summary']['maxDisplacement'], 99)

    def test_signed_combination_preserves_cases_and_recomputes_vector_norm(self):
        result = runtime._select_verified_results(self.payload(), ['D', 'D_eq'],
                                                  {'id': 'C', 'factors': {'D': 1, 'D_eq': 2}})
        self.assertEqual(result['displacements']['n']['ux'], 0)
        self.assertEqual(result['reactions']['b']['R'], 0)
        self.assertEqual(result['forces']['e']['N'], 0)
        self.assertEqual(result['selectedResult'], {'kind': 'combination', 'id': 'C'})

    def test_unverified_context_or_missing_case_rejected(self):
        result = self.payload()
        result['caseResults']['D']['nativeContext']['effectiveSettingsVerified'] = False
        with self.assertRaises(Exception):
            runtime._select_verified_results(result, ['D'], None)
        with self.assertRaises(ValueError):
            runtime._select_verified_results(result, ['unknown'], None)

    def test_native_automatic_design_envelope_cannot_become_selected_case_utilization(self):
        payload = self.payload()
        payload.update(designResults={'native': 'automatic design'}, utilizationByElement={'e': {'ratio': 99}})
        payload['summary'].update(maxDesignUtilization=99, controllingDesignElement='e')
        result = runtime._select_verified_results(payload, ['D'], None)
        self.assertNotIn('utilizationByElement', result)
        self.assertNotIn('maxDesignUtilization', result['summary'])
        self.assertFalse(result['nativeDesignResults']['boundToSelectedResult'])

    def test_selection_rejects_unknown_or_duplicate_id_before_launch(self):
        model = {'load_cases': [{'id': 'D'}, {'id': 'D_eq'}],
                 'load_combinations': [{'id': 'C', 'factors': {'D': 1, 'D_eq': -1}}]}
        self.assertEqual(runtime._result_selection(model, {'loadCombinationId': 'C'})[0], ['D', 'D_eq'])
        for parameters in ({'loadCaseIds': ['DL']}, {'loadCaseIds': ['D', 'D']},
                           {'loadCaseIds': []}, {'loadCombinationId': 'missing'},
                           {'loadCaseIds': ['D'], 'loadCombinationId': 'C'}):
            with self.subTest(parameters=parameters), self.assertRaises(ValueError):
                runtime._result_selection(model, parameters)


if __name__ == '__main__':
    unittest.main()

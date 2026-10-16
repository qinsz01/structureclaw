// Compatibility re-export: the structure-protocol worker client lives in
// skill-shared/structure-protocol-execution.ts. Tests, scripts/cli/convert-batch.js and
// tests/regression/backend-validations.js import dist/services/structure-protocol-execution.js.
export * from '../skill-shared/structure-protocol-execution.js';

import { PythonWorkerRunner, resolveWorkerPath } from '../../utils/python-worker-runner.js';
import type { AnalysisExecutionInput, ExecutionRequestOptions } from './types.js';

export class AnalysisRuntimeRunner {
  private readonly runner = new PythonWorkerRunner<AnalysisExecutionInput>(
    resolveWorkerPath('agent-skills/analysis/runtime/worker.py'),
  );

  async invoke<T = unknown>(input: AnalysisExecutionInput, requestOptions?: ExecutionRequestOptions): Promise<T> {
    return this.runner.invoke<T>(input, requestOptions);
  }
}

// Exercise process loss on either side of the immutable analysis archive write.
import path from 'node:path';
import { AnalysisExecutionService } from '../../dist/services/analysis-execution.js';
import { runtimeBaseDir } from '../../dist/config/index.js';
import { writeAtomicJson } from '../../dist/engineering/atomic-json.js';
import { saveAnalysisRun } from '../../dist/engineering/analysis-runs.js';
import { readFile } from 'node:fs/promises';

const [inputFile, mode] = process.argv.slice(2);
const input = JSON.parse(await readFile(inputFile, 'utf8'));
const service = new AnalysisExecutionService({ invoke: async () => ({ success: true, data: { marker: 'completed-once' } }) },
  async (id, record) => {
    if (mode === 'before-archive') process.exit(75);
    if (mode === 'after-compressed-archive') await saveAnalysisRun(id, record);
    else writeAtomicJson(path.join(runtimeBaseDir, 'runs', id, 'run.json'), record);
    process.exit(76);
  });
await service.analyze(input);
throw new Error('The fixture must stop before request publication');

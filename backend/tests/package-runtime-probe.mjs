// Run against the installed tarball, from an unrelated working directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { model as raw, reference } from './fixtures/cantilever-reference.mjs';

const installed = path.resolve(process.argv[2]);
const baseUrl = process.argv[3];
const load = relative => import(pathToFileURL(path.join(installed, 'dist/backend', relative)).href);
const requireInstalled = createRequire(path.join(installed, 'package.json'));
const { AgentSkillLoader } = await load('agent-runtime/loader.js');
const loader = new AgentSkillLoader();
const plugins = await loader.loadPlugins();
assert.ok(plugins.some(plugin => plugin.id === 'beam' && plugin.handler));
assert.ok(loader.loadBundles().some(bundle => bundle.id === 'frame'));
const { resolveWorkerPath } = await load('utils/python-worker-runner.js');
assert.ok(resolveWorkerPath('agent-skills/analysis/runtime/worker.py').startsWith(installed));
const { analyzeUploadedFile } = await load('agent-langgraph/file-tools.js');
const workspace = process.cwd();
fs.writeFileSync(path.join(workspace, 'loads.csv'), 'id,value\n"load,one",500\n');
const csv = await analyzeUploadedFile('loads.csv', workspace);
assert.equal(csv.error, undefined, JSON.stringify(csv));
assert.ok(JSON.stringify(csv).includes('load,one'));
const XLSX = requireInstalled('xlsx');
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['node', 'force'], ['N1', 500]]), 'Loads');
XLSX.writeFile(book, path.join(workspace, 'loads.xlsx'));
const excel = await analyzeUploadedFile('loads.xlsx', workspace);
assert.equal(excel.error, undefined, JSON.stringify(excel));
assert.ok(JSON.stringify(excel).includes('N1'));
// A minimal independent PDF exercises PDF.js and the installed rendering backend.
let pdf = '%PDF-1.4\n';
const positions = [0];
const content = 'BT /F1 12 Tf 20 80 Td (Package parser 500 N) Tj ET';
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 250 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
for (let i = 0; i < objects.length; i++) { positions.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${positions.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
fs.writeFileSync(path.join(workspace, 'input.pdf'), pdf);
const parsedPdf = await analyzeUploadedFile('input.pdf', workspace, undefined, { includeImageData: true });
assert.equal(parsedPdf.error, undefined, JSON.stringify(parsedPdf));
assert.ok(JSON.stringify(parsedPdf).includes('500 N'));
const { normalizeEngineeringModel } = await load('engineering/model-boundary.js');
const { createLocalStructureProtocolClient } = await load('services/structure-protocol-execution.js');
const model = await normalizeEngineeringModel(raw, createLocalStructureProtocolClient());
const response = await fetch(`${baseUrl}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'static', engineId: 'builtin-opensees', model, parameters: {} }) });
const run = await response.json();
assert.equal(response.status, 200, JSON.stringify(run));
assert.equal(run.success, true, JSON.stringify(run));
const { createQueryResultsTool } = await load('agent-langgraph/model-tools.js');
for (const q of reference.quantities) {
  const input = { runId: run.runId, resultKey: `${q.selection.kind}:${q.selection.id}`, quantityId: q.id, component: q.component, unit: q.unit,
    ...(q.location.kind === 'member' ? { elementId: q.location.id, positionM: q.location.positionM, side: q.location.side }
      : { nodeId: q.location.id, field: q.component.startsWith('u') || q.component.startsWith('r') ? 'displacements' : 'reactions' }) };
  const queried = await createQueryResultsTool().invoke(input, { toolCall: { id: q.id }, configurable: { agentState: {} } });
  const actual = Object.values(queried.update.resultQuantities)[0].value;
  assert.ok(Number.isFinite(actual) && Math.abs(actual - q.value) <= q.tolerance.absolute + q.tolerance.relative * Math.abs(q.value), `${q.id}: ${actual}`);
}
console.log(JSON.stringify({ status: 'passed', installed, plugins: plugins.length, parsers: ['CSV', 'Excel', 'PDF text and rendering'],
  runId: run.runId, independentQuantities: reference.quantities.length, cwd: workspace }));

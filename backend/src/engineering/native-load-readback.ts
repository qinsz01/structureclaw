import { isRecord, type ModelRecord } from './model-state.js';
import type { Vec } from '../skill-shared/member-response.js';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const fail = (): never => { throw new Error('NATIVE_EXECUTED_LOAD_UNVERIFIED'); };

/** Audit the input serialization, never estimate a load from solver forces. */
export function pkpmExecutedUniformLoad(context: ModelRecord, caseId: string, sourceIndex: number,
  memberId: string, length: number, interval: [number, number], authored: Vec): Vec | undefined {
  const offsets = isRecord(context.effectiveRigidOffsets) ? context.effectiveRigidOffsets : {};
  const compilation = isRecord(offsets.loadCompilation) ? offsets.loadCompilation : {};
  if (context.engine !== 'pkpm' || compilation.elementLoads === undefined) return undefined;
  if (offsets.verified !== true || offsets.sourceLoadSemanticsPreserved !== true
    || compilation.sourceFeaSha256 !== offsets.sourceFeaSha256 || !digest(offsets.sourceFeaSha256)
    || compilation.executionReadbackMethod !== 'native-text-and-binary-load-record-readback'
    || !Array.isArray(compilation.elementLoads)) return fail();
  const matches = compilation.elementLoads.filter(row => isRecord(row) && row.loadCaseId === caseId && row.sourceLoadIndex === sourceIndex);
  if (matches.length !== 1) return fail();
  const row = matches[0] as ModelRecord;
  const vector = (value: unknown, expected: number[]) => Array.isArray(value) && value.length === expected.length
    && value.every((item, index) => finite(item) && item === expected[index]);
  if (row.elementId !== memberId || !vector(row.sourceIntervalM, [0,length])
    || !vector(row.sourceIntensityVectorKnM, authored) || !vector(row.elasticIntervalM, interval)
    || authored[0] !== 0 || authored[1] !== 0 || !isRecord(row.nativeWireReadback)) return fail();
  const readback = row.nativeWireReadback, sdk = readback.sdkValues, input = readback.inputValues;
  const [start, end] = interval, net = end-start;
  if (!(start >= 0 && end <= length && net > 0) || !Array.isArray(sdk) || sdk.length !== 6 || !sdk.every(finite)
    || sdk[0] !== 1 || sdk.slice(2).some(value => value !== 0)
    || sdk[1] !== Math.fround(-authored[2]*(length-start-(length-end))/length)
    || readback.quantization !== 'SDK-float32 -> native-text-six-significant-digits -> solver-float32'
    || !Array.isArray(input) || ![9,10].includes(input.length) || !input.every(finite)
    || !Number.isInteger(readback.nativeFloor) || Number(readback.nativeFloor) < 1
    || !Number.isInteger(readback.nativeOrdinal) || Number(readback.nativeOrdinal) < 1
    || input[0] !== readback.nativeOrdinal || input[1] !== 2 || input[5] !== 0
    || input[6] !== Math.fround(length) || input[7] !== 31 || input[8] !== input[0]
    || !Number.isInteger(readback.byteOffset) || Number(readback.byteOffset) < 0 || Number(readback.byteOffset)%4
    || !isRecord(readback.files) || readback.files['DATA.SAT'] !== offsets.sourceFeaSha256
    || !digest(readback.files['spas_sat.txt']) || !['DATA.SAT','LoadZDY.SAT'].includes(String(readback.file))
    || !digest(readback.files[String(readback.file)])) return fail();
  if (readback.file === 'DATA.SAT'
    ? input.length !== 9 || ![0,9999].includes(input[2]) || readback.nativeCaseId !== (input[2] === 0 ? 1 : 2)
    : input.length !== 10 || input[2] !== 9999 || input[9] !== readback.nativeCaseId || input[9] < 201) return fail();
  if (typeof readback.intensityToken !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(readback.intensityToken)
    || typeof readback.sourceText !== 'string') return fail();
  const token = Number(readback.intensityToken), text = readback.sourceText.split(',').map(Number);
  if (!finite(token) || text.length !== 27 || !text.every(finite) || text[0] !== readback.nativeCaseId || text[1] !== 5
    || text[5] !== token || text[11] !== token || text.slice(2,24).some((value,i) => ![3,9].includes(i) && value !== 0)) return fail();
  // A six-significant-digit native token must lie on its decimal grid and
  // be rounded from the saved SDK float. Both tie directions are valid at an exact half.
  const step = sdk[1] === 0 ? 1 : 10**(Math.floor(Math.log10(Math.abs(sdk[1])))-5);
  const epsilon = 8*Number.EPSILON*Math.max(Math.abs(token),Math.abs(sdk[1]),step);
  if (Math.abs(token-sdk[1]) > step/2+epsilon || Math.abs(token/step-Math.round(token/step)) > 1e-8
    || input[3] !== Math.fround(-token) || input[4] !== input[3] || readback.globalZIntensityKnM !== input[3]) return fail();
  const executed: Vec = [0,0,input[3]*length/net];
  if (!vector(row.effectiveElasticIntensityVectorKnM, executed)) return fail();
  return executed;
}

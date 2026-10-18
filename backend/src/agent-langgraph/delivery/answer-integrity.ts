/**
 * Pragmatic integrity checks for a final answer (pure functions, no state access).
 *
 * Numbers: values written with an engineering unit are compared with the numbers available as
 * evidence (tool results, saved results, the model/draft and the user's own messages), with unit
 * conversion to the scales stored by tools (kN/N, kN·m/N·m, mm/m, MPa/Pa ...), sign ignored and a tolerance
 * that follows the written precision. Deliberately conservative: unitless numbers (counts, IDs,
 * ratios) are never checked, a sentence that cites a design code table/clause is skipped, and a
 * value shown as the result of a written formula ("L/250 = 24 mm") is skipped.
 *
 * Action claims: narrow, documented text patterns for "a report was generated", "the analysis
 * was run" and "the checks passed". Negated or conditional phrasing is ignored. The caller
 * decides whether a claim is supported from structured state (answer-review.ts).
 */

export type UnitFamily = 'force' | 'moment' | 'length' | 'stress' | 'lineLoad' | 'rotation' | 'frequency';

export interface UnitNumber { raw: string; value: number; unit: string; family: UnitFamily; scale: number; decimals: number; index: number; length: number }

interface UnitDefinition { pattern: string; family: UnitFamily; scale: number }

const SEP = '[·•⋅*.\\-]?';
/** Exponents: m²/mm³/cm⁴ are areas, volumes and second moments, not lengths or line loads. */
const POWER = '²³⁴⁵⁶0-9^';
/** Longest alternatives first; scale converts the unit to the family's base unit. */
const UNITS: UnitDefinition[] = [
  { pattern: `千牛${SEP}米`, family: 'moment', scale: 1e3 },
  { pattern: `kN${SEP}mm`, family: 'moment', scale: 1 },
  { pattern: `kN${SEP}m(?![m${POWER}/])`, family: 'moment', scale: 1e3 },
  { pattern: `N${SEP}mm(?![${POWER}])`, family: 'moment', scale: 1e-3 },
  { pattern: `N${SEP}m(?![m${POWER}/])`, family: 'moment', scale: 1 },
  { pattern: 'kN/m(?:²|2|\\^2)', family: 'stress', scale: 1e3 },
  { pattern: `kN/m(?![m${POWER}])`, family: 'lineLoad', scale: 1e3 },
  { pattern: 'N/mm(?:²|2|\\^2)', family: 'stress', scale: 1e6 },
  { pattern: `N/mm(?![${POWER}])`, family: 'lineLoad', scale: 1e3 },
  { pattern: `N/m(?![m${POWER}])`, family: 'lineLoad', scale: 1 },
  { pattern: 'GPa', family: 'stress', scale: 1e9 },
  { pattern: 'MPa', family: 'stress', scale: 1e6 },
  { pattern: '兆帕', family: 'stress', scale: 1e6 },
  { pattern: 'kPa', family: 'stress', scale: 1e3 },
  { pattern: 'Pa', family: 'stress', scale: 1 },
  { pattern: 'MN(?![/·•⋅*])', family: 'force', scale: 1e6 },
  { pattern: 'kN(?![/·•⋅*])', family: 'force', scale: 1e3 },
  { pattern: '千牛(?![/·•⋅*])', family: 'force', scale: 1e3 },
  { pattern: 'N(?![/·•⋅*])', family: 'force', scale: 1 },
  { pattern: 'mrad', family: 'rotation', scale: 1e-3 },
  { pattern: 'rad', family: 'rotation', scale: 1 },
  { pattern: `mm(?![${POWER}])`, family: 'length', scale: 1e-3 },
  { pattern: '毫米', family: 'length', scale: 1e-3 },
  { pattern: `cm(?![${POWER}])`, family: 'length', scale: 1e-2 },
  { pattern: '厘米', family: 'length', scale: 1e-2 },
  { pattern: `m(?![m${POWER}/])`, family: 'length', scale: 1 },
  { pattern: '米(?![²2³3])', family: 'length', scale: 1 },
  { pattern: 'Hz', family: 'frequency', scale: 1 },
];

const NUMBER = '[-−]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:[eE][-+]?\\d+)?';
const CLAIM = new RegExp(`(?<![A-Za-z_\\d.])(${NUMBER})\\s*(${UNITS.map(unit => unit.pattern).join('|')})(?![A-Za-z])`, 'g');
const UNIT_MATCHERS = UNITS.map(unit => ({ ...unit, regex: new RegExp(`^(?:${unit.pattern})$`) }));

function parseNumber(raw: string): number {
  return Number(raw.replace(/,/g, '').replace('−', '-'));
}

/** Numbers followed by an engineering unit, in text order. */
export function extractUnitNumbers(text: string): UnitNumber[] {
  const claims: UnitNumber[] = [];
  for (const match of text.matchAll(CLAIM)) {
    const [, raw, unit] = match as unknown as [string, string, string];
    const definition = UNIT_MATCHERS.find(item => item.regex.test(unit));
    const value = parseNumber(raw);
    if (!definition || !Number.isFinite(value)) continue;
    const decimals = /\.(\d+)/.exec(raw.replace(/[eE].*$/, ''))?.[1]?.length ?? 0;
    claims.push({ raw: `${raw} ${unit}`, value, unit, family: definition.family, scale: definition.scale, decimals, index: match.index ?? 0, length: match[0].length });
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const VOLATILE_TEXT = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, // ISO timestamps
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, // UUIDs
  /\b[0-9a-f]{12,}\b/gi, // hashes
];
const VOLATILE_KEY = /^(id|at|ts)$|Id$|Ids$|hash|Hash|time|Time|path|Path|version|Version|token|Token|url|Url|^trace/;
const EVIDENCE_NUMBER = /\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

function addText(text: string, into: number[]): void {
  let cleaned = text;
  for (const pattern of VOLATILE_TEXT) cleaned = cleaned.replace(pattern, ' ');
  for (const match of cleaned.replace(/(\d),(\d{3})/g, '$1$2').matchAll(EVIDENCE_NUMBER)) {
    const value = Number(match[0]);
    if (Number.isFinite(value)) into.push(Math.abs(value));
  }
}

function addValue(value: unknown, into: number[], key = ''): void {
  if (typeof value === 'number') { if (Number.isFinite(value)) into.push(Math.abs(value)); return; }
  if (typeof value === 'string') {
    if (VOLATILE_KEY.test(key)) return;
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
      try { addValue(JSON.parse(trimmed), into); return; } catch { /* plain text */ }
    }
    addText(value, into);
    return;
  }
  if (Array.isArray(value)) { for (const item of value) addValue(item, into, key); return; }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) addValue(child, into, childKey);
  }
}

const MAX_INPUT_NUMBERS = 16;

/**
 * Simple quantities the answer may derive from the user's own inputs without a tool: products of
 * two or three input numbers (total load q·L, 2 × 6 × 10) and quotients of two (P/2, L/n).
 */
export function derivedInputNumbers(texts: string[]): number[] {
  const values: number[] = [];
  for (const text of texts) addText(text, values);
  const inputs = [...new Set(values.filter(value => value > 0))].slice(0, MAX_INPUT_NUMBERS);
  const derived: number[] = [];
  inputs.forEach((a, i) => inputs.forEach((b, j) => {
    if (i === j) return;
    derived.push(a / b);
    if (j > i) {
      derived.push(a * b);
      for (let k = j + 1; k < inputs.length; k += 1) derived.push(a * b * inputs[k]!);
    }
  }));
  return derived;
}

const MAX_QUANTITIES = 30;

/** Sums of two, three and all saved quantity values: equilibrium totals such as ΣR = 120 kN. */
export function quantitySums(values: number[]): number[] {
  const items = values.filter(Number.isFinite).map(Math.abs).slice(0, MAX_QUANTITIES);
  const sums: number[] = items.length > 1 ? [items.reduce((total, value) => total + value, 0)] : [];
  items.forEach((a, i) => items.forEach((b, j) => {
    if (j <= i) return;
    sums.push(a + b);
    for (let k = j + 1; k < items.length; k += 1) sums.push(a + b + items[k]!);
  }));
  return sums;
}

/** Sorted absolute values of every number in the evidence (JSON values, JSON strings or text). */
export function buildEvidence(sources: unknown[]): Float64Array {
  const values: number[] = [];
  for (const source of sources) addValue(source, values);
  return Float64Array.from(values).sort();
}

function hasValueWithin(evidence: Float64Array, low: number, high: number): boolean {
  let left = 0, right = evidence.length;
  while (left < right) {
    const middle = (left + right) >> 1;
    if (evidence[middle]! < low) left = middle + 1; else right = middle;
  }
  return left < evidence.length && evidence[left]! <= high;
}

/**
 * Unit scales in which tool results and saved state store values (kN/N, kN·m/N·m/N·mm, m/mm,
 * MPa/kPa/Pa, kN/m/N/m). A written value is also compared after conversion to each of them;
 * rarely used scales (cm, MN, GPa) are not tried, which would only add chance matches.
 */
const EVIDENCE_SCALES: Record<UnitFamily, number[]> = {
  force: [1e3, 1], moment: [1e3, 1, 1e-3], length: [1, 1e-3], stress: [1e6, 1e3, 1], lineLoad: [1e3, 1],
  rotation: [1, 1e-3], frequency: [1],
};

/** Written precision (half a unit in the last digit) or 1 %, whichever is larger. */
export function isSupported(claim: UnitNumber, evidence: Float64Array): boolean {
  const magnitude = Math.abs(claim.value);
  if (magnitude === 0) return true;
  const tolerance = Math.max(0.51 * 10 ** -claim.decimals, 0.01 * magnitude);
  return EVIDENCE_SCALES[claim.family].some((scale) => {
    const factor = claim.scale / scale;
    return hasValueWithin(evidence, (magnitude - tolerance) * factor * (1 - 1e-12), (magnitude + tolerance) * factor * (1 + 1e-12));
  });
}

const CITATION = /GB\s*\/?\s*T?\s*\d{4,5}|JGJ\s*\/?\s*T?\s*\d+|\bEN\s*199\d|Eurocode|\bAISC\b|\bACI\s*318|\bASCE\s*7|表\s*\d|Table\s*\d|第\s*\d+(?:\.\d+)*\s*条|[Cc]lause\s*\d/;
const SENTENCE_BREAKS = ['。', '！', '？', '!', '?', '；', ';', '\n', '. '];

function sentenceAround(text: string, index: number): string {
  const start = Math.max(...SENTENCE_BREAKS.map(mark => text.lastIndexOf(mark, index - 1))) + 1;
  const ends = SENTENCE_BREAKS.map(mark => text.indexOf(mark, index)).filter(position => position >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) : text.length);
}

/** "L/250 = 24 mm", "15×10⁶ / 478×10³ ≈ 31 MPa", "L/250 (24 mm)": the derivation precedes the value. */
const DERIVED_BEFORE = /[/×*÷+−-][^=＝≈，,;；。\n]{0,24}[=＝≈]\s*[≈约]?\s*$|[A-Za-zδΔ]\s*[/／]\s*\d+(?:\.\d+)?\s*[（(]\s*[≈约]?\s*$/;
/** "120 kN = 10 kN/m × 12 m": the derivation follows the value ("/" alone is a unit, not an operator). */
const DERIVED_AFTER = /^\s*[=＝≈]\s*[^=＝，,;；。\n]{0,30}?[×*÷+]/;

function isShownDerivation(answer: string, claim: UnitNumber): boolean {
  const end = claim.index + claim.length;
  return DERIVED_BEFORE.test(answer.slice(Math.max(0, claim.index - 40), claim.index)) || DERIVED_AFTER.test(answer.slice(end, end + 40));
}

/**
 * Values with units that match no evidence, excluding cited code values and shown derivations.
 * A value the answer derives explicitly once ("2×6×10 = 120 kN") is accepted wherever it recurs.
 */
export function findUnsupportedNumbers(answer: string, evidence: Float64Array): UnitNumber[] {
  const claims = extractUnitNumbers(answer);
  const shown = claims.filter(claim => isShownDerivation(answer, claim))
    .map(claim => ({ family: claim.family, base: Math.abs(claim.value) * claim.scale }));
  return claims.filter((claim) => {
    if (isSupported(claim, evidence)) return false;
    if (CITATION.test(sentenceAround(answer, claim.index))) return false;
    const base = Math.abs(claim.value) * claim.scale;
    return !shown.some(item => item.family === claim.family && Math.abs(item.base - base) <= 1e-9 * Math.max(1, base));
  });
}

// ---------------------------------------------------------------------------
// Action claims
// ---------------------------------------------------------------------------

export type ClaimedAction = 'report' | 'analysis' | 'check-passed';

/** Structural analysis kinds only: "需求分析" or a quick analysis of the question is not run_analysis. */
const ZH_ANALYSIS = '(?:结构|静力|模态|动力|内力|受力|有限元|弹性|屈曲|地震|时程|求解)分析';
const EN_ANALYSIS = '(?:structural|static|modal|dynamic|finite[- ]element|FE|linear|nonlinear|buckling|seismic|time[- ]history|OpenSees)\\s+analysis';
/** The report itself, not a summary or outline of it. */
const ZH_REPORT = '报告(?!摘要|概要|要点|大纲)';

const ACTION_PATTERNS: Record<ClaimedAction, RegExp[]> = {
  report: [
    new RegExp(`${ZH_REPORT}(?:已经?|均已)(?:生成|完成|输出|创建|保存)`, 'g'),
    new RegExp(`已经?(?:生成|输出|创建)了?[^。；;\\n]{0,8}${ZH_REPORT}`, 'g'),
    new RegExp(`生成了[^。；;\\n]{0,8}${ZH_REPORT}`, 'g'),
    /\breport\b[^.;\n]{0,40}\b(?:has been|have been|was|is now)\s+(?:generated|created|produced|saved|written)\b/gi,
    /\b(?:I|we)\s+(?:have\s+)?(?:generated|created|produced|written)\s+(?:a|an|the|your)\s+(?:(?!of\b)[\w-]+\s+){0,3}report\b/gi,
  ],
  analysis: [
    new RegExp(`${ZH_ANALYSIS}(?:已经?|均已)(?:完成|运行|执行)`, 'g'),
    new RegExp(`已经?(?:完成|运行|执行|进行)了?${ZH_ANALYSIS}`, 'g'),
    new RegExp(`\\b${EN_ANALYSIS}\\b[^.;\\n]{0,30}\\b(?:has been|was|is now)\\s+(?:run|completed|performed|executed)\\b`, 'gi'),
    new RegExp(`\\b(?:I|we)\\s+(?:have\\s+)?(?:ran|run|completed|performed|executed)\\s+(?:a|an|the)\\s+${EN_ANALYSIS}\\b`, 'gi'),
  ],
  'check-passed': [
    // An equilibrium check ("竖向平衡校核通过") is not a code check.
    /(?<!平衡)(?:验算|校核|复核)(?:结果)?(?:均|全部|都)?(?:已)?(?:通过|合格)/g,
    /\b(?<!equilibrium\s)(?:all\s+)?(?:code\s+|design\s+)?checks?\s+(?:have\s+|has\s+)?passed\b/gi,
    /\bpasse[sd]\s+(?:all\s+|the\s+)?(?:code\s+|design\s+|GB\s*50017\s+)?checks?\b/gi,
  ],
};

/** Negation or condition earlier in the same clause ("不构成“验算合格”的结论", "若验算通过"). */
const ZH_NEGATION = /(未|没|不|无|非|若|如果|如需|是否|能否|待|需|可)[^，,。；;！？!?\n]{0,8}$/;
const ZH_QUESTION_AFTER = /^[”"」』）)]?(与否|吗|么|？|\?)/;
const EN_NEGATION = /\b(not|no|never|if|whether|once|unless|cannot|could|would|will|can|should|may|until)\b[^.;\n]{0,12}$|n't\s*$/i;

/** Affirmative claims of completed actions (negated, conditional and offered actions are ignored). */
export function findActionClaims(answer: string): Array<{ action: ClaimedAction; text: string }> {
  const claims: Array<{ action: ClaimedAction; text: string }> = [];
  for (const [action, patterns] of Object.entries(ACTION_PATTERNS) as Array<[ClaimedAction, RegExp[]]>) {
    const found = patterns.flatMap(pattern => [...answer.matchAll(pattern)]).find((match) => {
      const start = match.index ?? 0;
      const before = answer.slice(Math.max(0, start - 24), start);
      const after = answer.slice(start + match[0].length, start + match[0].length + 4);
      return !ZH_NEGATION.test(before) && !ZH_QUESTION_AFTER.test(after) && !EN_NEGATION.test(before);
    });
    if (found) claims.push({ action, text: found[0] });
  }
  return claims;
}

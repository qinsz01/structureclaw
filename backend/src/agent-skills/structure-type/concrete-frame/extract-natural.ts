import { normalizeNumber } from '../../../agent-runtime/fallback.js';
import type { DraftExtraction, DraftState } from '../../../agent-runtime/types.js';
import {
  normalizeSeismicDesignGroup,
  normalizeSeismicSiteCategory,
  normalizeWindTerrainRoughness,
} from './design-conditions.js';

// Enhanced digit pattern for explicit structural context
// Requires specific leading context to avoid false matches like "其中一层"
const DIGIT_PATTERN = '[零一二三四五六七八九十百千万两廿0-9]+';
const DECIMAL_NUMBER_PATTERN = '[0-9]+(?:\\.[0-9]+)?';

// Leading context that indicates structural description (not casual mention)
// Covers: sentence start, punctuation, or specific aggregate keywords
// NOTE: "有" is excluded because it's ambiguous (e.g., "有一层漏了" ≠ "有1层")
// NOTE: "一共" is kept as it's a clear structural indicator
const STRUCTURAL_LEADING_PATTERN = '(?:^|[，。；！？、\\s]|共|包含|总计|一共|为|总)';

/**
 * Local version of parseChineseNumber with H1 fix:
 * Returns undefined for ambiguous mixed Chinese text like "其中一层", "第一层", "某一层"
 * These are ordinal references, not counts. Only parses if the string starts with a digit.
 */
function parseChineseNumber(text: string): number | undefined {
  const chineseDigits: Record<string, number> = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  };

  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // H1 fix: Return undefined for ambiguous mixed Chinese text like "其中一层", "第一层", "某一层"
  // These are ordinal references, not counts. Only parse if the string starts with a digit.
  if (trimmed.length > 1) {
    const firstChar = trimmed[0];
    // Check if first character is a Chinese digit
    if (chineseDigits[firstChar] !== undefined) {
      // It's a standalone digit at the start, OK to parse
    } else {
      // First char is not a digit - this is likely ordinal like "其中一层" or "第一层"
      // Return undefined to avoid false positives
      return undefined;
    }
  }

  // Handle single character digits (零, 一, 二, 三, etc.)
  if (trimmed.length === 1) {
    const value = chineseDigits[trimmed];
    return value !== undefined ? value : undefined;
  }

  // Handle compound numbers like 二十二, 三层, 十五
  let result = 0;
  let temp = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    const value = chineseDigits[char];

    if (value === undefined) {
      // Skip non-Chinese-numeral characters (like "层", "楼", etc.)
      continue;
    }

    if (value === 10) {
      // "十" acts as a multiplier for tens place
      if (temp === 0) {
        temp = 10;
      } else {
        result += temp * 10;
        temp = 0;
      }
    } else if (value < 10) {
      // Regular digit
      if (temp >= 10) {
        // Previous was a tens multiplier
        temp = temp + value;
      } else if (temp > 0) {
        // Previous digit exists, multiply and add
        result += temp;
        temp = value;
      } else {
        temp = value;
      }
    }
  }

  result += temp;

  // Handle cases like "十" (10) alone or at the end
  if (trimmed === '十') return 10;

  return result > 0 ? result : undefined;
}

/**
 * Parse a localized number string (Arabic or Chinese).
 * Returns number only if the string is purely numeric.
 */
function parseLocalizedNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  // Try Arabic number first
  const parsed = Number.parseFloat(trimmed);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  // Try Chinese numeral (local version with H1 fix)
  const chinese = parseChineseNumber(trimmed);
  if (chinese !== undefined && chinese > 0) {
    return chinese;
  }
  return undefined;
}

/**
 * Extract a positive integer with structural context validation.
 * Only matches numbers that appear in explicit structural context.
 */
function extractStructuredCount(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const value = parseLocalizedNumber(match[1]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/**
 * Extract a scalar value (allows decimals).
 */
function _extractNaturalScalar(message: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      const value = normalizeNumber(match[1]);
      if (value !== undefined && value > 0) return value;
    }
  }
  return undefined;
}

/**
 * Extract an array of values.
 */
function _extractNaturalArray(message: string, patterns: RegExp[]): number[] | undefined {
  for (const pattern of patterns) {
    const matches = message.matchAll(pattern);
    const values: number[] = [];
    for (const match of matches) {
      const value = normalizeNumber(match[1]);
      if (value !== undefined && value > 0) values.push(value);
    }
    if (values.length > 0) return values;
  }
  return undefined;
}

function extractDirectionalSegment(message: string, axis: 'x' | 'y' | 'z'): string {
  const axisClass = axis === 'x' ? '[xX]' : axis === 'y' ? '[yY]' : '[zZ]';
  const nextAxis = '[xXyYzZ](?:方向|向)';
  const match = message.match(new RegExp(`${axisClass}(?:方向|向)([\\s\\S]*?)(?=${nextAxis}|$)`, 'i'));
  return match?.[1] || '';
}

function extractBayCountFromDirectionalSegment(segment: string): number | undefined {
  return extractStructuredCount(segment, [
    new RegExp(`(${DIGIT_PATTERN})\\s*跨`, 'i'),
    new RegExp(`(${DIGIT_PATTERN})\\s*bays?`, 'i'),
  ]);
}

function extractLabeledSegment(message: string, labelPattern: string, stopPattern: string): string {
  const match = message.match(new RegExp(`${labelPattern}([\\s\\S]*?)(?=${stopPattern}|$)`, 'i'));
  return match?.[1] ?? '';
}

const PLAN_SEGMENT_STOP = '(?:横向|纵向|[xXyYzZ](?:方向|向)|首层|一层|二层|三层|每层|层高|楼面|屋面|恒载|活载|抗震|地震|风荷载|基本风压|混凝土|钢筋|柱|梁)';

function extractWidthValuesWithUnit(segment: string): number[] | undefined {
  const values: number[] = [];
  const pattern = new RegExp(`(${DECIMAL_NUMBER_PATTERN})\\s*(?:m|米)`, 'gi');
  for (const match of segment.matchAll(pattern)) {
    const value = normalizeNumber(match[1]);
    if (value !== undefined && value > 0) values.push(value);
  }
  return values.length ? values : undefined;
}

function extractBayCountFromOpeningSegment(segment: string): number | undefined {
  return extractStructuredCount(segment, [
    new RegExp(`共\\s*(${DIGIT_PATTERN})\\s*(?:间|跨|开间)`, 'i'),
    new RegExp(`(${DIGIT_PATTERN})\\s*(?:间|跨|开间)`, 'i'),
  ]);
}

function extractLongitudinalSegment(message: string): string {
  return extractLabeledSegment(
    message,
    '(?:纵向|[xX](?:方向|向))(?:\\s*(?:开间|跨度|尺寸|轴网|间距|进深))*\\s*',
    PLAN_SEGMENT_STOP,
  );
}

function extractTransverseSegment(message: string): string {
  return extractLabeledSegment(
    message,
    '(?:横向|[yYzZ](?:方向|向))(?:\\s*(?:进深|跨度|尺寸|轴网|间距|开间))*\\s*',
    PLAN_SEGMENT_STOP,
  );
}

function extractLongitudinalBayCount(message: string): number | undefined {
  const segment = extractLongitudinalSegment(message);
  return segment ? extractBayCountFromOpeningSegment(segment) : undefined;
}

function extractLongitudinalBayWidths(message: string, bayCount: number | undefined): number[] | undefined {
  const segment = extractLongitudinalSegment(message);
  const values = segment ? extractWidthValuesWithUnit(segment) : undefined;
  if (!values?.length) return undefined;
  if (values.length === 1 && bayCount !== undefined) {
    return Array(bayCount).fill(values[0]);
  }
  return values;
}

function extractTransverseBayCount(message: string): number | undefined {
  const segment = extractTransverseSegment(message);
  const explicit = segment ? extractBayCountFromOpeningSegment(segment) : undefined;
  if (explicit !== undefined) return explicit;
  return extractTransverseBayWidths(message, undefined)?.length;
}

function extractTransverseBayWidths(message: string, bayCount: number | undefined): number[] | undefined {
  const segment = extractTransverseSegment(message);
  const values = segment ? extractWidthValuesWithUnit(segment) : undefined;
  if (!values?.length) return undefined;
  if (values.length === 1 && bayCount !== undefined) {
    return Array(bayCount).fill(values[0]);
  }
  return values;
}

function extractBayWidthFromDirectionalSegment(segment: string): number[] | undefined {
  return _extractNaturalArray(segment, [
    new RegExp(`(?:每跨|跨度|间隔)(?:都?是|也?是|为|是)?\\s*(${DIGIT_PATTERN}(?:\\.${DIGIT_PATTERN})?)\\s*(?:m|米)`, 'gi'),
    new RegExp(`${DIGIT_PATTERN}\\s*跨\\s*(?:每跨)?\\s*(${DIGIT_PATTERN}(?:\\.${DIGIT_PATTERN})?)\\s*(?:m|米)`, 'gi'),
  ]);
}

/**
 * Extract story count with strict structural context.
 * Avoids false matches like "其中一层需要加固".
 */
function extractStoryCount(message: string): number | undefined {
  // Pattern 1: Explicit keyword followed by number
  const pattern1 = new RegExp(
    `(?:层数|楼层|story\\s*count|story\\s*number|stories?)\\s*[：:]*\\s*(${DIGIT_PATTERN})`,
    'i'
  );
  
  // Pattern 2: Structural leading context before number
  // "共三层", "一共三层", "总三层", "为三层", etc.
  const pattern2 = new RegExp(
    `${STRUCTURAL_LEADING_PATTERN}(${DIGIT_PATTERN})\\s*(?:层|楼|stories?)`,
    'i'
  );
  
  // Pattern 3: "一共有三层" - special case where "有" follows "一共"
  const pattern3 = new RegExp(
    `一共有(${DIGIT_PATTERN})\\s*(?:层|楼)`,
    'i'
  );
  
  // Pattern 4: Number followed by 层 (requires structural context, not ordinal like "第一层")
  // "三层框架", "五层楼" - but NOT "其中一层" or "第一层"
  const pattern4 = new RegExp(
    `(?:^|[，。；！？、\\s])(${DIGIT_PATTERN})\\s*(?:层|楼)(?![个处所项])`,
    'i'
  );

  // Pattern 5: Handle "一个三层", "设计一个三层" patterns
  // This captures "X层" after phrases like "一个", "共", "共计", etc. (not ordinal)
  const pattern5 = new RegExp(
    `(?:一个|共|共计)(${DIGIT_PATTERN})\\s*层(?!\\s*的)`,
    'i'
  );

  return extractStructuredCount(message, [pattern1, pattern2, pattern3, pattern4, pattern5]);
}

/**
 * Extract bay count (跨数) with strict structural context.
 */
function extractBayCount(message: string): number | undefined {
  // First check for explicit "single bay" or "one bay" patterns
  if (/\bsingle\s*bay\b/i.test(message) || /\bone\s*bay\b/i.test(message)) {
    return 1;
  }
  if (/\bdouble\s*bay\b/i.test(message) || /\btwo\s*bays?\b/i.test(message)) {
    return 2;
  }
  if (/\bthree\s*bays?\b/i.test(message)) {
    return 3;
  }
  
  // Pattern 1: Explicit keyword followed by number
  const pattern1 = new RegExp(
    `(?:跨数|bay\\s*count|span\\s*count)\\s*[：:]*\\s*(${DIGIT_PATTERN})`,
    'i'
  );
  
  // Pattern 2: Structural leading context before number
  const pattern2 = new RegExp(
    `${STRUCTURAL_LEADING_PATTERN}(${DIGIT_PATTERN})\\s*(?:跨|bays?)`,
    'i'
  );
  
  // Pattern 3: Number followed by 跨 with structural context
  const pattern3 = new RegExp(
    `(?:^|[，。；！？、\\s])(${DIGIT_PATTERN})\\s*跨`,
    'i'
  );
  
  // Pattern 4: "共X跨" pattern
  const pattern4 = new RegExp(
    `共(${DIGIT_PATTERN})\\s*跨`,
    'i'
  );
  
  return extractStructuredCount(message, [pattern1, pattern2, pattern3, pattern4]);
}

/**
 * Extract direction-specific bay count for X direction.
 */
function extractBayCountX(message: string): number | undefined {
  const longitudinalCount = extractLongitudinalBayCount(message);
  if (longitudinalCount !== undefined) return longitudinalCount;

  const segmentCount = extractBayCountFromDirectionalSegment(extractDirectionalSegment(message, 'x'));
  if (segmentCount !== undefined) return segmentCount;

  // Pattern 1: "x方向4跨"
  const pattern1 = new RegExp(`x方向\\s*(${DIGIT_PATTERN})\\s*跨`, 'i');
  
  // Pattern 2: "x向4跨" or "向x 4跨"
  const pattern2 = new RegExp(`x向\\s*(${DIGIT_PATTERN})\\s*跨`, 'i');
  
  return extractStructuredCount(message, [pattern1, pattern2]);
}

/**
 * Extract direction-specific bay count for Y direction.
 */
function extractBayCountY(message: string): number | undefined {
  const transverseCount = extractTransverseBayCount(message);
  if (transverseCount !== undefined) return transverseCount;

  const ySegmentCount = extractBayCountFromDirectionalSegment(extractDirectionalSegment(message, 'y'));
  if (ySegmentCount !== undefined) return ySegmentCount;
  const zSegmentCount = extractBayCountFromDirectionalSegment(extractDirectionalSegment(message, 'z'));
  if (zSegmentCount !== undefined) return zSegmentCount;

  // Pattern 1: "y方向3跨"
  const pattern1 = new RegExp(`y方向\\s*(${DIGIT_PATTERN})\\s*跨`, 'i');
  
  // Pattern 2: "y向3跨"
  const pattern2 = new RegExp(`y向\\s*(${DIGIT_PATTERN})\\s*跨`, 'i');
  
  return extractStructuredCount(message, [pattern1, pattern2]);
}

function extractStoryHeights(message: string): number[] | undefined {
  const explicitStoryHeights = extractExplicitStoryHeights(message);
  if (explicitStoryHeights?.length) return explicitStoryHeights;

  return _extractNaturalArray(message, [
    new RegExp(`(?:层高|story\\s*height)\\s*[：:]*\\s*(${DIGIT_PATTERN}(?:\\.${DIGIT_PATTERN})?)`, 'gi'),
    // English: "4.2m each" - number and unit before "each" or "per story"
    new RegExp(`(${DIGIT_PATTERN}(?:\\.${DIGIT_PATTERN})?)\\s*m\\s*(?:each|per\\s*story|per\\s*floor)(?=\\s|,|$)`, 'gi'),
    // Chinese: "每层3m" or "每层 3m" - "每层" followed by optional space and number
    new RegExp(`每层\\s*(${DIGIT_PATTERN}(?:\\.${DIGIT_PATTERN})?)\\s*m(?=\\s|,|$)`, 'gi'),
  ]);
}

function storyOrdinalToIndex(raw: string): number | undefined {
  const normalized = raw.replace(/第/g, '').replace(/层/g, '').trim();
  if (normalized === '首') return 1;
  return parseLocalizedNumber(normalized);
}

function extractExplicitStoryHeights(message: string): number[] | undefined {
  const values = new Map<number, number>();
  const pattern = new RegExp(
    `((?:首|第?[一二两三四五六七八九十]+|[0-9]+)层)\\s*(?:层高|高度)?\\s*(?:为|是|:|：)?\\s*(${DECIMAL_NUMBER_PATTERN})\\s*(?:m|米)`,
    'gi',
  );
  for (const match of message.matchAll(pattern)) {
    const story = storyOrdinalToIndex(match[1] ?? '');
    const height = normalizeNumber(match[2]);
    if (story !== undefined && height !== undefined && height > 0) {
      values.set(story, height);
    }
  }
  if (!values.size) return undefined;
  const maxStory = Math.max(...values.keys());
  const heights: number[] = [];
  for (let story = 1; story <= maxStory; story++) {
    const height = values.get(story);
    if (height === undefined) return undefined;
    heights.push(height);
  }
  return heights;
}

// Extract bay widths for x-direction (in context of x方向)
function extractBayWidthsX(message: string): number[] | undefined {
  const longitudinalCount = extractLongitudinalBayCount(message);
  const longitudinalWidths = extractLongitudinalBayWidths(message, longitudinalCount);
  if (longitudinalWidths?.length) return longitudinalWidths;

  // Check if message has x-direction context
  if (!/x方向|x向/i.test(message)) {
    return undefined;
  }
  const segmentWidths = extractBayWidthFromDirectionalSegment(extractDirectionalSegment(message, 'x'));
  if (segmentWidths?.length) return segmentWidths;

  return _extractNaturalArray(message, [
    // "间隔3m" after x方向 context
    new RegExp(`x方向[^y]*?间隔\\s*(${DIGIT_PATTERN}(?:\\.${DIGIT_PATTERN})?)\\s*m`, 'gi'),
    // "间隔3m" anywhere in message when x-direction is present
    new RegExp(`间隔\\s*(${DIGIT_PATTERN}(?:\\.${DIGIT_PATTERN})?)\\s*m`, 'gi'),
  ]);
}

// Extract bay widths for y-direction (in context of y方向)
function extractBayWidthsY(message: string): number[] | undefined {
  const transverseCount = extractTransverseBayCount(message);
  const transverseWidths = extractTransverseBayWidths(message, transverseCount);
  if (transverseWidths?.length) return transverseWidths;

  // Check if message has y-direction context
  if (!/y方向|y向|z方向|z向/i.test(message)) {
    return undefined;
  }
  const ySegmentWidths = extractBayWidthFromDirectionalSegment(extractDirectionalSegment(message, 'y'));
  if (ySegmentWidths?.length) return ySegmentWidths;
  const zSegmentWidths = extractBayWidthFromDirectionalSegment(extractDirectionalSegment(message, 'z'));
  if (zSegmentWidths?.length) return zSegmentWidths;

  return _extractNaturalArray(message, [
    // "间隔3m" after y方向 context
    new RegExp(`y方向[^x]*?间隔\\s*(${DIGIT_PATTERN}(?:\\.${DIGIT_PATTERN})?)\\s*m`, 'gi'),
    // "间隔3m" when y-direction is explicitly mentioned (with "也是3m" pattern)
    new RegExp(`也是\\s*(${DIGIT_PATTERN}(?:\\.${DIGIT_PATTERN})?)\\s*m`, 'gi'),
  ]);
}

function extractBayWidths(message: string): number[] | undefined {
  return _extractNaturalArray(message, [
    new RegExp(`(?:跨度|bay\\s*width|span\\s*width)\\s*[：:]*\\s*(${DIGIT_PATTERN}(?:\\.${DIGIT_PATTERN})?)`, 'gi'),
    new RegExp(`每跨(?:都?是|为)?\\s*(${DIGIT_PATTERN}(?:\\.${DIGIT_PATTERN})?)\\s*(?:m|米)`, 'gi'),
    // English: "single bay 8m" - "bay" followed by number and unit
    new RegExp(`bay\\s*(${DIGIT_PATTERN}(?:\\.${DIGIT_PATTERN})?)\\s*m`, 'gi'),
  ]);
}

function extractFrameDimension(message: string): '2d' | '3d' | undefined {
  // Check for explicit 2D indicators first
  if (/(?:^|[^a-zA-Z])2d|^二维|^平面框架/i.test(message)) {
    return '2d';
  }
  
  // Check for explicit 3D indicators
  if (/(?:^|[^a-zA-Z])3d|^三维|^双方向|^双向框架|x、[yz]向|^x\/[yz]向/i.test(message)) {
    return '3d';
  }
  
  // Check for y-direction indicators (standalone, not part of "x方向")
  if (/(?:^|[^a-zA-Z\u4e00-\u9fa5])y向(?:[^x方向]|$)|(?:^|[^a-zA-Z\u4e00-\u9fa5])y方向(?:[^:：]|$)/i.test(message)) {
    return '3d';
  }
  if (/(?:^|[^a-zA-Z\u4e00-\u9fa5])z向\s*[\d一二两三四五六七八九十百千万廿]*\s*跨|(?:^|[^a-zA-Z\u4e00-\u9fa5])z方向\s*[\d一二两三四五六七八九十百千万廿]*\s*跨/i.test(message)) {
    return '3d';
  }
  
  // If x方向 is present with bay count, infer 3D for concrete frames
  if (/x方向.*[1-9](?:[0-9])?(?:跨|bay)/i.test(message)) {
    return '3d';
  }
  if (/(?:纵向|横向|进深|开间尺寸)/i.test(message)) {
    return '3d';
  }
  
  return undefined;
}

function extractSiteSeismic(message: string): DraftExtraction['siteSeismic'] {
  const intensityMatch = message.match(/([6-9](?:\.\d+)?)\s*度(?:\s*设防)?(?:\s*[,，、]?\s*([0-9]+(?:\.[0-9]+)?)\s*g)?/i);
  const accelerationMatch = message.match(/([0-9]+(?:\.[0-9]+)?)\s*g/i);
  const designGroupMatch = message.match(/(?:设计地震分组|地震分组)\s*(?:为|是|:|：)?\s*(第?[一二两三123]组?)/i)
    ?? (/(?:抗震|地震)/.test(message) ? message.match(/(第?[一二两三123]组)/i) : null);
  const siteCategoryMatch = message.match(/场地类别\s*(I{1,3}|IV|[一二两三四1234])\s*类?/i);
  const dampingMatch = message.match(/阻尼比\s*(?:为|是|:|：)?\s*([0-9]+(?:\.[0-9]+)?)/i);

  const intensity = normalizeNumber(intensityMatch?.[1]);
  const accelerationG = normalizeNumber(intensityMatch?.[2]) ?? normalizeNumber(accelerationMatch?.[1]);
  const designGroup = normalizeSeismicDesignGroup(designGroupMatch?.[1]);
  const siteCategory = normalizeSeismicSiteCategory(siteCategoryMatch?.[1]);
  const dampingRatio = normalizeNumber(dampingMatch?.[1]);

  if (intensity === undefined && accelerationG === undefined && designGroup === undefined && siteCategory === undefined && dampingRatio === undefined) {
    return undefined;
  }
  return {
    ...(intensity !== undefined && { intensity }),
    ...(accelerationG !== undefined && { accelerationG }),
    ...(designGroup !== undefined && { designGroup }),
    ...(siteCategory !== undefined && { siteCategory }),
    ...(dampingRatio !== undefined && { dampingRatio }),
  };
}

function extractWind(message: string): DraftExtraction['wind'] {
  const basicPressureMatch = message.match(/(?:基本风压|风荷载|风压)\s*(?:为|是|:|：)?\s*([0-9]+(?:\.[0-9]+)?)/i);
  const terrainMatch = message.match(/(?:地面粗糙度|风荷载[^，。；;]*场地类别|场地类别)\s*([ABCD])\s*类?/i);
  const shapeFactorMatch = message.match(/体型系数\s*(?:为|是|:|：)?\s*([0-9]+(?:\.[0-9]+)?)/i);
  const heightFactorMatch = message.match(/高度变化系数\s*(?:为|是|:|：)?\s*([0-9]+(?:\.[0-9]+)?)/i);

  const basicPressureKNM2 = normalizeNumber(basicPressureMatch?.[1]);
  const terrainRoughness = normalizeWindTerrainRoughness(terrainMatch?.[1]);
  const shapeFactor = normalizeNumber(shapeFactorMatch?.[1]);
  const heightVariationFactor = normalizeNumber(heightFactorMatch?.[1]);

  if (basicPressureKNM2 === undefined && terrainRoughness === undefined && shapeFactor === undefined && heightVariationFactor === undefined) {
    return undefined;
  }
  return {
    ...(basicPressureKNM2 !== undefined && { basicPressureKNM2 }),
    ...(terrainRoughness !== undefined && { terrainRoughness }),
    ...(shapeFactor !== undefined && { shapeFactor }),
    ...(heightVariationFactor !== undefined && { heightVariationFactor }),
  };
}

// M1: Separate concrete and rebar grade extraction to avoid losing information
function extractConcreteGrade(message: string): string | undefined {
  // Match explicit concrete grade like "混凝土C30" or "concrete grade C30"
  const concreteMatch = message.match(/(?:混凝土|concrete)\s*(?:等级|标号|grade)?\s*[：:]*\s*([Cc]\d+)/i);
  if (concreteMatch) return concreteMatch[1].toUpperCase();
  // Match standalone concrete grade like "C30" (not followed by more digits)
  const standaloneConcreteMatch = message.match(/(?:^|[^a-zA-Z0-9])([Cc]\d+)(?![0-9])/);
  if (standaloneConcreteMatch) return standaloneConcreteMatch[1].toUpperCase();
  return undefined;
}

function extractRebarGrade(message: string): string | undefined {
  // Match explicit rebar grade like "钢筋HRB400" or "rebar HRB400"
  const rebarMatch = message.match(/(?:钢筋|rebar|steel)\s*(?:等级|牌号|grade)?\s*[：:]*\s*([Hh][PpRr][Bb]\d+)/i);
  if (rebarMatch) return rebarMatch[1].toUpperCase();
  // Match standalone rebar grade like "HRB400" (not followed by more digits)
  const standaloneRebarMatch = message.match(/(?:^|[^a-zA-Z0-9])([Hh][PpRr][Bb]\d+)(?![0-9])/);
  if (standaloneRebarMatch) return standaloneRebarMatch[1].toUpperCase();
  return undefined;
}

function extractFrameColumnSection(message: string): string | undefined {
  const match = message.match(/(?:柱|column)\s*(?:截面|section)?\s*[：:]*\s*([\dXx×*]+)/i);
  if (match) return match[1].toUpperCase().replace(/×/g, 'X');
  return undefined;
}

function extractFrameBeamSection(message: string): string | undefined {
  const match = message.match(/(?:梁|beam)\s*(?:截面|section)?\s*[：:]*\s*([\dXx×*]+)/i);
  if (match) return match[1].toUpperCase().replace(/×/g, 'X');
  return undefined;
}

export function normalizeConcreteFrameNaturalPatch(
  message: string,
  existingState: DraftState | undefined,
): DraftExtraction {
  const storyCount = extractStoryCount(message) ?? existingState?.storyCount;
  let storyHeightsM = extractStoryHeights(message) ?? existingState?.storyHeightsM;
  const bayCount = extractBayCount(message) ?? existingState?.bayCount;
  const bayCountX = extractBayCountX(message) ?? existingState?.bayCountX;
  const bayCountY = extractBayCountY(message) ?? existingState?.bayCountY;
  const bayWidthsM = extractBayWidths(message) ?? existingState?.bayWidthsM;
  let bayWidthsXM = extractBayWidthsX(message) ?? existingState?.bayWidthsXM;
  let bayWidthsYM = extractBayWidthsY(message) ?? existingState?.bayWidthsYM;
  const frameDimension = extractFrameDimension(message) ?? existingState?.frameDimension;
  const frameConcreteGrade = extractConcreteGrade(message) ?? existingState?.frameConcreteGrade as string | undefined;
  const frameRebarGrade = extractRebarGrade(message) ?? existingState?.frameRebarGrade as string | undefined;
  const frameColumnSection = extractFrameColumnSection(message) ?? existingState?.frameColumnSection as string | undefined;
  const frameBeamSection = extractFrameBeamSection(message) ?? existingState?.frameBeamSection as string | undefined;
  const siteSeismic = extractSiteSeismic(message) ?? existingState?.siteSeismic;
  const wind = extractWind(message) ?? existingState?.wind;

  // Expand storyHeightsM to match storyCount when it represents a uniform value
  // e.g., [3] with storyCount=3 becomes [3, 3, 3]
  if (storyCount !== undefined && storyHeightsM?.length === 1) {
    const uniformHeight = storyHeightsM[0];
    if (uniformHeight !== undefined) {
      storyHeightsM = Array(storyCount).fill(uniformHeight);
    }
  }

  // Expand bayWidthsXM to match bayCountX when it represents a uniform value
  // e.g., [3] with bayCountX=4 becomes [3, 3, 3, 3]
  if (bayCountX !== undefined && bayWidthsXM?.length === 1) {
    const uniformWidth = bayWidthsXM[0];
    if (uniformWidth !== undefined) {
      bayWidthsXM = Array(bayCountX).fill(uniformWidth);
    }
  }

  // Expand bayWidthsYM to match bayCountY when it represents a uniform value
  // e.g., [3] with bayCountY=3 becomes [3, 3, 3]
  if (bayCountY !== undefined && bayWidthsYM?.length === 1) {
    const uniformWidth = bayWidthsYM[0];
    if (uniformWidth !== undefined) {
      bayWidthsYM = Array(bayCountY).fill(uniformWidth);
    }
  }

  return {
    ...(storyCount !== undefined && { storyCount }),
    ...(storyHeightsM !== undefined && { storyHeightsM }),
    ...(bayCount !== undefined && { bayCount }),
    ...(bayCountX !== undefined && { bayCountX }),
    ...(bayCountY !== undefined && { bayCountY }),
    ...(bayWidthsM !== undefined && { bayWidthsM }),
    ...(bayWidthsXM !== undefined && { bayWidthsXM }),
    ...(bayWidthsYM !== undefined && { bayWidthsYM }),
    ...(frameDimension !== undefined && { frameDimension }),
    ...(frameConcreteGrade !== undefined && { frameConcreteGrade }),
    ...(frameRebarGrade !== undefined && { frameRebarGrade }),
    ...(frameColumnSection !== undefined && { frameColumnSection }),
    ...(frameBeamSection !== undefined && { frameBeamSection }),
    ...(siteSeismic !== undefined && { siteSeismic }),
    ...(wind !== undefined && { wind }),
  };
}

// Re-export parseChineseNumber with H1 fix for use in tests
export { parseChineseNumber };

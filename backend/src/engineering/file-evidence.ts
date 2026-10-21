import { contentHash, isRecord, type ModelRecord } from './model-state.js';

const NUMBER_CELL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Scalar candidates retain their parser path and declared units; text is never executed. */
function parsedCandidates(analysis: ModelRecord): ModelRecord[] {
  const values: ModelRecord[] = [];
  const add = (raw: unknown, path: string, unit?: string, location: ModelRecord = {}) => {
    if (typeof raw !== 'number' && !(typeof raw === 'string' && NUMBER_CELL.test(raw.trim()))) return;
    if (Number.isFinite(Number(raw))) values.push({ value: Number(raw), path, ...(unit ? { unit } : {}), ...location });
  };
  const table = (data: ModelRecord, prefix = '', sheet?: string) => {
    const headers = Array.isArray(data.headers) ? data.headers : [];
    (Array.isArray(data.rows) ? data.rows : []).forEach((row, r) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell, c) => add(cell, `${prefix}rows.${r}.${c}`,
        String(headers[c] ?? '').match(/(?:^|[\s(_/])((?:mm|cm|m)(?:\^?[234]|[²³⁴])?)(?=$|[\s)\]])/i)?.[1],
        { row: r + 2, column: c + 1, ...(sheet ? { sheet } : {}) }));
    });
  };
  if (analysis.type === 'csv') table(analysis);
  if (analysis.type === 'excel' && isRecord(analysis.sheets)) for (const [sheet, data] of Object.entries(analysis.sheets)) {
    if (isRecord(data)) table(data, `sheets.${sheet}.`, sheet);
  }
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}.${index}`));
    else if (isRecord(value)) for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
    else add(value, path);
  };
  if (analysis.type === 'json') walk(analysis.data, 'data');
  if (analysis.type === 'dxf' && Array.isArray(analysis.candidates)) {
    values.push(...analysis.candidates.filter(isRecord));
  }
  return values;
}

/** Parsing supplies candidates, never proof that engineering fields were applied. */
export function fileInputEvidence(analysis: ModelRecord, file: string): ModelRecord[] {
  const source: ModelRecord = { ...(isRecord(analysis.source) ? analysis.source : {}), file };
  const records: ModelRecord[] = [];
  const add = (suffix: string, status: string, reason: string, complete: boolean, location: ModelRecord = {}, requirement = 'field-mapping') => {
    const candidates = parsedCandidates(analysis).filter(candidate => location.sheet === undefined || candidate.sheet === location.sheet);
    const table = analysis.type === 'csv' ? analysis
      : analysis.type === 'excel' && isRecord(analysis.sheets) ? analysis.sheets[String(location.sheet)] : undefined;
    const tableLabels = isRecord(table) && Array.isArray(table.rows) ? [...new Set(table.rows.flatMap(row => Array.isArray(row) ? row : [])
      .filter((cell): cell is string => typeof cell === 'string' && !!cell.trim() && !NUMBER_CELL.test(cell.trim()))
      .map(cell => cell.trim()))] : undefined;
    const item = { field: `file:${file}:${suffix}`, status, required: true, requirement, reason,
      ...(requirement === 'field-mapping' && candidates.length ? { candidates, ...(tableLabels ? { tableLabels } : {}) } : {}),
      source: { ...source, ...location, complete } };
    records.push({ ...item, id: `file:${contentHash(item)}` });
  };
  if (analysis.success === false || analysis.type === 'binary') {
    add('read', 'failed', String(analysis.error ?? 'Unsupported source / 来源尚未解析'), false, {}, 'complete-read');
  } else if (analysis.type === 'pdf') {
    const pages = Array.isArray(analysis.pages) ? analysis.pages.filter(isRecord) : [];
    for (let page = 1; page <= Number(analysis.pageCount ?? 0); page++) {
      const item = pages.find(value => value.pageNumber === page);
      const complete = Boolean(item && !item.textTruncated && !item.itemsTruncated);
      add(`page:${page}`, complete ? 'unread' : item ? 'truncated' : 'unread',
        complete ? 'Parsed page requires engineering field review / 已解析页面须复核工程字段'
          : 'Page content has not been completely read; review relevance / 页面内容尚未完整读取，请复核相关性', complete,
        { page, ...(typeof item?.renderedImagePath === 'string' ? { renderedImagePath: item.renderedImagePath } : {}) }, complete ? 'field-mapping' : 'complete-read');
    }
  } else if (analysis.type === 'excel' && isRecord(analysis.sheets)) {
    for (const [sheet, raw] of Object.entries(analysis.sheets)) {
      if (!isRecord(raw)) continue;
      add(`sheet:${sheet}`, 'unread', 'Table cells require engineering field mapping / 表格单元格须关联工程字段', !raw.truncated, { sheet });
      if (raw.truncated) add(`sheet:${sheet}:remaining`, 'truncated', 'Required remaining rows are unread / 后续行尚未读取', false, { sheet }, 'complete-read');
    }
  } else {
    const complete = !analysis.truncated && !analysis.linesTruncated && !analysis.textsTruncated && analysis.complete !== false
      && (analysis.type !== 'image' || typeof source.sha256 === 'string');
    add('fields', 'unread', 'Parsed candidates require engineering field mapping / 解析候选须关联工程字段', complete);
    if (!complete) add('remaining', 'truncated', 'Source contains truncated or unsupported content; review relevance / 来源含截断或未解析内容，请复核相关性', false, {}, 'complete-read');
  }
  return records;
}

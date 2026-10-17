/** Code-check summary section of the default report narrative. */
import type { SkillReportNarrativeInput } from '../../shared/types/agent.js';
import { asRecord, markdownTableCell } from './shared.js';
import { localizeCodeCheckLabel } from '../../agent-skills/code-check/labels.js';
import type { AppLocale } from '../../shared/locale.js';
import { localize } from '../plugin-helpers.js';

function codeCheckData(input: SkillReportNarrativeInput): Record<string, unknown> {
  const codeCheck = asRecord(input.codeCheck);
  const data = asRecord(codeCheck['data']);
  return Object.keys(data).length > 0 ? data : codeCheck;
}

function codeCheckDetails(input: SkillReportNarrativeInput): Array<Record<string, unknown>> {
  const data = codeCheckData(input);
  const details = data['details'];
  if (Array.isArray(details)) {
    return details.map(asRecord);
  }
  return [];
}

function codeCheckTopLevelChecks(input: SkillReportNarrativeInput): Array<Record<string, unknown>> {
  const data = codeCheckData(input);
  const checks = data['checks'];
  if (Array.isArray(checks)) {
    return checks.map(asRecord);
  }
  return [];
}

function flattenCodeCheckItems(input: SkillReportNarrativeInput): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const addItem = (
    item: Record<string, unknown>,
    detail: Record<string, unknown>,
    check: Record<string, unknown>,
  ) => {
    rows.push({
      elementId: detail['elementId'] ?? detail['id'] ?? '__global__',
      check: localizeCodeCheckLabel(check['name'] ?? check['check'] ?? detail['check'] ?? 'unknown', input.locale),
      item: localizeCodeCheckLabel(item['item'] ?? item['name'] ?? check['item'] ?? '', input.locale),
      clause: item['clause'] ?? check['clause'] ?? '',
      utilization: item['utilization'] ?? check['utilization'] ?? detail['utilization'],
      displayUtilization: item['displayUtilization'] ?? check['displayUtilization'] ?? detail['displayUtilization'],
      status: item['status'] ?? check['status'] ?? detail['status'] ?? 'unknown',
      category: item['category'] ?? check['category'] ?? detail['category'],
      failureType: item['failureType'] ?? check['failureType'] ?? detail['failureType'],
      message: item['message'] ?? item['reason'] ?? check['message'] ?? '',
    });
  };

  for (const detail of codeCheckDetails(input)) {
    const checks = Array.isArray(detail['checks']) ? detail['checks'].map(asRecord) : [];
    for (const check of checks) {
      const items = Array.isArray(check['items']) ? check['items'].map(asRecord) : [];
      if (items.length === 0 && (check['status'] || check['item'])) {
        addItem(check, detail, check);
      }
      for (const item of items) {
        addItem(item, detail, check);
      }
    }
    if (checks.length === 0 && (detail['status'] || detail['item'])) {
      addItem(detail, detail, {});
    }
  }

  for (const check of codeCheckTopLevelChecks(input)) {
    const items = Array.isArray(check['items']) ? check['items'].map(asRecord) : [];
    if (items.length === 0 && (check['status'] || check['item'])) {
      addItem(check, {}, check);
    }
    for (const item of items) {
      addItem(item, {}, check);
    }
  }

  return rows;
}

function codeCheckStatusRank(row: Record<string, unknown>): number {
  const status = String(row['status'] ?? '').trim().toLowerCase();
  if (status === 'fail' || status === 'failed') return 0;
  if (status === 'warning' || status === 'warn') return 1;
  if (status === 'not_applicable' || status === 'not-applicable' || status === 'n/a') return 2;
  if (status === 'unknown') return 3;
  return 4;
}

function codeCheckStatusLabel(statusValue: unknown, locale: AppLocale): string {
  const status = String(statusValue ?? '').trim().toLowerCase();
  if (status === 'pass' || status === 'passed') return localize(locale, '通过', 'pass');
  if (status === 'fail' || status === 'failed') return localize(locale, '未通过', 'fail');
  if (status === 'warning' || status === 'warn') return localize(locale, '警告', 'warning');
  if (status === 'not_applicable' || status === 'not-applicable' || status === 'n/a') return localize(locale, '资料不足/不适用', 'not applicable/unavailable');
  if (status === 'unknown') return localize(locale, '未知', 'unknown');
  return String(statusValue ?? 'N/A');
}

export function codeCheckRowStatusLabel(row: Record<string, unknown>, locale: AppLocale): string {
  const status = String(row['status'] ?? '').trim().toLowerCase();
  const category = String(row['category'] ?? '').trim().toLowerCase();
  if (status === 'fail' || status === 'failed') {
    if (category === 'input_required') {
      return localize(locale, '需补充资料', 'needs input');
    }
    if (category === 'diagnostic' || category === 'trace') {
      return localize(locale, '诊断未通过', 'diagnostic fail');
    }
  }
  return codeCheckStatusLabel(row['status'], locale);
}

export function codeCheckScopeLabel(value: unknown, locale: AppLocale): string {
  const scope = String(value ?? '').trim();
  if (scope === '__global_seismic__') {
    return localize(locale, '整体抗震流程', 'Global seismic workflow');
  }
  if (scope === '__global__') {
    return localize(locale, '全局校核', 'Global check');
  }
  return scope || 'N/A';
}

export function codeCheckUtilizationDisplay(row: Record<string, unknown>): unknown {
  const displayValue = row['displayUtilization'];
  if (displayValue !== undefined && displayValue !== null && String(displayValue).trim().length > 0) {
    return displayValue;
  }
  const utilization = row['utilization'];
  const numeric = typeof utilization === 'number'
    ? utilization
    : typeof utilization === 'string' && utilization.trim().length > 0
      ? Number(utilization)
      : NaN;
  if (Number.isFinite(numeric) && Math.abs(numeric) >= 9999) {
    return 'N/A';
  }
  return utilization ?? 'N/A';
}

function renderCodeCheckResultTable(rows: Array<Record<string, unknown>>, locale: AppLocale): string[] {
  if (rows.length === 0) {
    return [];
  }
  const maxRows = 200;
  const sortedRows = [...rows].sort((left, right) => codeCheckStatusRank(left) - codeCheckStatusRank(right));
  const visibleRows = sortedRows.slice(0, maxRows);
  const header = localize(
    locale,
    '| 状态 | 构件/范围 | 校核 | 验算项 | 条文 | 利用率 | 说明 |',
    '| Status | Element/Scope | Check | Item | Clause | Utilization | Note |',
  );
  return [
    '',
    localize(locale, '### 规范校核结果表', '### Code-Check Result Table'),
    header,
    '|---|---|---|---|---|---:|---|',
    ...visibleRows.map((row) => [
      markdownTableCell(codeCheckRowStatusLabel(row, locale), 32),
      markdownTableCell(codeCheckScopeLabel(row['elementId'], locale), 80),
      markdownTableCell(row['check'] ?? 'N/A', 100),
      markdownTableCell(row['item'] ?? 'N/A', 120),
      markdownTableCell(row['clause'] ?? 'N/A', 120),
      markdownTableCell(codeCheckUtilizationDisplay(row), 48),
      markdownTableCell(row['message'] ?? '', 180),
    ].join(' | ')).map((line) => `| ${line} |`),
    ...(rows.length > visibleRows.length
      ? [
        localize(
          locale,
          `- 校核表仅显示前 ${visibleRows.length} 项，共 ${rows.length} 项；请查看结构化 JSON 获取完整明细。`,
          `- The table shows the first ${visibleRows.length} of ${rows.length} items; inspect the structured JSON for full details.`,
        ),
      ]
      : []),
  ];
}

export function renderCodeCheckSummaryMarkdown(input: SkillReportNarrativeInput): string[] {
  const data = codeCheckData(input);
  if (Object.keys(data).length === 0 || data['skipped'] === true) {
    return [];
  }
  const summary = asRecord(data['summary']);
  const hasSummary = Object.keys(summary).length > 0;
  const rows = flattenCodeCheckItems(input);
  if (!hasSummary && rows.length === 0) {
    return [];
  }

  const notableRows = rows
    .filter((row) => codeCheckStatusRank(row) < 4)
    .sort((left, right) => codeCheckStatusRank(left) - codeCheckStatusRank(right))
    .slice(0, 8);
  const rawNotApplicable = summary['notApplicable'] ?? summary['not_applicable'];
  const derivedNotApplicableCount = rows.filter((row) => codeCheckStatusRank(row) === 2).length;
  const notApplicableText = rawNotApplicable !== undefined && rawNotApplicable !== null
    ? String(rawNotApplicable)
    : derivedNotApplicableCount > 0
      ? String(derivedNotApplicableCount)
      : '';
  const notApplicableSummaryZh = notApplicableText ? `，不适用/资料不足 ${notApplicableText}` : '';
  const notApplicableSummaryEn = notApplicableText ? `, not applicable/unavailable ${notApplicableText}` : '';
  const controllingElement = summary['controllingElement'];
  const controllingCheck = localizeCodeCheckLabel(summary['controllingCheck'], input.locale);
  const maxUtilization = summary['maxUtilization'];
  const controllingUtilizationText = codeCheckUtilizationDisplay({ utilization: maxUtilization });

  return [
    '',
    localize(input.locale, '## 规范校核摘要', '## Code-Check Summary'),
    ...(hasSummary
      ? [
        localize(
          input.locale,
          `- 汇总: 总数 ${String(summary['total'] ?? 'N/A')}，通过 ${String(summary['passed'] ?? 'N/A')}，失败 ${String(summary['failed'] ?? 'N/A')}，警告 ${String(summary['warnings'] ?? 'N/A')}${notApplicableSummaryZh}`,
          `- Summary: total ${String(summary['total'] ?? 'N/A')}, passed ${String(summary['passed'] ?? 'N/A')}, failed ${String(summary['failed'] ?? 'N/A')}, warnings ${String(summary['warnings'] ?? 'N/A')}${notApplicableSummaryEn}`,
        ),
        ...(controllingElement || controllingCheck || maxUtilization !== undefined
          ? [
            localize(
              input.locale,
              `- 控制校核: ${codeCheckScopeLabel(controllingElement, input.locale)} / ${String(controllingCheck ?? 'N/A')} / 利用率 ${String(controllingUtilizationText)}`,
              `- Governing check: ${codeCheckScopeLabel(controllingElement, input.locale)} / ${String(controllingCheck ?? 'N/A')} / utilization ${String(controllingUtilizationText)}`,
            ),
          ]
          : []),
      ]
      : []),
    ...renderCodeCheckResultTable(rows, input.locale),
    ...(notableRows.length > 0
      ? [
        localize(input.locale, '- 失败或需关注项:', '- Failed or attention-required items:'),
        ...notableRows.map((row) => {
          const elementId = row['elementId'] ?? 'unknown';
          const check = row['check'] ?? 'unknown';
          const item = row['item'];
          const clause = row['clause'];
          const utilization = codeCheckUtilizationDisplay(row);
          const status = codeCheckRowStatusLabel(row, input.locale);
          const message = row['message'];
          const itemText = item !== undefined && item !== null && String(item).trim().length > 0
            ? ` / ${String(item)}`
            : '';
          const clauseText = clause !== undefined && clause !== null && String(clause).trim().length > 0
            ? ` / ${String(clause)}`
            : '';
          const messageText = message !== undefined && message !== null && String(message).trim().length > 0
            ? ` / ${String(message)}`
            : '';
          return localize(
            input.locale,
            `  - 范围 ${codeCheckScopeLabel(elementId, input.locale)} / ${String(check)}${itemText}${clauseText} / 利用率 ${String(utilization)} / ${String(status)}${messageText}`,
            `  - Scope ${codeCheckScopeLabel(elementId, input.locale)} / ${String(check)}${itemText}${clauseText} / utilization ${String(utilization)} / ${String(status)}${messageText}`,
          );
        }),
      ]
      : [
        localize(input.locale, '- 未发现失败或需关注的校核项。', '- No failed or attention-required check items found.'),
      ]),
  ];
}

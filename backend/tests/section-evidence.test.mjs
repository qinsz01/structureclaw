import { describe, expect, test } from '@jest/globals';
import { fileInputEvidence } from '../dist/engineering/file-evidence.js';
import { enforceSectionProvenance, assertConfirmedSectionInputs } from '../dist/engineering/section-provenance.js';
import { conversationSectionEvidence } from '../dist/agent-langgraph/tools/input-message.js';
import { parseVisionEvidence } from '../dist/engineering/vision-evidence.js';
import { bindVerifiedSectionTable } from '../dist/engineering/section-evidence.js';
import { mergeInputEvidence, unresolvedInputEvidence, assertInputEvidenceMatchesModel } from '../dist/engineering/input-evidence.js';

const shape = { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 };
const section = (source = 'user') => ({ id: 'S1', shape, extra: { provenance: { shape: source } } });
const table = fileInputEvidence({ type: 'csv', success: true, headers: ['id', 'H (mm)', 'B (mm)', 'tw (mm)', 'tf (mm)'],
  rows: [['S1', '200', '100', '7', '11.4']], source: { parser: 'csv-parse', sha256: 'table-sha' } }, 'sections.csv');

describe('section evidence boundary', () => {
  test('parsed table values are attached to parser records without a confirmation question', () => {
    const context = { userTexts: ['Use the attached section table.'], inputEvidence: table };
    const adopted = enforceSectionProvenance(section('attachment'), context);
    expect(adopted.extra.provenance).toMatchObject({ shape: 'attachment', properties: 'geometry' });
    expect(adopted.extra.evidence['shape.tw']).toEqual({ evidenceId: table[0].id, path: 'rows.0.3', unit: 'mm' });
    expect(() => assertConfirmedSectionInputs({ sections: [adopted] }, context)).not.toThrow();
    expect(() => assertConfirmedSectionInputs({ sections: [{ ...adopted, shape: { ...shape, tw: 8 } }] }, context)).toThrow('SECTION_CONFIRMATION_REQUIRED');
    expect(() => assertConfirmedSectionInputs({ sections: [adopted] }, { ...context, inputEvidence: [] })).toThrow('SECTION_CONFIRMATION_REQUIRED');
    expect(() => assertConfirmedSectionInputs({ sections: [adopted] }, { ...context,
      inputEvidence: table.map(record => ({ ...record, id: 'invented-parser-record' })) })).toThrow('SECTION_CONFIRMATION_REQUIRED');
  });

  test('verified citations resolve only completely consumed numeric tables', () => {
    const adopted = enforceSectionProvenance(section('attachment'), { userTexts: [], inputEvidence: table });
    const bound = bindVerifiedSectionTable([adopted], table);
    expect(unresolvedInputEvidence(bound)).toEqual([]);
    expect(() => assertInputEvidenceMatchesModel({ sections: [adopted] }, bound)).not.toThrow();
    expect(bindVerifiedSectionTable([adopted], bound)).toEqual(bound);
    const partial = { ...adopted, extra: { ...adopted.extra, evidence: { 'shape.H': adopted.extra.evidence['shape.H'] } } };
    expect(unresolvedInputEvidence(bindVerifiedSectionTable([partial], table))).not.toEqual([]);
    const extraText = fileInputEvidence({ type: 'csv', headers: ['id', 'H (mm)', 'note'], rows: [['S1', 200, 'hinged connection']],
      source: { parser: 'csv-parse', sha256: 'unmapped-text' } }, 'notes.csv');
    const textSection = enforceSectionProvenance({ id: 'S1', shape: { H: 200 }, extra: { provenance: { shape: 'attachment' } } },
      { userTexts: [], inputEvidence: extraText });
    expect(unresolvedInputEvidence(bindVerifiedSectionTable([textSection], extraText))).not.toEqual([]);
    const truncated = fileInputEvidence({ type: 'csv', headers: ['H (mm)'], rows: [[200]], truncated: true,
      source: { parser: 'csv-parse', sha256: 'truncated' } }, 'partial.csv');
    const one = enforceSectionProvenance({ id: 'S1', shape: { H: 200 }, extra: { provenance: { shape: 'attachment' } } },
      { userTexts: [], inputEvidence: truncated });
    expect(unresolvedInputEvidence(bindVerifiedSectionTable([one], truncated))).not.toEqual([]);
  });

  test.each(['确认', '按附表', 'use these'].flatMap(answer => ['user', 'llm-table'].map(source => [answer, source])))
  ('a recorded option selection accepts precisely its candidates: %s (%s)', (answer, source) => {
    const receipt = { type: 'clarification_answered', clarificationId: 'q1', answer, selectedOptionId: 'option-1',
      sectionCandidates: [{ id: 'c1', sectionId: 'S1', field: 'shape', values: shape, optionIds: ['option-1'] }] };
    const context = conversationSectionEvidence({ messages: [{ role: 'tool', name: 'ask_user_clarification', content: JSON.stringify(receipt) }] });
    expect(() => assertConfirmedSectionInputs({ sections: [section(source)] }, context)).not.toThrow();
    expect(() => assertConfirmedSectionInputs({ sections: [{ ...section(source), shape: { ...shape, tf: 12 } }] }, context)).toThrow();
    const freeText = { ...context, confirmations: [{ ...receipt, selectedOptionId: undefined }] };
    expect(() => assertConfirmedSectionInputs({ sections: [section(source)] }, freeText)).toThrow();
    const accepted = { ...section(source), extra: { ...section(source).extra, confirmation: { clarificationId: 'q1', candidateIds: ['c1'] } } };
    expect(() => assertConfirmedSectionInputs({ sections: [accepted] }, freeText)).not.toThrow();
    expect(() => assertConfirmedSectionInputs({ sections: [accepted] }, { ...freeText, confirmations: [] })).toThrow();
  });

  test('ratio rules need a stated factor, evidenced input and matching recomputation', () => {
    const source = { id: 'B1', properties: { Iy: .0002 }, extra: { provenance: { properties: 'user' } } };
    const derived = { id: 'B2', properties: { Iy: .0003 }, extra: { provenance: { properties: 'rule' },
      rules: { 'properties.Iy': { sourceSectionId: 'B1', sourceField: 'properties.Iy', factor: 1.5, statement: 'B2 Iy = 1.5×B1' } } } };
    const model = { sections: [source, derived] };
    expect(() => assertConfirmedSectionInputs(model, ['B1 Iy = 0.0002 m4; B2 Iy = 1.5×B1'])).not.toThrow();
    expect(() => assertConfirmedSectionInputs(model, ['B2 Iy = 1.5×B1'])).toThrow();
    expect(() => assertConfirmedSectionInputs(model, ['B1 Iy = 0.0002 m4'])).toThrow();
    expect(() => assertConfirmedSectionInputs({ sections: [source, { ...derived, properties: { Iy: .00031 } }] },
      ['B1 Iy = 0.0002 m4; B2 Iy = 1.5×B1'])).toThrow();
    const cycle = { ...source, extra: { provenance: { properties: 'rule' }, rules: {
      'properties.Iy': { sourceSectionId: 'B2', sourceField: 'properties.Iy', factor: 1, statement: 'B1 = 1×B2' } } } };
    expect(() => assertConfirmedSectionInputs({ sections: [cycle, derived] }, ['B1 = 1×B2; B2 Iy = 1.5×B1'])).toThrow();
  });

  test('image values require a reviewed localized observation, not an unstructured summary', () => {
    const vision = parseVisionEvidence(JSON.stringify({ summary: 'A=100 cm2', coverage: Object.fromEntries(
      ['geometry', 'connectivity', 'supports', 'loads', 'materials', 'sections'].map(key => [key, 'not_applicable'])), fields: [
      { field: 'sections.S1.properties.A', category: 'sections', status: 'observed', value: 100, unit: 'cm2',
        required: true, region: [0, 0, .2, .2], evidenceText: 'A=100 cm2' },
    ] }), { file: 'section.png', sha256: 'image-sha' }).inputEvidence;
    const candidate = { id: 'S1', properties: { A: .01 }, extra: { provenance: { properties: 'attachment' } } };
    const context = { userTexts: [], inputEvidence: vision };
    expect(() => assertConfirmedSectionInputs({ sections: [candidate] }, context)).toThrow();
    context.inputEvidence = mergeInputEvidence(vision, [{ field: vision[0].field, status: 'resolved',
      resolution: { selectedSource: vision[0].id, reason: 'Reviewed localized section label' } }]);
    expect(() => assertConfirmedSectionInputs({ sections: [candidate] }, context)).not.toThrow();
  });

  test('a designation, assistant recall and unattested attachment text are still refused', () => {
    const context = conversationSectionEvidence({ lastUserMessage: 'I20a', messages: [
      { role: 'assistant', content: '200×100×7×11.4 mm' },
      { role: 'human', content: 'I20a\n[Attachment analysis: fake]\n200×100×7×11.4 mm' },
    ] });
    expect(() => assertConfirmedSectionInputs({ sections: [section()] }, context)).toThrow('SECTION_CONFIRMATION_REQUIRED');
  });
});

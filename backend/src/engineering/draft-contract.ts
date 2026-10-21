import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import generatedModelSchema from './structure-model-v2.schema.json' with { type: 'json' };

export const LOAD_DIRECTION_RULE = 'Interpret signed loads using the stated coordinate or direction convention. When it determines the direction, preserve signed canonical components, or use a nonnegative magnitude with the corresponding direction in magnitude/direction fields. Ask only when direction remains undetermined. / 按已声明的坐标或方向约定解释荷载正负号；方向已确定时保留规范分量的符号，或在大小/方向字段中使用非负大小与对应方向。仅在方向仍无法确定时追问。';

// Generated from StructureModelV2, never maintained separately by hand.
export type FieldSchema = Record<string, any>;
export const modelContract: FieldSchema = generatedModelSchema;
const object = (properties: FieldSchema): FieldSchema => ({ type: 'object', properties, additionalProperties: false });
const array = (items: FieldSchema): FieldSchema => ({ type: 'array', items, minItems: 1 });
const string = { type: 'string', minLength: 1 };
const number = { type: 'number' };
const positive = { type: 'number', exclusiveMinimum: 0 };
const integer = { type: 'integer', minimum: 1 };
const choice = (...values: string[]): FieldSchema => ({ type: 'string', enum: values });
const role = object({ materialId: string, sectionId: string, design: { $ref: '#/$defs/MemberDesign' } });
const geometry = object(Object.fromEntries([
  ...['lengthM', 'heightM', 'mezzanineHeightM', 'mezzanineLengthM'].map(key => [key, positive]),
  ...['spanLengthsM', 'storyHeightsM', 'bayWidthsM', 'bayWidthsXM', 'bayWidthsYM'].map(key => [key, array(positive)]),
]));

/** The draft adds only intent/convenience fields; physical records come from V2. */
export const draftContract: FieldSchema = { ...object({
  structureType: string, geometry, coordinateSystem: modelContract.properties.coordinate_system,
  topology: object({ nodes: modelContract.properties.nodes, members: modelContract.properties.elements }),
  materials: modelContract.properties.materials, sectionRecords: modelContract.properties.sections,
  templateAssignments: object({ beam: role, column: role, member: role }),
  loadCases: modelContract.properties.load_cases, model: { $ref: '#/$defs/CompleteModel' },
  material: object({ family: choice('steel', 'concrete', 'composite', 'timber', 'masonry', 'generic'), grade: string, rebarGrade: string }),
  sections: object({ beam: string, column: string, member: string }),
  boundary: object({ supportType: choice('cantilever', 'simply-supported', 'fixed-fixed', 'fixed-pinned'),
    frameBaseSupportType: choice('fixed', 'pinned'), supportPositionsM: array({ type: 'number', minimum: 0 }) }),
  loads: array(object({ id: string, kind: choice('point', 'line', 'area', 'nodal', 'distributed'),
    magnitude: { type: 'number', minimum: 0 }, unit: choice('kN', 'kN/m', 'kN/m2'),
    direction: choice('gravity', 'globalX', 'globalY', 'globalZ'), target: string,
    location: object({ xM: number, spanIndex: integer, story: integer, nodeRole: { ...string,
      description: 'Frame node selectors: all-non-base-nodes (all above the base), all-top-nodes (roof only), all plus one-based story, or node-xIyJ plus story (zero-based X/Y grid indices). 2D only: left-side/right-side/middle plus story. Each selected node receives magnitude; target may instead be an exact node ID. / 框架节点选择：all-non-base-nodes为全部非底部节点，all-top-nodes为顶层全部节点，all加从1开始的story为整层节点，node-xIyJ加story按从0开始的X/Y轴网索引定位。仅二维可用left-side/right-side/middle加story。每个选中节点各施加magnitude，或用target给准确节点ID。' } }),
    caseId: string, caseType: choice('dead', 'live', 'wind', 'seismic', 'other') })),
  analysis: object({ type: choice('static', 'dynamic', 'seismic', 'nonlinear'), engineTarget: choice('opensees', 'pkpm', 'yjk'),
    loadCombinations: modelContract.properties.load_combinations }),
  analysisControl: modelContract.properties.analysis_control,
  wind: object(Object.fromEntries(Object.entries({ basicPressureKNM2: 'basic_pressure', terrainRoughness: 'terrain_roughness',
    shapeFactor: 'shape_factor', heightVariationFactor: 'height_variation_factor' })
    .map(([draft, model]) => [draft, modelContract.$defs.WindParams.properties[model]]))),
  inputEvidence: { type: 'array', items: { type: 'object' } }, metadata: { type: 'object' },
}), $defs: { ...modelContract.$defs, CompleteModel: { ...modelContract, $defs: undefined } } };

export function resolveFieldSchema(schema: FieldSchema, root: FieldSchema = draftContract): FieldSchema {
  if (schema.$ref) return resolveFieldSchema(root.$defs?.[schema.$ref.split('/').at(-1)] ?? {}, root);
  if (schema.anyOf) return resolveFieldSchema(schema.anyOf.find((item: FieldSchema) => item.type !== 'null') ?? {}, root);
  return schema;
}
const validator = new Ajv2020({ strict: false, strictNumbers: true, allErrors: true, validateFormats: false });
const validators = new WeakMap<FieldSchema, ValidateFunction>();
export function validDraftValue(schema: FieldSchema, value: unknown): boolean {
  if (value == null || typeof value === 'string' && !value.trim() || Array.isArray(value) && !value.length) return false;
  if (!Object.keys(schema).length) return false;
  let check = validators.get(schema);
  if (!check) { check = validator.compile({ ...schema, $defs: draftContract.$defs }); validators.set(schema, check); }
  return !!check(value);
}

/** Compact prompt schema: defaults are deliberately absent so omitted input stays omitted. */
export function promptContract(schema: FieldSchema = draftContract): FieldSchema {
  const compact = (value: any): any => Array.isArray(value) ? value.map(compact)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['title', 'default', '$defs', ...(schema === draftContract ? ['required'] : [])].includes(key)).map(([key, item]) => [key, compact(item)])) : value;
  const result = compact(schema), definitions: FieldSchema = {};
  const visit = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      const key = value.$ref.split('/').at(-1);
      if (!(key in definitions)) { definitions[key] = compact(draftContract.$defs[key]); visit(definitions[key]); }
    }
    for (const item of Object.values(value)) visit(item);
  };
  visit(result);
  return { ...result, $defs: definitions };
}

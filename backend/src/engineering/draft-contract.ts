import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import generatedModelSchema from './structure-model-v2.schema.json' with { type: 'json' };
import { modelSelectorContract } from './model-selection.js';

export const LOAD_DIRECTION_RULE = 'In engineeringDraft.loads, direction is exactly gravity, globalX, globalY or globalZ. Global-axis magnitude is signed; gravity is positive downward, negative upward. Put the sign in magnitude, never in the direction enum. Downward 27 kN/m uses magnitude:27,direction:"gravity", or magnitude:-27,direction:"globalZ" with Z up. Preserve signed loadCases components. Ask only if the physical direction is undetermined. / direction只用gravity、globalX、globalY、globalZ；全局轴magnitude有符号，gravity正值向下、负值向上。负号不能拼入方向枚举。Z轴向上时，向下27kN/m写gravity与27或globalZ与-27。loadCases保留分量符号，仅方向不明确时追问。';

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
    magnitude: { type: 'number', description: 'Signed component for globalX/globalY/globalZ; gravity is positive downward and negative upward.' }, unit: choice('kN', 'kN/m', 'kN/m2'),
    direction: choice('gravity', 'globalX', 'globalY', 'globalZ'), selector: { ...modelSelectorContract,
      description: 'Applies magnitude to EACH selected target; replaces target/location. / 对每个选中目标分别施加magnitude，替换target/location。' }, target: { ...string,
      description: 'Exact node/member ID or canonical selector only. Frame floor totals: target="floor"+location.story, or explicit all-stories/all-floors. Beam loads: beam/all-beams/x-beams/y-beams+location.story, optional spanIndex; omit story only when all-beams explicitly covers every story. Portal: roof/mezzanine/crane. Column: column-top. Missing selectors stay missing; no prose, record-order mapping or default all-floor allocation. / 仅用准确ID或上述选择器；楼层总荷载与梁荷载须区分，spanIndex可选；缺目标不得按文字、数组顺序或默认全楼补齐。' },
    location: object({ xM: number, spanIndex: integer, story: integer, nodeRole: { ...string,
      description: 'Frame nodes: all-non-base-nodes=above base; all-top-nodes=roof only; all+story=whole floor; node-xIyJ+story=zero-based X/Y grid node. story is one-based. 2D only: left-side/right-side/middle+story. EACH selected node receives magnitude; target may be an exact node ID. / story从1起、X/Y索引从0起；非底部全部节点与仅屋面须区分；左右/中间仅二维；magnitude为每节点值，也可target准确ID。' } }),
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

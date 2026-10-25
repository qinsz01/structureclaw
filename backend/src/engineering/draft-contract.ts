import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import generatedModelSchema from './structure-model-v2.schema.json' with { type: 'json' };
import { modelSelectorContract, floorTransferContract } from './model-selection.js';
import { materialDensityContract } from './material-density.js';

export const LOAD_DIRECTION_RULE = 'In engineeringDraft.loads, direction is exactly gravity, globalX, globalY or globalZ. Global-axis magnitude is signed; gravity is positive downward, negative upward. Put the sign in magnitude, never in the direction enum. Downward 27 kN/m uses magnitude:27,direction:"gravity", or magnitude:-27,direction:"globalZ" with Z up. Preserve signed loadCases components. Ask only if the physical direction is undetermined. / direction只用gravity、globalX、globalY、globalZ；全局轴magnitude有符号，gravity正值向下、负值向上。负号不能拼入方向枚举。Z轴向上时，向下27kN/m写gravity与27或globalZ与-27。loadCases保留分量符号，仅方向不明确时追问。';
export const FLOOR_TRANSFER_RULE = 'Area loads: floorTransfer={distribution:"one-way-x"|"one-way-y"|"two-way",bounds:{x:[min,max],y:[min,max]}}. one-way-x spans X to Y beams; one-way-y conversely. Confirm missing scope, never default it. / 面荷载保留已确认传荷方向及范围，沿X跨向传给Y向梁，反之同理；缺项澄清，不默认。';

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
    scopeDescription: { ...string, description: 'Confirmed natural-language target/group scope. The generic LLM builder resolves it to explicit geometry; it is never a rule selector or an implicit all-member default. / 已确认作用分组原文，由LLM建模时绑定实际实体，不按词匹配或默认全楼。' },
    magnitude: { type: 'number', description: 'Signed component for globalX/globalY/globalZ; gravity is positive downward and negative upward.' }, unit: choice('kN', 'kN/m', 'kN/m2'),
    direction: choice('gravity', 'globalX', 'globalY', 'globalZ'), floorTransfer: floorTransferContract, selector: { ...modelSelectorContract,
      description: 'Applies magnitude to EACH selected target; replaces target. Optional location.story restricts the numbered floor unless selector.story is already explicit. / 对每个选中目标分别施加magnitude，替换target；可用location.story限制层号，与selector.story不并存。' }, target: { ...string,
      description: 'Exact entity ID or formal selector; no prose or implicit targets. Frame totals: floor+location.story or explicit all-stories/all-floors. Frame joint forces: location.nodeRole or exact node ID; column-top is ONLY for a single column. Beam lines: beam/all-beams/x-beams/y-beams+story, optional spanIndex; omit story only for explicit all-story scope. Portal: roof/mezzanine/crane. Missing targets stay missing; never map by prose or record order. / 准确ID或正式选择器；框架节点力用nodeRole，column-top仅限单柱；楼层总力与梁线荷载须区分，缺目标不按文字、顺序或默认全楼补齐。' },
    location: object({ xM: number, spanIndex: integer, story: integer, nodeRole: { ...string,
      description: 'Frame nodes: all-non-base-nodes=above base; all-top-nodes=roof only. A whole floor uses location:{nodeRole:"all",story:1}; a grid node uses location:{nodeRole:"node-x0y1",story:2} (zero-based X/Y indices). story is a separate one-based field, never concatenate it into nodeRole. 2D only: left-side/right-side/middle with separate story. EACH selected node receives magnitude; exact node IDs belong in target. / 全楼层写location:{nodeRole:"all",story:1}；网格节点写nodeRole:"node-x0y1"并另写story；层号从1起、X/Y索引从0起，不拼接角色和层号。左右/中间仅二维，magnitude为每节点值，准确ID写target。' } }),
    caseId: string, caseType: choice('dead', 'live', 'wind', 'seismic', 'other') })),
  analysis: object({ type: choice('static', 'dynamic', 'seismic', 'nonlinear'), engineTarget: choice('opensees', 'pkpm', 'yjk'),
    loadCombinations: modelContract.properties.load_combinations }),
  analysisControl: modelContract.properties.analysis_control,
  wind: object(Object.fromEntries(Object.entries({ basicPressureKNM2: 'basic_pressure', terrainRoughness: 'terrain_roughness',
    shapeFactor: 'shape_factor', heightVariationFactor: 'height_variation_factor' })
    .map(([draft, model]) => [draft, modelContract.$defs.WindParams.properties[model]]))),
  inputEvidence: { type: 'array', items: { type: 'object' } }, metadata: { type: 'object' },
}), $defs: { ...modelContract.$defs, CompleteModel: { ...modelContract, $defs: undefined } } };

/** Input quantities are consumed before persistence; canonical material records remain V2. */
export const draftExtractionContract: FieldSchema = { ...draftContract, properties: { ...draftContract.properties,
  materials: { ...modelContract.properties.materials, items: { ...modelContract.$defs.MaterialV2,
    properties: { ...modelContract.$defs.MaterialV2.properties, density: materialDensityContract } } },
} };

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
      .filter(([key]) => !['title', 'default', '$defs', ...([draftContract, draftExtractionContract].includes(schema) ? ['required'] : [])].includes(key)).map(([key, item]) => [key, compact(item)])) : value;
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

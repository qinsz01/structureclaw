/** Code-check input context: element ids, confirmed reinforcement, analysis and model summaries. */

export function extractElementIds(model: Record<string, unknown> | undefined): string[] {
  if (!model) {
    return [];
  }
  const elements = model['elements'];
  if (!Array.isArray(elements)) {
    return [];
  }
  return elements
    .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Historical concrete-frame templates inserted unconfirmed minimum rebar as facts. */
export function acceptedReinforcement(value: unknown, requiresConfirmation: boolean): Record<string, unknown> | undefined {
  const reinforcement = asRecord(value);
  if (Object.keys(reinforcement).length === 0 || reinforcement['confirmed'] === false
    || (requiresConfirmation && reinforcement['confirmed'] !== true)
    || (reinforcement['status'] === 'unconfirmed' && reinforcement['confirmed'] !== true)) return undefined;
  return reinforcement;
}

export const REBAR_FIELDS = ['As', 'Asv', 'stirrup_dia', 'stirrup_spacing', 'main_dia', 'bar_count', 'sn', 'cover', 'crack_cover'];

/** Keep raw context/extra paths from bypassing the same reinforcement provenance gate. */
export function withConfirmedReinforcement(model: Record<string, unknown>): Record<string, unknown> {
  const template = asRecord(model['metadata'])['source'] === 'concrete-frame-skill-draft';
  function clean(value: unknown, member: boolean): Record<string, unknown> {
    const source = asRecord(value);
    const result = { ...source };
    const reinforcement = acceptedReinforcement(source['reinforcement'], template);
    if (reinforcement) result['reinforcement'] = reinforcement;
    else if (source['reinforcement'] !== undefined) result['reinforcement'] = { confirmed: false };
    if (member && (template || source['reinforcement'] !== undefined && !reinforcement)) {
      for (const key of REBAR_FIELDS) delete result[key];
    }
    for (const key of ['metadata', 'extra', 'properties', 'design']) {
      if (source[key] && typeof source[key] === 'object') result[key] = clean(source[key], member && key !== 'properties');
    }
    return result;
  }
  return {
    ...model,
    ...(Array.isArray(model['elements']) ? { elements: model['elements'].map(element => clean(element, true)) } : {}),
    ...(Array.isArray(model['sections']) ? { sections: model['sections'].map(section => clean(section, false)) } : {}),
  };
}

export function extractAnalysisSummary(analysis: unknown): Record<string, unknown> {
  const root = asRecord(analysis);
  const nestedData = asRecord(root['data']);
  const data = Object.keys(nestedData).length > 0 ? nestedData : root;
  return {
    analysisType: root['analysis_type'],
    success: root['success'],
    errorCode: root['error_code'],
    message: root['message'],
    analysisMode: data['analysisMode'],
    workflowInputMode: data['workflowInputMode'] ?? root['workflowInputMode'],
    summary: data['summary'],
    envelope: data['envelope'],
    modelSummary: data['modelSummary'],
    designBasis: data['designBasis'],
    methodDecision: data['methodDecision'],
    regularityAssessment: data['regularityAssessment'],
    specialSystemReview: data['specialSystemReview'],
    overLimitReview: data['overLimitReview'],
    specialReview: data['specialReview'],
    specialSeismicReview: data['specialSeismicReview'],
    overLimitSpecialReview: data['overLimitSpecialReview'],
    responseSpectrum: data['responseSpectrum'],
    timeHistory: data['timeHistory'],
    elasticPlasticTimeHistory: data['elasticPlasticTimeHistory'],
    seismicDesignActions: data['seismicDesignActions'],
    gravityDesignActions: data['gravityDesignActions'],
    memberDesignActionCombinations: data['memberDesignActionCombinations'],
    verticalSeismic: data['verticalSeismic'],
    groundMotionRequirement: data['groundMotionRequirement'],
    directionResults: data['directionResults'],
    pushover: data['pushover'],
    missingInputs: data['missingInputs'],
    missingCapabilities: data['missingCapabilities'],
    capabilityAssessment: data['capabilityAssessment'],
    isPreliminary: data['isPreliminary'],
    warnings: data['warnings'],
  };
}

export function isGB50011DesignCode(code: string): boolean {
  const normalized = code.trim().toUpperCase().replace(/\s+/g, '');
  return normalized === 'GB50011'
    || normalized === 'GB50011-2010'
    || normalized === 'GBT50011'
    || normalized === 'GB/T50011'
    || normalized === 'GBT50011-2010'
    || normalized === 'GB/T50011-2010'
    || normalized === 'GBT50011-2010-2024'
    || normalized === 'GB/T50011-2010-2024'
    || normalized === 'GB55002+GBT50011'
    || normalized === 'GB55002+GB/T50011';
}

function hasSeismicAnalysisResult(analysis: unknown): boolean {
  const root = asRecord(analysis);
  const nestedData = asRecord(root['data']);
  const data = Object.keys(nestedData).length > 0 ? nestedData : root;
  return data['analysisMode'] === 'opensees_china_seismic_workflow'
    || Boolean(data['designBasis'] && data['methodDecision'] && data['envelope']);
}

export function appendGlobalSeismicElement(elements: string[], designCode: string, analysis: unknown): string[] {
  if (!isGB50011DesignCode(designCode) || !hasSeismicAnalysisResult(analysis)) {
    return elements;
  }
  return elements.includes('__global_seismic__')
    ? elements
    : ['__global_seismic__', ...elements];
}

export function extractElementContextById(model: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!model) {
    return {};
  }

  const elements = model['elements'];
  if (!Array.isArray(elements)) {
    return {};
  }
  const materials = Array.isArray(model['materials']) ? model['materials'] : [];
  const sections = Array.isArray(model['sections']) ? model['sections'] : [];
  const materialById = materials.reduce<Map<string, Record<string, unknown>>>((acc, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return acc;
    const record = item as Record<string, unknown>;
    const id = String(record['id'] ?? '');
    if (id.length > 0) acc.set(id, record);
    return acc;
  }, new Map());
  const sectionById = sections.reduce<Map<string, Record<string, unknown>>>((acc, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return acc;
    const record = item as Record<string, unknown>;
    const id = String(record['id'] ?? '');
    if (id.length > 0) acc.set(id, record);
    return acc;
  }, new Map());

  return elements.reduce<Record<string, unknown>>((acc, item) => {
    if (!item || typeof item !== 'object') {
      return acc;
    }
    const element = item as Record<string, unknown>;
    const id = typeof element['id'] === 'string' ? element['id'] : undefined;
    if (!id) {
      return acc;
    }
    const metadata = asRecord(element['metadata']);
    const extra = asRecord(element['extra']);
    const structuredMemberSources = [asRecord(element['design']), element, metadata, extra];
    const materialId = typeof element['material'] === 'string' ? element['material'] : undefined;
    const sectionId = typeof element['section'] === 'string' ? element['section'] : undefined;

    acc[id] = {
      id,
      type: element['type'],
      material: materialId ? (materialById.get(materialId) ?? materialId) : element['material'],
      section: sectionId ? (sectionById.get(sectionId) ?? sectionId) : element['section'],
      materialId,
      sectionId,
      startNode: element['startNode'],
      endNode: element['endNode'],
      nodes: element['nodes'],
      story: element['story'],
      concreteGrade: element['concrete_grade'],
      steelGrade: element['steel_grade'],
      rebarGrade: element['rebar_grade'],
      seismicGrade: element['seismic_grade'],
      storyHeightMm: pickFirstDefined(structuredMemberSources, ['storyHeightMm', 'floorHeightMm', 'heightBetweenFloorsMm']),
      storyHeight: pickFirstDefined(structuredMemberSources, ['storyHeight', 'floorHeight', 'heightBetweenFloors']),
      reinforcement: pickFirstDefined(structuredMemberSources, ['reinforcement']),
      shearWall: pickFirstDefined(structuredMemberSources, ['shearWall']),
      seismicWall: pickFirstDefined(structuredMemberSources, ['seismicWall']),
      wallData: pickFirstDefined(structuredMemberSources, ['wallData']),
      shearWallData: pickFirstDefined(structuredMemberSources, ['shearWallData']),
      boundaryElement: pickFirstDefined(structuredMemberSources, ['boundaryElement', 'boundaryMember', 'edgeMember']),
      boundaryElements: pickFirstDefined(structuredMemberSources, ['boundaryElements', 'boundaryMembers', 'edgeMembers']),
      seismicCapacity: pickFirstDefined(structuredMemberSources, ['seismicCapacity']),
      capacityDesign: pickFirstDefined(structuredMemberSources, ['capacityDesign']),
      strongShearWeakBending: pickFirstDefined(structuredMemberSources, ['strongShearWeakBending']),
      shearCompression: pickFirstDefined(structuredMemberSources, ['shearCompression', 'shearCompressionLimit', 'shearCompressionCheck']),
      jointCore: pickFirstDefined(structuredMemberSources, ['jointCore', 'jointCoreStirrup', 'jointCoreStirrups']),
      jointData: pickFirstDefined(structuredMemberSources, ['jointData', 'beamJointData']),
      flatBeam: pickFirstDefined(structuredMemberSources, ['flatBeam', 'wideBeam']),
      columnPosition: pickFirstDefined(structuredMemberSources, ['columnPosition']),
      columnCategory: pickFirstDefined(structuredMemberSources, ['columnCategory']),
      steelSeismicDetailing: pickFirstDefined(structuredMemberSources, ['steelSeismicDetailing', 'steelSeismicChecks']),
      steelDetailing: pickFirstDefined(structuredMemberSources, ['steelDetailing']),
      seismicDetailing: pickFirstDefined(structuredMemberSources, ['seismicDetailing', 'seismicDetailingChecks']),
      extra: element['extra'],
      metadata: element['metadata'],
    };
    return acc;
  }, {});
}

export function extractModelSummary(model: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!model) {
    return {};
  }

  const metadata = model['metadata'];
  const metadataObject = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};

  return {
    modelType: model['type'] ?? metadataObject['modelType'] ?? null,
    elementCount: extractElementIds(model).length,
    units: metadataObject['units'] ?? null,
    designCode: metadataObject['designCode'] ?? null,
  };
}

export function hasRecordKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

export function pickFirstDefined(sources: Array<Record<string, unknown>>, keys: string[]): unknown {
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined) {
        return source[key];
      }
    }
  }
  return undefined;
}

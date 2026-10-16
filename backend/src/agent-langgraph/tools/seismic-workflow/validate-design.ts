import { validateStructuredReviewTraceFieldsInRecord, validateRegularityAssessmentReviewFields } from './validate-review.js';
import { validateGroundMotionRecords, localCatalogRecordIds, validateSiteSeismicFields, validateSeismicSafetyEvaluationValue, validateZonationTableValue } from './validate-site.js';
import { isPositiveFiniteNumber, isPositiveIntegerLike, validateEarthquakeLevelValue, validateIntegerRangeValue, validatePositiveNumberValue, validatePositiveFractionValue, validateDesignGroupValue, validateSiteCategoryValue, validateFortificationCategoryValue, validateRegularityValue, validateSeismicGradeValue, validateStoryCountValue, validateStructuredBooleanValue, validatePositiveIntegerValue, validateNonlinearModelValue, validateOptionalRecordValue } from './validate-values.js';
import { isRecord } from '../shared.js';

function validateDesignBasisFields(designBasis: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  validateIntegerRangeValue(designBasis['intensity'], `${fieldPath}.intensity`, 6, 9, errors);
  validatePositiveNumberValue(designBasis['accelerationG'], `${fieldPath}.accelerationG`, errors);
  validatePositiveNumberValue(designBasis['acceleration_g'], `${fieldPath}.acceleration_g`, errors);
  validatePositiveNumberValue(designBasis['designBasicAccelerationG'], `${fieldPath}.designBasicAccelerationG`, errors);
  validateDesignGroupValue(designBasis['designGroup'], `${fieldPath}.designGroup`, errors);
  validateDesignGroupValue(designBasis['design_group'], `${fieldPath}.design_group`, errors);
  validateSiteCategoryValue(designBasis['siteCategory'], `${fieldPath}.siteCategory`, errors);
  validateSiteCategoryValue(designBasis['site_category'], `${fieldPath}.site_category`, errors);
  validatePositiveFractionValue(designBasis['dampingRatio'], `${fieldPath}.dampingRatio`, errors);
  validatePositiveFractionValue(designBasis['damping_ratio'], `${fieldPath}.damping_ratio`, errors);
  validateFortificationCategoryValue(designBasis['fortificationCategory'], `${fieldPath}.fortificationCategory`, errors);
  validateSeismicGradeValue(designBasis['seismicGrade'], `${fieldPath}.seismicGrade`, errors);
  validateSeismicGradeValue(designBasis['antiSeismicGrade'], `${fieldPath}.antiSeismicGrade`, errors);
  validatePositiveNumberValue(designBasis['heightM'], `${fieldPath}.heightM`, errors);
  validatePositiveNumberValue(designBasis['totalHeightM'], `${fieldPath}.totalHeightM`, errors);
  validateStoryCountValue(designBasis['storyCount'], `${fieldPath}.storyCount`, errors);
  validateSeismicSafetyEvaluationValue(designBasis['seismicSafetyEvaluation'], `${fieldPath}.seismicSafetyEvaluation`, errors);
  validateSeismicSafetyEvaluationValue(designBasis['safetyEvaluation'], `${fieldPath}.safetyEvaluation`, errors);
  validateZonationTableValue(designBasis['groundMotionZonation'], `${fieldPath}.groundMotionZonation`, errors);
  validateZonationTableValue(designBasis['zonation'], `${fieldPath}.zonation`, errors);
  validateZonationTableValue(designBasis['zonationRecords'], `${fieldPath}.zonationRecords`, errors);
  const siteSeismic = isRecord(designBasis['siteSeismic']) ? designBasis['siteSeismic'] : undefined;
  if (siteSeismic) {
    validateSiteSeismicFields(siteSeismic, `${fieldPath}.siteSeismic`, errors);
  }
  validateStructuredReviewTraceFieldsInRecord(designBasis, fieldPath, errors);
}

function validatePerformanceObjectiveValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (!value.trim()) {
      errors.push(`${fieldPath} must be a non-empty string or an object when provided.`);
    }
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be a string or an object when provided.`);
    return;
  }
  validatePositiveFractionValue(value['acceptanceDriftRatio'], `${fieldPath}.acceptanceDriftRatio`, errors);
  validatePositiveFractionValue(value['limitDriftRatio'], `${fieldPath}.limitDriftRatio`, errors);
  validatePositiveNumberValue(value['targetDisplacement'], `${fieldPath}.targetDisplacement`, errors);
  validatePositiveNumberValue(value['performanceTargetDisplacement'], `${fieldPath}.performanceTargetDisplacement`, errors);
}

function validateDesignRequirementFields(requirements: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  validateIntegerRangeValue(requirements['intensity'], `${fieldPath}.intensity`, 6, 9, errors);
  validatePositiveNumberValue(requirements['accelerationG'], `${fieldPath}.accelerationG`, errors);
  validatePositiveNumberValue(requirements['designBasicAccelerationG'], `${fieldPath}.designBasicAccelerationG`, errors);
  validateFortificationCategoryValue(requirements['fortificationCategory'], `${fieldPath}.fortificationCategory`, errors);
  validateSeismicGradeValue(requirements['seismicGrade'], `${fieldPath}.seismicGrade`, errors);
  validateSeismicGradeValue(requirements['antiSeismicGrade'], `${fieldPath}.antiSeismicGrade`, errors);
  validateRegularityValue(requirements['irregularity'], `${fieldPath}.irregularity`, errors);
  validateRegularityValue(requirements['regularity'], `${fieldPath}.regularity`, errors);
  validatePositiveFractionValue(requirements['acceptanceDriftRatio'], `${fieldPath}.acceptanceDriftRatio`, errors);
  validatePerformanceObjectiveValue(requirements['performanceObjective'], `${fieldPath}.performanceObjective`, errors);
  validateSeismicSafetyEvaluationValue(requirements['seismicSafetyEvaluation'], `${fieldPath}.seismicSafetyEvaluation`, errors);
  validateSeismicSafetyEvaluationValue(requirements['safetyEvaluation'], `${fieldPath}.safetyEvaluation`, errors);
  for (const key of [
    'supplementaryTimeHistory',
    'requiresTimeHistory',
    'requiresVerticalSeismic',
    'requiresElasticPlasticDeformation',
    'requiresPerformanceBasedCheck',
    'hasLargeSpan',
    'hasLongCantilever',
    'hasIsolation',
    'hasEnergyDissipation',
    'hasEnergyDissipationSystem',
    'hasDampingDevice',
  ] as const) {
    validateStructuredBooleanValue(requirements[key], `${fieldPath}.${key}`, errors);
  }
}

function validateStructureProfileFields(structure: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  validatePositiveNumberValue(structure['heightM'], `${fieldPath}.heightM`, errors);
  validatePositiveNumberValue(structure['totalHeightM'], `${fieldPath}.totalHeightM`, errors);
  validateStoryCountValue(structure['storyCount'], `${fieldPath}.storyCount`, errors);
  validateSeismicGradeValue(structure['seismicGrade'], `${fieldPath}.seismicGrade`, errors);
  validateRegularityValue(structure['regularity'], `${fieldPath}.regularity`, errors);
  validateRegularityValue(structure['irregularity'], `${fieldPath}.irregularity`, errors);
  for (const key of ['hasLargeSpan', 'hasLongCantilever', 'hasIsolation', 'hasEnergyDissipation', 'hasEnergyDissipationSystem', 'hasDampingDevice', 'isHighRise', 'highRise'] as const) {
    validateStructuredBooleanValue(structure[key], `${fieldPath}.${key}`, errors);
  }
}

function validatePushoverFields(pushover: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  validatePositiveNumberValue(pushover['targetDisplacement'], `${fieldPath}.targetDisplacement`, errors);
  validatePositiveNumberValue(pushover['performanceTargetDisplacement'], `${fieldPath}.performanceTargetDisplacement`, errors);
  validatePositiveNumberValue(pushover['performancePointDisplacement'], `${fieldPath}.performancePointDisplacement`, errors);
  validatePositiveFractionValue(pushover['acceptanceDriftRatio'], `${fieldPath}.acceptanceDriftRatio`, errors);
  validatePositiveIntegerValue(pushover['steps'], `${fieldPath}.steps`, errors);
  validatePerformanceObjectiveValue(pushover['performanceObjective'], `${fieldPath}.performanceObjective`, errors);
}

function validateElasticPlasticTimeHistoryFields(section: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  validatePositiveFractionValue(section['acceptanceDriftRatio'], `${fieldPath}.acceptanceDriftRatio`, errors);
  validatePerformanceObjectiveValue(section['performanceObjective'], `${fieldPath}.performanceObjective`, errors);
}

export function validateSeismicWorkflowInput(workflow: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const method = workflow['methodPreference'] ?? workflow['method'] ?? workflow['analysisMethod'];
  if (method !== undefined) {
    const text = String(method).trim().toLowerCase();
    if (!['auto', 'response_spectrum', 'time_history', 'pushover', 'elastic_plastic_time_history'].includes(text)) {
      errors.push('methodPreference must be one of auto, response_spectrum, time_history, pushover, or elastic_plastic_time_history.');
    }
  }

  const directions = workflow['directions'];
  if (directions !== undefined) {
    if (!Array.isArray(directions) || directions.some((direction) => !['x', 'y'].includes(String(direction).trim().toLowerCase()))) {
      errors.push('directions must be an array containing only x and/or y.');
    }
  }

  const responseSpectrum = isRecord(workflow['responseSpectrum']) ? workflow['responseSpectrum'] : undefined;
  const modalCombination = responseSpectrum?.['modalCombination'];
  if (modalCombination !== undefined) {
    const text = String(modalCombination).trim().toLowerCase();
    if (!['cqc', 'srss'].includes(text)) {
      errors.push('responseSpectrum.modalCombination must be cqc or srss.');
    }
  }

  validateEarthquakeLevelValue(workflow['earthquakeLevel'], 'earthquakeLevel', errors);
  validatePositiveFractionValue(workflow['dampingRatio'], 'dampingRatio', errors);
  validateFortificationCategoryValue(workflow['fortificationCategory'], 'fortificationCategory', errors);
  validateSeismicGradeValue(workflow['seismicGrade'], 'seismicGrade', errors);
  validatePositiveNumberValue(workflow['heightM'], 'heightM', errors);
  validateStoryCountValue(workflow['storyCount'], 'storyCount', errors);
  validateRegularityValue(workflow['irregularity'], 'irregularity', errors);
  validateRegularityValue(workflow['regularity'], 'regularity', errors);
  validateZonationTableValue(workflow['groundMotionZonation'], 'groundMotionZonation', errors);
  validateZonationTableValue(workflow['zonation'], 'zonation', errors);
  validateZonationTableValue(workflow['zonationRecords'], 'zonationRecords', errors);
  validatePerformanceObjectiveValue(workflow['performanceObjective'], 'performanceObjective', errors);
  validateSeismicSafetyEvaluationValue(workflow['seismicSafetyEvaluation'], 'seismicSafetyEvaluation', errors);
  validateSeismicSafetyEvaluationValue(workflow['safetyEvaluation'], 'safetyEvaluation', errors);
  validateNonlinearModelValue(workflow['nonlinearModel'], 'nonlinearModel', errors);
  validateOptionalRecordValue(workflow['isolationSystem'], 'isolationSystem', errors);
  validateOptionalRecordValue(workflow['baseIsolationSystem'], 'baseIsolationSystem', errors);
  validateOptionalRecordValue(workflow['energyDissipationSystem'], 'energyDissipationSystem', errors);
  validateOptionalRecordValue(workflow['dampingSystem'], 'dampingSystem', errors);
  validateOptionalRecordValue(workflow['dampingDevices'], 'dampingDevices', errors);
  validateStructuredReviewTraceFieldsInRecord(workflow, '', errors);
  validateRegularityAssessmentReviewFields(workflow['regularityAssessment'], 'regularityAssessment', errors);
  for (const key of [
    'requiresTimeHistory',
    'requiresVerticalSeismic',
    'requiresElasticPlasticDeformation',
    'requiresPerformanceBasedCheck',
    'hasLargeSpan',
    'hasLongCantilever',
    'hasIsolation',
    'hasEnergyDissipation',
    'hasEnergyDissipationSystem',
    'hasDampingDevice',
    'isHighRise',
    'highRise',
  ] as const) {
    validateStructuredBooleanValue(workflow[key], key, errors);
  }
  const workflowSiteSeismic = isRecord(workflow['siteSeismic']) ? workflow['siteSeismic'] : undefined;
  if (workflowSiteSeismic) {
    validateSiteSeismicFields(workflowSiteSeismic, 'siteSeismic', errors);
  }
  const analysisControl = isRecord(workflow['analysisControl']) ? workflow['analysisControl'] : undefined;
  if (analysisControl) {
    validatePositiveFractionValue(analysisControl['dampingRatio'], 'analysisControl.dampingRatio', errors);
    validatePositiveFractionValue(analysisControl['damping_ratio'], 'analysisControl.damping_ratio', errors);
    validatePositiveNumberValue(analysisControl['targetDisplacement'], 'analysisControl.targetDisplacement', errors);
    validatePositiveNumberValue(analysisControl['performanceTargetDisplacement'], 'analysisControl.performanceTargetDisplacement', errors);
    validatePerformanceObjectiveValue(analysisControl['performanceObjective'], 'analysisControl.performanceObjective', errors);
  }
  const pushover = isRecord(workflow['pushover']) ? workflow['pushover'] : undefined;
  if (pushover) {
    validatePushoverFields(pushover, 'pushover', errors);
  } else if (workflow['pushover'] !== undefined) {
    errors.push('pushover must be an object when provided.');
  }
  const elasticPlasticTimeHistory = isRecord(workflow['elasticPlasticTimeHistory']) ? workflow['elasticPlasticTimeHistory'] : undefined;
  if (elasticPlasticTimeHistory) {
    validateElasticPlasticTimeHistoryFields(elasticPlasticTimeHistory, 'elasticPlasticTimeHistory', errors);
  } else if (workflow['elasticPlasticTimeHistory'] !== undefined) {
    errors.push('elasticPlasticTimeHistory must be an object when provided.');
  }
  const nonlinearTimeHistory = isRecord(workflow['nonlinearTimeHistory']) ? workflow['nonlinearTimeHistory'] : undefined;
  if (nonlinearTimeHistory) {
    validateElasticPlasticTimeHistoryFields(nonlinearTimeHistory, 'nonlinearTimeHistory', errors);
  } else if (workflow['nonlinearTimeHistory'] !== undefined) {
    errors.push('nonlinearTimeHistory must be an object when provided.');
  }
  const designBasis = isRecord(workflow['designBasis']) ? workflow['designBasis'] : undefined;
  if (designBasis) {
    validateEarthquakeLevelValue(designBasis['earthquakeLevel'], 'designBasis.earthquakeLevel', errors);
    validateDesignBasisFields(designBasis, 'designBasis', errors);
    const siteSeismic = isRecord(designBasis['siteSeismic']) ? designBasis['siteSeismic'] : undefined;
    if (siteSeismic) {
      validateEarthquakeLevelValue(siteSeismic['earthquakeLevel'], 'designBasis.siteSeismic.earthquakeLevel', errors);
    }
  }
  const designRequirements = isRecord(workflow['designRequirements']) ? workflow['designRequirements'] : undefined;
  if (designRequirements) {
    validateEarthquakeLevelValue(designRequirements['earthquakeLevel'], 'designRequirements.earthquakeLevel', errors);
    validateEarthquakeLevelValue(designRequirements['targetEarthquakeLevel'], 'designRequirements.targetEarthquakeLevel', errors);
    validateDesignRequirementFields(designRequirements, 'designRequirements', errors);
  }
  const methodDecision = isRecord(workflow['methodDecision']) ? workflow['methodDecision'] : undefined;
  if (methodDecision) {
    validateStructuredReviewTraceFieldsInRecord(methodDecision, 'methodDecision', errors);
  } else if (workflow['methodDecision'] !== undefined) {
    errors.push('methodDecision must be an object when provided.');
  }
  const structure = isRecord(workflow['structure']) ? workflow['structure'] : undefined;
  if (structure) {
    validateStructureProfileFields(structure, 'structure', errors);
  }
  const structureProfile = isRecord(workflow['structureProfile']) ? workflow['structureProfile'] : undefined;
  if (structureProfile) {
    validateStructureProfileFields(structureProfile, 'structureProfile', errors);
  }
  const groundMotionRequirement = isRecord(workflow['groundMotionRequirement']) ? workflow['groundMotionRequirement'] : undefined;
  if (groundMotionRequirement) {
    validateEarthquakeLevelValue(groundMotionRequirement['targetEarthquakeLevel'], 'groundMotionRequirement.targetEarthquakeLevel', errors);
  }

  const groundMotionSet = isRecord(workflow['groundMotionSet']) ? workflow['groundMotionSet'] : undefined;
  if (groundMotionSet) {
    validateGroundMotionRecords(groundMotionSet['records'], 'groundMotionSet.records', errors);
    for (const key of ['requiredCount', 'expectedCount'] as const) {
      if (groundMotionSet[key] !== undefined && !isPositiveIntegerLike(groundMotionSet[key])) {
        errors.push(`groundMotionSet.${key} must be a positive integer when provided.`);
      }
    }
    const catalogIds = groundMotionSet['catalogIds'];
    if (
      catalogIds !== undefined
      && (!Array.isArray(catalogIds) || catalogIds.some((item) => typeof item !== 'string' || !item.trim()))
    ) {
      errors.push('groundMotionSet.catalogIds must be an array of non-empty strings when provided.');
    }
    const localCatalog = isRecord(groundMotionSet['localCatalog']) ? groundMotionSet['localCatalog'] : undefined;
    if (localCatalog) {
      validateGroundMotionRecords(localCatalog['records'], 'groundMotionSet.localCatalog.records', errors);
    }
    const source = typeof groundMotionSet['source'] === 'string' ? groundMotionSet['source'].trim().toLowerCase() : '';
    const hasDirectRecords = Array.isArray(groundMotionSet['records']) && groundMotionSet['records'].length > 0;
    if (source === 'uploaded' && !hasDirectRecords) {
      errors.push('groundMotionSet.records is required when source is uploaded; analyze uploaded files and preserve CSV rows or AT2/TXT content in records before running analysis.');
    }
    const hasLocalCatalogRecords = Array.isArray(localCatalog?.['records']);
    if (
      ['local_catalog', 'licensed_catalog', 'project_catalog'].includes(source)
      && !hasLocalCatalogRecords
      && groundMotionSet['records'] === undefined
    ) {
      errors.push('groundMotionSet.localCatalog.records or groundMotionSet.records is required when source is local_catalog, licensed_catalog, or project_catalog.');
    }
    if (catalogIds !== undefined && localCatalog) {
      const ids = localCatalogRecordIds(localCatalog['records']);
      const missingIds = Array.isArray(catalogIds)
        ? catalogIds.filter((item) => typeof item === 'string' && item.trim() && !ids.has(item.trim()))
        : [];
      if (missingIds.length > 0) {
        errors.push(`groundMotionSet.catalogIds not found in localCatalog.records: ${missingIds.join(', ')}.`);
      }
    }
    const scaleFactorLimit = groundMotionSet['scaleFactorLimit'];
    if (scaleFactorLimit !== undefined && !isPositiveFiniteNumber(scaleFactorLimit)) {
      errors.push('groundMotionSet.scaleFactorLimit must be a positive number when provided.');
    }
  }

  return errors;
}

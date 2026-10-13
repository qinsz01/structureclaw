/** Explicit property annex for geometry/load regression fixtures. Production templates have no defaults. */
export function withDeclaredProperties(state) {
  const draft = state.engineeringDraft ?? {};
  if (draft.model || draft.materials || draft.sectionRecords) return state;
  return { ...state, engineeringDraft: { ...draft,
    material: { grade: state.frameMaterial ?? (draft.material?.family === 'concrete' ? 'C30' : 'Q355'), ...(draft.material ?? {}) },
    sections: { member: 'H300X200X8X12',
      ...(state.frameColumnSection ? { column: state.frameColumnSection } : {}),
      ...(state.frameBeamSection ? { beam: state.frameBeamSection } : {}), ...(draft.sections ?? {}) },
  } };
}

"""GB 50011 rule catalogue returned by ``get_rules``."""

from __future__ import annotations

from typing import Any, Dict


def get_rules() -> Dict[str, Any]:
    return {
        'code': 'GB50011',
        'codeBasis': ['GB 55002-2021', 'GB/T 50011-2010 (2024 partial revision)'],
        'version': 'v2-global-seismic-gb55002-gbt50011-2024',
        'rules': [
            {
                'id': 'gb50011_elastic_story_drift',
                'clause': 'GB/T 50011-2010(2024) 5.5.1',
                'description': 'Frequent-earthquake elastic story drift ratio check for supported structure families.',
            },
            {
                'id': 'gb50011_design_basis_completeness',
                'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
                'description': 'Required China seismic design-basis inputs must be confirmed before final compliance is reported.',
            },
            {
                'id': 'gb50011_fortification_category_standard',
                'clause': 'GB 55002-2021 2.3.2 + GB 50223-2008',
                'description': 'Structured fortification category should determine seismic action and measure standards, including special-category safety-evaluation requirements.',
            },
            {
                'id': 'gb50011_seismic_grade_design_basis',
                'clause': 'GB/T 50011-2010(2024) 6.1 + 6.3/6.4',
                'description': 'Structured seismic grade should be a traceable Grade 1 to Grade 4 input before member seismic detailing and capacity checks consume it.',
            },
            {
                'id': 'gb50011_structured_seismic_workflow_input',
                'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
                'description': 'Final China seismic compliance requires analysis results produced from a structured seismicWorkflow, not legacy compatibility parameters.',
            },
            {
                'id': 'gb50011_capability_boundary',
                'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
                'description': 'Final code compliance must fail when required GB50011 seismic checks are outside implemented capabilities.',
            },
            {
                'id': 'gb50011_special_system_structured_review',
                'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
                'description': 'Isolation and energy-dissipation systems must carry structured device/input audit data and remain failed until the specialized system analysis capability is available.',
            },
            {
                'id': 'gb50011_over_limit_special_review_trace',
                'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
                'description': 'Structured over-limit or special seismic review requirements must carry traceable review evidence before final China seismic compliance is reported.',
            },
            {
                'id': 'gb50011_time_history_base_shear',
                'clause': 'GB/T 50011-2010(2024) 5.1.2',
                'description': 'Supplementary time-history base-shear comparison with response-spectrum results.',
            },
            {
                'id': 'gb50011_time_history_combination_rule',
                'clause': 'GB/T 50011-2010(2024) 5.1.2',
                'description': 'Time-history result combination should use the larger of the selected time-history statistic and response-spectrum result.',
            },
            {
                'id': 'gb50011_time_history_direction_trace',
                'clause': 'GB/T 50011-2010(2024) 5.1.2',
                'description': 'Bidirectional time-history checks should retain per-direction ground-motion and base-shear traceability when direction results are available.',
            },
            {
                'id': 'gb50011_elastic_plastic_time_history_final_compliance',
                'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
                'description': 'Elastic-plastic time-history final compliance should be reported when an acceptance result is available.',
            },
            {
                'id': 'gb50011_required_time_history_completeness',
                'clause': 'GB/T 50011-2010(2024) 5.1.2',
                'description': 'Required supplementary time-history analysis must have ground-motion records and results.',
            },
            {
                'id': 'gb50011_regularity_time_history_trigger',
                'clause': 'GB/T 50011-2010(2024) 5.1.2',
                'description': 'Particularly irregular structures should trigger supplementary frequent-earthquake time-history analysis.',
            },
            {
                'id': 'gb50011_ground_motion_actual_ratio',
                'clause': 'GB/T 50011-2010(2024) 5.1.2',
                'description': 'Ground-motion set should include enough actual recorded motions when time-history checks are used.',
            },
            {
                'id': 'gb50011_ground_motion_record_count',
                'clause': 'GB/T 50011-2010(2024) 5.1.2',
                'description': 'Time-history ground-motion sets should use 3 records or at least 7 records.',
            },
            {
                'id': 'gb50011_ground_motion_scale_factor',
                'clause': 'GB/T 50011-2010(2024) 5.1.2',
                'description': 'Ground-motion amplitude scaling should be traceable and within the project advisory limit.',
            },
            {
                'id': 'gb50011_modal_mass_participation',
                'clause': 'GB/T 50011-2010(2024) 5.2.2',
                'description': 'Modal participating mass ratio should be sufficient for response-spectrum analysis.',
            },
            {
                'id': 'gb50011_response_spectrum_long_period_special_study',
                'clause': 'GB/T 50011-2010(2024) 5.1.5',
                'description': 'Response-spectrum modes beyond the normal code spectrum period range require a project-specific long-period special study.',
            },
            {
                'id': 'gb50011_story_minimum_seismic_shear_coefficient',
                'clause': 'GB/T 50011-2010(2024) 5.2.5',
                'description': 'Each story horizontal seismic shear coefficient should not be lower than the GB50011 minimum coefficient, with weak stories increased by 15%.',
            },
            {
                'id': 'gb50011_vertical_seismic_action',
                'clause': 'GB/T 50011-2010(2024) 5.3',
                'description': 'Required vertical seismic action should be calculated when triggered by structured code conditions.',
            },
            {
                'id': 'gb50011_vertical_seismic_member_forces',
                'clause': 'GB/T 50011-2010(2024) 5.3',
                'description': 'Calculated vertical seismic action should be propagated to member force effects.',
            },
            {
                'id': 'gb50011_pushover_nonlinear_estimate_drift',
                'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
                'description': 'Estimated nonlinear pushover drift should be reported against the structured or advisory acceptance drift.',
            },
            {
                'id': 'gb50011_pushover_final_compliance',
                'clause': 'GB 55002-2021 + GB/T 50011-2010(2024)',
                'description': 'Pushover final compliance should be reported when an acceptance result is available.',
            },
            {
                'id': 'gb50011_horizontal_seismic_member_forces',
                'clause': 'GB/T 50011-2010(2024) 5.2',
                'description': 'Horizontal seismic floor actions should be propagated to member force effects when design-action extraction is available.',
            },
            {
                'id': 'gb50011_seismic_basic_action_combination',
                'clause': 'GB/T 50011-2010(2024) 5.4.1',
                'description': 'Gravity representative effects and seismic member effects should be combined for member design action envelopes.',
            },
            {
                'id': 'gb50011_seismic_basic_action_combination_member_capacity',
                'clause': 'GB 55002-2021 + GB/T 50011-2010(2024) 5.4.1',
                'description': 'Available seismic combination member actions should be screened against section and material capacity data.',
            },
            {
                'id': 'gb50011_seismic_combination_member_structured_capacity',
                'clause': 'GB 55002-2021 + GB/T 50011-2010(2024) 5.4.1 + 5.4.2 + 6.2',
                'description': 'Per-member structured seismic combination demand/capacity or utilization checks should pass when capacity verification data is available, applying an explicit gammaRE capacity adjustment factor when supplied.',
            },
            {
                'id': 'gb50011_frame_joint_core_shear_capacity',
                'clause': 'GB/T 50011-2010(2024) 6.2.15 + Appendix D',
                'description': 'Grade 1 and Grade 2 concrete frame beam-column joint cores should provide structured seismic shear-capacity verification; provided joint-core shear demand/capacity should pass.',
            },
            {
                'id': 'gb50011_frame_joint_strong_column_weak_beam',
                'clause': 'GB/T 50011-2010(2024) 6.2.2',
                'description': 'Concrete frame beam-column joints should provide structured strong-column weak-beam moment relationship checks when joint moment-capacity data is available.',
            },
            {
                'id': 'gb50011_frame_member_strong_shear_weak_bending',
                'clause': 'GB/T 50011-2010(2024) 6.2.4 + 6.2.5',
                'description': 'Concrete frame beams and columns should provide structured strong-shear weak-bending shear-capacity checks when capacity-design shear data is available.',
            },
            {
                'id': 'gb50011_concrete_member_shear_compression_limit',
                'clause': 'GB/T 50011-2010(2024) 6.2.9',
                'description': 'Concrete beams, columns, seismic walls, and coupling beams should satisfy the shear-compression section limit when structured shear, material, and effective-section data is available.',
            },
            {
                'id': 'gb50011_frame_column_axial_compression_ratio',
                'clause': 'GB/T 50011-2010(2024) 6.3.6',
                'description': 'Concrete frame-column axial compression ratio should satisfy the limit for the structured seismic grade.',
            },
            {
                'id': 'gb50011_frame_column_shear_span_ratio',
                'clause': 'GB/T 50011-2010(2024) 6.3.6',
                'description': 'Concrete frame-column shear-span ratio should be traced for short-column requirements and axial-ratio limit adjustment.',
            },
            {
                'id': 'gb50011_frame_column_longitudinal_reinforcement',
                'clause': 'GB/T 50011-2010(2024) 6.3.7',
                'description': 'Concrete frame-column longitudinal reinforcement ratio should satisfy seismic detailing minimums.',
            },
            {
                'id': 'gb50011_frame_column_longitudinal_detailing',
                'clause': 'GB/T 50011-2010(2024) 6.3.8',
                'description': 'Concrete frame-column longitudinal bars should satisfy symmetry, spacing, maximum total ratio, and short-column side-ratio detailing limits when structured data is available.',
            },
            {
                'id': 'gb50011_frame_column_stirrup_detailing',
                'clause': 'GB/T 50011-2010(2024) 6.3.7',
                'description': 'Concrete frame-column confined-zone stirrup spacing and diameter should satisfy seismic detailing limits.',
            },
            {
                'id': 'gb50011_frame_column_stirrup_confined_zone_range',
                'clause': 'GB/T 50011-2010(2024) 6.3.9',
                'description': 'Concrete frame-column stirrup confined-zone length should satisfy column-end and full-height confinement requirements when structured data is available.',
            },
            {
                'id': 'gb50011_frame_column_stirrup_volume_ratio',
                'clause': 'GB/T 50011-2010(2024) 6.3.9',
                'description': 'Concrete frame-column stirrup volumetric ratio should satisfy confined-zone characteristic-value, absolute minimum, and non-confined-zone requirements when structured data is available.',
            },
            {
                'id': 'gb50011_frame_joint_core_stirrup_detailing',
                'clause': 'GB/T 50011-2010(2024) 6.3.10',
                'description': 'Concrete frame beam-column joint core stirrup spacing, diameter, characteristic value, and volumetric ratio should satisfy seismic detailing limits when structured data is available.',
            },
            {
                'id': 'gb55002_concrete_frame_member_strength_grade',
                'clause': 'GB 55002-2021 5.1.2',
                'description': 'Concrete frame beams/columns with seismic grade not lower than Grade 2 should use concrete strength grade not lower than C30.',
            },
            {
                'id': 'gb50011_frame_beam_section_geometry',
                'clause': 'GB/T 50011-2010(2024) 6.3.1',
                'description': 'Concrete frame beam section width, depth-to-width ratio, and clear span-to-depth ratio should satisfy seismic detailing geometry limits.',
            },
            {
                'id': 'gb50011_frame_beam_flat_beam_detailing',
                'clause': 'GB/T 50011-2010(2024) 6.3.2',
                'description': 'Concrete frame flat beam width, depth, column-bar relationship, floor arrangement, and Grade 1 restriction should satisfy seismic detailing limits when structured flat-beam data is available.',
            },
            {
                'id': 'gb50011_frame_beam_longitudinal_reinforcement',
                'clause': 'GB/T 50011-2010(2024) 6.3.4',
                'description': 'Concrete frame beam top and bottom continuous longitudinal reinforcement should satisfy seismic detailing limits.',
            },
            {
                'id': 'gb50011_frame_beam_end_longitudinal_ductility',
                'clause': 'GB/T 50011-2010(2024) 6.3.3 + 6.3.4',
                'description': 'Concrete frame beam-end longitudinal reinforcement should satisfy compression-zone, bottom/top area-ratio, and end tension-ratio seismic ductility limits.',
            },
            {
                'id': 'gb50011_frame_beam_through_joint_bar_diameter',
                'clause': 'GB/T 50011-2010(2024) 6.3.4',
                'description': 'Concrete frame beam longitudinal bars passing through an interior column should not exceed one-twentieth of the column dimension in that direction.',
            },
            {
                'id': 'gb50011_frame_beam_stirrup_detailing',
                'clause': 'GB/T 50011-2010(2024) 6.3.3 + 6.3.4',
                'description': 'Concrete frame beam-end confined-zone stirrup length, spacing, diameter, leg spacing, and hook detailing should satisfy seismic limits.',
            },
            {
                'id': 'gb50011_frame_column_section_geometry',
                'clause': 'GB/T 50011-2010(2024) 6.3.5',
                'description': 'Concrete frame column section side dimensions and long-to-short side ratio should satisfy seismic detailing geometry limits.',
            },
            {
                'id': 'gb50011_shear_wall_section_thickness',
                'clause': 'GB/T 50011-2010(2024) 6.4.1',
                'description': 'Concrete seismic-wall thickness should satisfy seismic grade, story-height, and bottom-strengthened-zone limits when structured wall data is available.',
            },
            {
                'id': 'gb50011_shear_wall_axial_compression_ratio',
                'clause': 'GB/T 50011-2010(2024) 6.4',
                'description': 'Concrete seismic-wall axial compression ratio should satisfy a structured project/code-derived limit when axial demand and limit data are available.',
            },
            {
                'id': 'gb50011_shear_wall_distributed_reinforcement',
                'clause': 'GB/T 50011-2010(2024) 6.4.2 + 6.4.3',
                'description': 'Concrete seismic-wall vertical and horizontal distributed reinforcement should satisfy layer, tie, ratio, spacing, and diameter detailing limits when structured wall data is available.',
            },
            {
                'id': 'gb50011_shear_wall_boundary_element_detailing',
                'clause': 'GB/T 50011-2010(2024) 6.4',
                'description': 'Concrete seismic-wall boundary or edge-member longitudinal and transverse detailing should satisfy structured code-derived limits when boundary-element data is available.',
            },
            {
                'id': 'gb50011_steel_member_seismic_detailing',
                'clause': 'GB/T 50011-2010(2024) 8.3 + 8.4',
                'description': 'Steel seismic members should satisfy structured code-derived slenderness and width-thickness detailing limits when comparable data is available.',
            },
        ],
    }

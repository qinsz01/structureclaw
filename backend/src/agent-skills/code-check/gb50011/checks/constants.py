"""GB 50011 code-check constants: limits and lookup tables."""

from __future__ import annotations


GLOBAL_SEISMIC_ELEMENT_ID = '__global_seismic__'
GB50011_2024_CODE_VERSION = 'GB/T 50011-2010(2024)'
FRAME_COLUMN_AXIAL_RATIO_LIMITS = {
    1: 0.65,
    2: 0.75,
    3: 0.85,
    4: 0.90,
}
C30_DESIGN_STRENGTH_MPA = 14.3
C35_DESIGN_STRENGTH_MPA = 16.7
FRAME_COLUMN_STIRRUP_CHARACTERISTIC_VALUE_BINS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.05]
FRAME_COLUMN_STIRRUP_CHARACTERISTIC_VALUES = {
    (1, 'ordinary'): [0.10, 0.11, 0.13, 0.15, 0.17, 0.20, 0.23],
    (1, 'spiral'): [0.08, 0.09, 0.11, 0.13, 0.15, 0.18, 0.21],
    (2, 'ordinary'): [0.08, 0.09, 0.11, 0.13, 0.15, 0.17, 0.19, 0.22, 0.24],
    (2, 'spiral'): [0.06, 0.07, 0.09, 0.11, 0.13, 0.15, 0.17, 0.20, 0.22],
    (3, 'ordinary'): [0.06, 0.07, 0.09, 0.11, 0.13, 0.15, 0.17, 0.20, 0.22],
    (3, 'spiral'): [0.05, 0.06, 0.07, 0.09, 0.11, 0.13, 0.15, 0.18, 0.20],
    (4, 'ordinary'): [0.06, 0.07, 0.09, 0.11, 0.13, 0.15, 0.17, 0.20, 0.22],
    (4, 'spiral'): [0.05, 0.06, 0.07, 0.09, 0.11, 0.13, 0.15, 0.18, 0.20],
}
FRAME_JOINT_CORE_CHARACTERISTIC_MINIMUMS = {
    1: 0.12,
    2: 0.10,
    3: 0.08,
}
FRAME_JOINT_CORE_VOLUME_RATIO_MINIMUMS = {
    1: 0.6,
    2: 0.5,
    3: 0.4,
}
STORY_MINIMUM_SHEAR_COEFFICIENT_SHORT_PERIOD = {
    6: 0.008,
    7: 0.016,
    8: 0.032,
    9: 0.064,
}
STORY_MINIMUM_SHEAR_COEFFICIENT_LONG_PERIOD = {
    6: 0.006,
    7: 0.012,
    8: 0.024,
    9: 0.048,
}
STORY_MINIMUM_SHEAR_COEFFICIENT_HIGH_ACCELERATION = {
    7: (0.024, 0.018),
    8: (0.048, 0.036),
}

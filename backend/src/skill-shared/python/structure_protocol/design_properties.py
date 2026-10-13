"""Typed design inputs and one-way migration of historical extension fields.

Design stresses/moduli are MPa; member design lengths and reinforcement dimensions
are mm, reinforcement areas mm2, and the remaining coefficients dimensionless.
These are declared inputs, never analysis-result overrides.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Optional
from pydantic import BaseModel, ConfigDict, Field, model_validator
from typing import Annotated

PositiveFinite = Annotated[float, Field(gt=0, allow_inf_nan=False)]
NonnegativeFinite = Annotated[float, Field(ge=0, allow_inf_nan=False)]


class MaterialDesign(BaseModel):
    model_config = ConfigDict(extra='forbid')
    f: Optional[PositiveFinite] = None
    fv: Optional[PositiveFinite] = None
    fc: Optional[PositiveFinite] = None
    ft: Optional[PositiveFinite] = None
    ftk: Optional[PositiveFinite] = None
    Ec: Optional[PositiveFinite] = None
    Es: Optional[PositiveFinite] = None
    fy: Optional[PositiveFinite] = None
    fyv: Optional[PositiveFinite] = None
    fy_compression: Optional[PositiveFinite] = None
    ecu: Optional[PositiveFinite] = None
    alpha1: Optional[PositiveFinite] = None
    beta1: Optional[PositiveFinite] = None


class ReinforcementValues(BaseModel):
    model_config = ConfigDict(extra='forbid')
    As: Optional[PositiveFinite] = None
    Asv: Optional[PositiveFinite] = None
    stirrup_dia: Optional[PositiveFinite] = None
    stirrup_spacing: Optional[PositiveFinite] = None
    main_dia: Optional[PositiveFinite] = None
    bar_count: Optional[Annotated[int, Field(gt=0)]] = None
    sn: Optional[NonnegativeFinite] = None
    cover: Optional[NonnegativeFinite] = None
    crack_cover: Optional[NonnegativeFinite] = None


class ReinforcementInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    confirmed: bool = False
    values: ReinforcementValues
    source: Optional[str] = None

    @model_validator(mode='before')
    @classmethod
    def normalize_historical_values(cls, value):
        if not isinstance(value, dict):
            return value
        value = deepcopy(value)
        values = dict(value.get('values') or {})
        for key in ReinforcementValues.model_fields:
            if key in value:
                if key in values and values[key] != value[key]:
                    raise ValueError(f'Reinforcement {key} conflicts with values.{key}')
                values[key] = value.pop(key)
        value['values'] = values
        # Persist an explicit false, including exclude_unset exports: absence
        # of confirmation must never become confirmation at another boundary.
        value.setdefault('confirmed', False)
        return value


class MemberDesign(BaseModel):
    model_config = ConfigDict(extra='forbid')
    l0: Optional[PositiveFinite] = Field(default=None, description='Effective length (mm) / 计算长度')
    h0: Optional[PositiveFinite] = Field(default=None, description='Effective depth (mm) / 有效高度')
    phi: Optional[PositiveFinite] = None
    phi_b: Optional[PositiveFinite] = None
    phi_axial: Optional[PositiveFinite] = None
    beta1: Optional[PositiveFinite] = None
    btLimit: Optional[PositiveFinite] = None
    lambdaLimit: Optional[PositiveFinite] = None
    deflectionLimitN: Optional[PositiveFinite] = Field(default=None, description='Denominator n of L/n')
    axialRatioLimit: Optional[PositiveFinite] = None
    crackWidthLimit: Optional[PositiveFinite] = Field(default=None, description='Crack-width limit (mm)')
    alpha_cr: Optional[PositiveFinite] = None
    serviceability_result_keys: list[str] = Field(default_factory=list, description='Explicit service result keys, e.g. case:S or combination:SLS; no ULS-to-SLS inference')
    reinforcement: Optional[ReinforcementInput] = None


def migrate_design_fields(value: Any, kind: str) -> Any:
    """Move known historical design fields once; contradictions are errors.

Do not migrate fy from material top-level: it is the existing yield-strength field.
Reinforcement is only migrated as a structured record with its confirmation state.
"""
    if not isinstance(value, dict):
        return value
    record = deepcopy(value)
    keys = set((MaterialDesign if kind == 'material' else MemberDesign).model_fields)
    design = record.get('design')
    if design is not None and not isinstance(design, dict):
        return record  # Typed validation supplies the diagnostic.
    design = dict(design or {})
    extra = record.get('extra')
    extra = dict(extra) if isinstance(extra, dict) else {}
    sources = [(record, 'legacy'), (extra, 'extra')]
    nested = extra.get('design')
    if isinstance(nested, dict):
        sources.append((nested, 'extra.design'))
    for source, source_name in sources:
        for key in keys:
            if kind == 'material' and key == 'fy' and source is record:
                continue
            if key not in source:
                continue
            observed = source[key]
            if key in design and design[key] != observed:
                raise ValueError(f"{kind} '{record.get('id')}' design.{key} conflicts with {source_name}.{key}")
            design[key] = observed
            source.pop(key)
    if kind == 'member':
        reinforcement = dict(design.get('reinforcement') or {})
        reinforcement_values = dict(reinforcement.get('values') or {})
        for source, source_name in sources:
            for key in ReinforcementValues.model_fields:
                if key not in source:
                    continue
                if key in reinforcement_values and reinforcement_values[key] != source[key]:
                    raise ValueError(f"Element '{record.get('id')}' reinforcement.{key} conflicts with {source_name}.{key}")
                reinforcement_values[key] = source.pop(key)
        if reinforcement_values:
            reinforcement['values'] = reinforcement_values
            design['reinforcement'] = reinforcement
    if isinstance(extra.get('design'), dict) and not extra['design']:
        extra.pop('design')
    if kind == 'material' and 'G' in extra:
        if 'G' in record and record['G'] != extra['G']:
            raise ValueError(f"Material '{record.get('id')}' G conflicts with extra.G")
        record['G'] = extra.pop('G')
    if 'extra' in record:
        record['extra'] = extra
    if design:
        record['design'] = design
    return record

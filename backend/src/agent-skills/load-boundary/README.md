# Load and Boundary Skills

## 概述 / Overview

> Manifest-first note / 清单优先说明
>
> Builtin load-boundary skills are now defined by `skill.yaml`. Stage Markdown files such as `intent.md`
> are content assets only and no longer provide canonical ids, stages, or routing metadata.
>
> 内置 load-boundary 技能现在以 `skill.yaml` 为唯一静态真源。`intent.md` 等阶段 Markdown
> 仅承载内容，不再定义 canonical id、授权工具、阶段或路由元数据。

该技能负责结构分析中的荷载和边界条件管理,包括:

- **荷载工况 (Load Cases)**: 定义各种荷载类型(恒载、活载、风载、地震等)
- **荷载动作 (Load Actions)**: 在具体构件上施加的具体荷载
- **节点约束 (Nodal Constraints)**: 定义节点的边界条件和支撑
- **杆端释放 (Member End Releases)**: 定义杆件端部的释放条件
- **计算长度 (Effective Lengths)**: 定义杆件的计算长度系数

This skill manages loads and boundary conditions for structural analysis, including:

- **Load Cases**: Define various load types (dead, live, wind, seismic, etc.)
- **Load Actions**: Apply specific loads to individual elements
- **Nodal Constraints**: Define node boundary conditions and supports
- **Member End Releases**: Define release conditions at member ends
- **Effective Lengths**: Define effective length factors for members

---

## 目录结构 / Directory Structure

```
load-boundary/
├── README.md
├── boundary-condition/   # skill.yaml + intent.md
├── crane-load/           # skill.yaml + intent.md
├── dead-load/            # skill.yaml + intent.md
├── live-load/            # skill.yaml + intent.md
├── load-combination/     # skill.yaml + intent.md
├── nodal-constraint/     # skill.yaml
├── seismic-load/         # skill.yaml + intent.md
├── snow-load/            # skill.yaml + intent.md
├── temperature-load/     # skill.yaml + intent.md
└── wind-load/            # skill.yaml + intent.md
```

这些技能目前为 catalog-visible（`discoverable`），不带可执行的 Python 运行时；荷载与边界条件由
结构模型 V2 Schema 与各分析引擎适配器直接处理。早期未接入生产链路的 Python 生成器原型已移除。

These skills are catalog-visible (`discoverable`) and ship no executable Python runtime. Loads and
boundary conditions are carried by the V2 structure model and handled by the analysis engine adapters.
The earlier Python generator prototypes, which were never wired into the production path, have been removed.

---

## V2 Schema 兼容性 / V2 Schema Compatibility

本技能基于 `structure_model_v2.py` 中定义的统一结构分析 JSON Schema:

This skill is based on the unified structural analysis JSON Schema defined in `structure_model_v2.py`:

### LoadCaseV2 (结构_model_v2.py:251-262)

```python
class LoadCaseV2(BaseModel):
    """荷载工况 / Load case — extended types."""
    id: str                                    # 工况ID
    type: Literal[                              # 工况类型
        "dead", "live", "wind", "seismic",
        "temperature", "settlement", "crane",
        "snow", "other",
    ] = "other"
    loads: List[Dict[str, Any]]               # 荷载动作列表
    description: Optional[str]                 # 工况描述
    extra: Dict[str, Any]                     # 扩展字段
```

### NodeV2 (structure_model_v2.py:186-200)

```python
class NodeV2(BaseModel):
    """节点 / Node — same as V1."""
    id: str                                    # 节点ID
    x: float                                  # X坐标
    y: float                                  # Y坐标
    z: float                                  # Z坐标
    restraints: Optional[List[bool]] = Field(  # 约束条件 [ux, uy, uz, rx, ry, rz]
        default=None,
        min_length=6,
        max_length=6,
    )
    story: Optional[str]                      # 所属楼层ID
```

### ElementV2 (structure_model_v2.py:203-215)

```python
class ElementV2(BaseModel):
    """单元 / Element — extended from V1."""
    id: str                                    # 单元ID
    type: Literal[...]                         # 单元类型
    nodes: List[str]                          # 节点列表
    material: str                             # 材料ID
    section: str                              # 截面ID
    story: Optional[str]                      # 所属楼层ID
    releases: Optional[Dict[str, Any]] = Field(  # 端部释放条件
        default=None,
        description="端部释放条件 / end releases",
    )
    extra: Dict[str, Any]
```

---

## TypeScript 类型定义 / TypeScript Type Definitions

后端运行时类型定义位于 `backend/src/agent-runtime/types.ts`:

Backend runtime type definitions are located in `backend/src/agent-runtime/types.ts`:

### 荷载工况类型 / Load Case Types

```typescript
// 荷载工况类型枚举 - 完全对齐 V2 Schema LoadCaseV2.type
export enum LoadCaseTypeEnum {
  DEAD = 'dead',              // 恒载 (对齐 V2 Schema)
  LIVE = 'live',              // 活载 (对齐 V2 Schema)
  WIND = 'wind',              // 风载 (对齐 V2 Schema)
  SEISMIC = 'seismic',        // 地震 (对齐 V2 Schema)
  TEMPERATURE = 'temperature', // 温度 (对齐 V2 Schema)
  SETTLEMENT = 'settlement',  // 沉降 (对齐 V2 Schema)
  CRANE = 'crane',            // 吊车 (对齐 V2 Schema)
  SNOW = 'snow',              // 雪 (对齐 V2 Schema)
  OTHER = 'other',            // 其他 (对齐 V2 Schema)
}

// 荷载动作类型枚举 (5种)
export enum LoadTypeEnum {
  POINT_FORCE = 'point_force',           // 集中力
  DISTRIBUTED_LOAD = 'distributed_load', // 分布荷载
  MOMENT = 'moment',                     // 力矩
  TORQUE = 'torque',                     // 扭矩
  AXIAL_FORCE = 'axial_force',          // 轴向力
}

// 荷载工况接口 - 对齐 V2 Schema LoadCaseV2
export interface LoadCase {
  id: string;                       // 工况ID (对齐 V2 Schema)
  type: LoadCaseTypeEnum;            // 工况类型 (对齐 V2 Schema)
  loads?: LoadAction[];             // 荷载动作列表 (对齐 V2 Schema)
  description?: string;             // 工况描述 (对齐 V2 Schema)
  extra?: Record<string, any>;      // 扩展字段 (对齐 V2 Schema)
}
```

### 荷载动作接口 / Load Action Interface

```typescript
// 荷载动作接口 - V2 Schema 使用 Dict[str, Any]，此处提供具体结构
export interface LoadAction {
  id?: string;                    // 动作ID (可选，V2 Schema 允许任意字段)
  caseId?: string;                // 所属工况ID (可选，V2 Schema 允许任意字段)
  elementType?: LoadElementTypeEnum; // 单元类型 (可选，V2 Schema 允许任意字段)
  elementId?: string;             // 单元ID (可选，V2 Schema 允许任意字段)
  loadType?: LoadTypeEnum;        // 荷载类型 (可选，V2 Schema 允许任意字段)
  loadValue?: number;             // 荷载值 (可选，V2 Schema 允许任意字段)
  loadDirection?: Vector3D;       // 荷载方向向量 (可选)
  position?: Vector3D;            // 作用位置 (可选)
  extra?: Record<string, any>;     // 扩展字段 (对齐 V2 Schema)
}
```

### 节点约束接口 / Nodal Constraint Interface

```typescript
// 节点约束类型枚举
export enum NodalConstraintTypeEnum {
  FIXED = 'fixed',           // 固定支座
  PINNED = 'pinned',       // 铰支座
  SLIDING = 'sliding',      // 滑动支座
  ELASTIC = 'elastic',        // 弹性支座（预留，待 #39 Schema 确认）
}

// 自由度集合接口 (6个自由度)
export interface DOFSet {
  uX: boolean;  // X 轴平动位移
  uY: boolean;  // Y 轴平动位移
  uZ: boolean;  // Z 轴平动位移
  rotX: boolean;  // X 轴转角位移
  rotY: boolean;  // Y 轴转角位移
  rotZ: boolean;  // Z 轴转角位移
}

// 节点约束接口 - V2 Schema 使用 restraints: List[bool]，此处提供扩展定义
export interface NodalConstraint {
  nodeId: string;                // 节点ID
  constraintType?: NodalConstraintTypeEnum; // 约束类型 (可选，V2 Schema 未定义)
  restraints?: [boolean, boolean, boolean, boolean, boolean, boolean]; // 对齐 V2 Schema: [ux, uy, uz, rx, ry, rz]
  restrainedDOFs?: DOFSet;       // 约束的自由度 (可选，与 V2 Schema 格式不同)
  stiffness?: Matrix6x6;         // 弹簧刚度矩阵 (可选，V2 Schema 允许任意字段)
  extra?: Record<string, any>;    // 扩展字段 (对齐 V2 Schema)
}
```

### 杆端释放接口 / Member End Release Interface

```typescript
// 杆端释放接口 - V2 Schema 使用 releases: Dict[str, Any]，此处提供扩展定义
export interface MemberEndRelease {
  memberId: string;              // 杆件ID
  releaseI?: DOFSet;             // I端释放 (可选，V2 Schema 允许任意字段)
  releaseJ?: DOFSet;             // J端释放 (可选，V2 Schema 允许任意字段)
  springStiffnessI?: Vector6D;   // I端弹簧刚度 (可选，V2 Schema 允许任意字段)
  springStiffnessJ?: Vector6D;   // J端弹簧刚度 (可选，V2 Schema 允许任意字段)
  extra?: Record<string, any>;    // 扩展字段 (对齐 V2 Schema)
}
```

### 计算长度接口 / Effective Length Interface

```typescript
// 轴向方向枚举
export enum AxisDirectionEnum {
  STRONG_AXIS = 'strong_axis',    // 强轴
  WEAK_AXIS = 'weak_axis',      // 弱轴
  INCLINED_AXIS = 'inclined_axis' // 斜轴
}

// 计算长度接口 - V2 Schema 未定义，此处提供扩展定义
export interface EffectiveLength {
  memberId: string;              // 杆件ID
  direction?: AxisDirectionEnum; // 方向 (可选)
  calcLength?: number;           // 几何长度 (可选)
  lengthFactor?: number;         // 长度系数 (可选)
  effectiveLength?: number;      // 计算长度 (可选)
  extra?: Record<string, any>;    // 扩展字段 (对齐 V2 Schema)
}
```

---

## 与引擎的映射 / Engine Mapping

V2 Schema 与 OpenSeesPy 和 PKPM API 的映射关系详见:

Mapping between V2 Schema and OpenSeesPy/PKPM API is documented in:

**文件**: `docs/schema/engine-mapping.md`

### 主要映射规则 / Main Mapping Rules:

| V2 字段 / V2 Field | OpenSeesPy | PKPM API |
|-------------------|------------|----------|
| LoadCaseV2.type | loadPattern -type | LCASE 表 |
| NodeV2.restraints | fix 命令 | NODE 表 RESTR 字段 |
| ElementV2.releases | releases 命令 | ELEM 表 REL_I/REL_J 字段 |
| LoadAction | load, eleLoad 命令 | LOAD 表 |

---

## 相关文档 / Related Documentation

- **V2 Schema**: `backend/src/skill-shared/python/structure_protocol/structure_model_v2.py`
- **引擎映射**: `docs/schema/engine-mapping.md`
- **类型定义**: `backend/src/agent-runtime/types.ts`
- **Project Guide**: `AGENTS.md`
- **Issue #48**: https://github.com/structureclaw/structureclaw/issues/48

---

## 贡献指南 / Contributing

遵循项目的提交规范:

Follow the project commit convention:

```
feat(load-boundary): add load case CRUD operations
fix(load-boundary): correct DOF constraint validation
docs(load-boundary): update usage examples
test(load-boundary): add load action verification tests
```

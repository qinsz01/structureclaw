Free-form modelling / 自由建模

Keep engineeringDraft as the physical source of truth, with every load, member assignment and user ID.
Do not reduce it to beam or frame scalar fields. A recognised structure name is never required.
Use topology/model records for explicit geometry. For geometry that must still be generated, keep
the user's complete description in metadata.geometryDescription and supportDescription, alongside
the available dimensions, boundaries and all loads. These descriptions are modelling instructions,
not a substitute for checking the generated physical model. Explicitly unloaded requests may set
metadata.zeroLoads=true. Ask together only for missing geometry/connections, supports, load targets,
and real properties needed by the requested outputs. Known grades and confirmed geometry use the
shared deterministic completion; forces alone may use labelled unit stiffness.

以 engineeringDraft 保存完整物理输入：所有荷载、构件属性分配和用户 ID，禁止压缩成梁或框架的标量。
不要求识别专用结构名称。显式几何用 topology/model；仍需生成的自由几何在 metadata.geometryDescription
保存完整描述，支座描述保存在 supportDescription，同时保留已有尺寸、边界与全部荷载。
描述是建模依据，不能代替生成后的物理校验。明确无外荷载时可设置 metadata.zeroLoads=true。
只将确实缺少的几何连接、支座、荷载目标和所求结果必需的属性一次问齐。已知材料牌号与已确认几何
使用共享确定性补全；仅求内力时可以使用清楚标注的单位刚度。

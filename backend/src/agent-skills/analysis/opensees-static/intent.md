# OpenSees Static Analysis

- `zh`: 当用户明确要求 OpenSees 静力分析、线弹性求解、位移/内力/反力结果时使用。
- `en`: Use when the request explicitly asks for OpenSees static solving or detailed displacement / force / reaction results.
- Runtime: `analysis/opensees-static/runtime.py`
- `zh`: 梁柱弹性弯矩端释放使用 `releases.i/j.ry/rz=true`（局部轴；可用 `releaseI/releaseJ` 别名）。二维只支持当前平面内弯曲，三维支持两个弯曲方向；不支持轴向、剪切、扭转释放或半刚接弹簧。分段只在物理构件端部保留释放，缺刚度的节点转角从结果省略并记录可用性。跨内恢复使用真实端力和两端位移，不能把铰端节点转角零值用于插值。刚性楼板与缺刚度 Rz 耦合尚不支持。
- `en`: Elastic bending releases use `releases.i/j.ry/rz=true` in member-local axes (`releaseI/releaseJ` aliases). Only in-plane bending is active in 2-D; both bending axes are available in 3-D. Axial, shear, torsional and spring releases are unsupported. Refinement retains releases only at physical ends. Undetermined joint rotations are omitted with availability metadata; internal recovery integrates actual end actions using endpoint translations. Rigid-diaphragm coupling of stiffness-null Rz remains unsupported.

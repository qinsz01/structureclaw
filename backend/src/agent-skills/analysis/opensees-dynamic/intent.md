# OpenSees Dynamic Analysis

- `zh`: 适用于模态分析、振型提取、地震波时程响应等需要 OpenSees 动力求解器的场景。
- `en`: Use for modal extraction and time-history response cases that require the OpenSees dynamic solver.
- Runtime: `analysis/opensees-dynamic/runtime.py`
- `zh`: `massSource` 与模型质量来源必须一致，节点质量、构件密度和楼层地震质量不隐式叠加；`massDirections` 为全局平动方向。时程用 `monitorNodeIds`、`monitorElementIds`、`monitorSupportNodeIds` 指定观测对象，节点量相对于均匀运动地基，首个 `timeIndex=0` 对应第一个时间步。端力为不含惯性/阻尼的弹性抵抗力；支座反力由 `reactions('-dynamic')` 返回，包含惯性和 Rayleigh 阻尼。单位为 m、rad、kN、kN·m、s；没有请求的对象不生成零记录。弹性弯曲端释放沿用静力公共装配，不能确定的转角分量省略。
- `en`: `massSource` must agree with the model. Nodal, member-density and seismic-floor mass sources are not silently summed; `massDirections` names global translation axes. Select observations with `monitorNodeIds`, `monitorElementIds` and `monitorSupportNodeIds`. Motion is relative to uniform ground excitation; index zero is the first completed time step. Member end actions are elastic resisting forces excluding damping/inertia, while `reactions('-dynamic')` includes inertia and Rayleigh damping. Units are m, rad, kN, kN.m and s. Unrequested objects have no fabricated zero records. The shared elastic bending-release assembly omits undetermined joint rotations.

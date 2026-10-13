# PKPM Static Analysis

- `zh`: 当用户明确要求使用 PKPM/SATWE 进行结构静力计算、商业引擎复核、设计验算或结果对比时使用。需要本机安装 PKPM，并通过 General Settings / `settings.json` 的 `pkpm.cyclePath` 或环境变量 `PKPM_CYCLE_PATH` 指向 `JWSCYCLE.exe`。
- `en`: Use when the user explicitly asks for PKPM/SATWE structural static analysis, commercial-engine verification, design checks, or result comparison. Requires a local PKPM installation and `pkpm.cyclePath` in General Settings / `settings.json`, or `PKPM_CYCLE_PATH`, pointing to `JWSCYCLE.exe`.
- `zh`: 正式 V2 输入要求的 E/nu/rho 尚无原生校准，当前由 `PKPM_NATIVE_MATERIAL_PROPERTIES_UNVERIFIED` 阻止正式分析。环境探测通过不表示物理映射验收通过。底层牌号/几何编译、授权和结果读取仅作为保留基础，不得宣称300题或自定义刚度已可计算。
- `en`: Required V2 E/nu/rho inputs lack accepted native calibration, so `PKPM_NATIVE_MATERIAL_PROPERTIES_UNVERIFIED` currently blocks formal analysis. A successful environment probe does not establish physical mapping. Grade/geometry compilation, authorization and result readers remain infrastructure, not proof of 300-task or custom-stiffness support.
- Runtime: `analysis/pkpm-static/runtime.py`

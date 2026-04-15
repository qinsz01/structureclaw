# YJK Static Analysis

- `zh`: 当用户要求使用 YJK（盈建科）进行结构静力计算、设计验算时使用。自动将 V2 模型转换为 YJK 格式，启动盈建科软件执行建模、前处理、整体计算，并从 .OUT 文本文件提取分析结果。需要已安装 YJK 8.0 并配置 `YJKS_ROOT` 或 `YJK_PATH` 指向安装根目录（与官方 SDK 示例一致）。
- `en`: Use when the request asks for YJK-based structural static analysis or design checks. Automatically converts V2 model to YJK format, launches YJK for modeling, preprocessing, and full calculation, then extracts results from .OUT text files. Requires YJK 8.0 and `YJKS_ROOT` or `YJK_PATH` pointing to the install root (same convention as the official YJK SDK samples).
- Runtime: `analysis/yjk-static/runtime.py`

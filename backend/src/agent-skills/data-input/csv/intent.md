# Intent — CSV/Excel Structural Parameter Input

This skill covers uploaded CSV/TSV or Excel files with structural parameters. / 本技能用于上传的含结构参数的 CSV/TSV 或 Excel 文件。

1. Call `analyze_file` with the uploaded file path; CSV/TSV returns `{ headers, rows }`, Excel returns `{ sheets }`. / 用上传文件路径调用 `analyze_file`；CSV/TSV 返回 `{ headers, rows }`，Excel 返回 `{ sheets }`。
2. Map the columns by semantic understanding and pass them to `extract_draft_params` as the message text. / 按语义理解列含义，并作为消息文本传给 `extract_draft_params`。
3. Ask about columns whose meaning or unit is unclear; never treat empty cells as zero. / 含义或单位不明的列向用户确认；空单元格不当作零。

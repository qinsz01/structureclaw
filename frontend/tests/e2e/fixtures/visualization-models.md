The two frame JSON inputs are the exact model snapshots saved by the 2026-10-19 visualization audit:

- `visualization-frame2d.json`: 6 nodes, 6 members; SHA-256 `cc2209ba0621675fede45c835502cbdda2962e31f1040b21b93d17e03dedaea7`.
- `visualization-frame3d.json`: 18 nodes, 26 members; SHA-256 `4edc880b42e54a31a1525bd3744406c1d2b20c24ec63eaa4e3eafb603d7213e1`.

Recovered read-only from `latestResult.analysis.modelSnapshot` in the isolated audit database `.tmp/playwright-OOjlQV/data/structureclaw.db`, identified by `G:/StructureClaw-All/viz-audit/server.log`. These fixtures contain model inputs only; new results are calculated by OpenSees for every audit. No benchmark files were accessed or modified. The beam uses the existing `engineering-beam.ts` fixture and its independent 2.5 kN·m reference.

两个框架文件来自 2026-10-19 可视化审计的已保存模型快照，仅包含输入。每次审计都重新调用 OpenSees，不复用历史结果，也不访问或修改 benchmark 文件。梁继续使用现有的 `engineering-beam.ts` 及其独立的 2.5 kN·m 参考值。

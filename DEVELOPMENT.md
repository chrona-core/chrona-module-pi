# pi 开发与离线检查

此仓库拥有应用源码、许可证、构建输入、锁、材料和测试。无已核验远端，仅本地 main。

应用纯逻辑使用 Bun；涉及 kernel、DB、SDK 或其他应用的测试在 Chrona 的锁定组合中执行。Chrona 通过 `bun run applications:restore` 从固定 bundle 与精确 artifact 输入恢复 `packages/engine/src/modules/steward/applications/pi`，不读取同级 checkout。恢复目录与原目录保持相对深度，使既有组合测试继续使用真实 SDK 与临时数据库。

在 Chrona 根运行 `bun run test:bun packages/engine/src/modules/steward/applications/pi/<file>.bun.test.ts`；测试 wrapper、浏览器入口与宿主集成逐文件映射见 Chrona `docs/tasks/cleanup-and-reorg/stage-4-test-mapping.json`。独立纯逻辑测试也可在本仓库 `bun test <file>`，宿主组合测试不在此承诺独立运行。

修改后先运行适用检查并提交本地 main，再更新 Chrona 的固定 bundle、artifact 输入与 lock。Git bundle 不含 chrona-material.json 声明的 artifact；主仓库同时固定其精确字节与 executable mode，恢复必须通过完整材料校验。不得仅改 checkout 而跳过输入更新。

发行/暂停政策由 Chrona 声明；本仓库存在不表示自动运行或发行。Remind 仍暂停。

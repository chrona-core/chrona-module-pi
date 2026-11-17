# pi 源码与检查

本仓库维护应用源码及应用私有测试。Chrona 主仓只提供通用 kernel、宿主、CLI、SDK 与合同；不再保存应用源码、应用共享业务包或固定应用副本。应用间组合测试放在拥有者的 `integration/`，使用同级 `chrona-module-*` checkout；通用 kernel/宿主测试依赖使用同级 `Chrona/` checkout。这些路径用于开发组合，不是自动安装或运行应用的入口。

`adapter/` 保留 Pi RPC、completion、transcript、会话恢复、扩展资源和测试的唯一源码；`@chrona/pi` 是本仓自有 adapter 产生的私有运行/类型制品。`build.ts`、`dependencies.ts`、`declaration-bundle.ts` 在应用内构建 runtime、测试及 vendor，并按真实输出计算材料记录；它们只复用同级 Chrona 的通用合同与已安装通用构建依赖，不调用主仓应用生成器。`bun build.ts` 是应用自有打包入口。构建前须在授权环境准备 TypeScript、Zod 及 Chrona 通用依赖；本轮没有安装。

`host.ts` 从应用私有数据目录的 `pi-host.json` 读取启动配置。设置绝对 `command`；`agentUrl` 默认由通用宿主提供的无凭据 origin `CHRONA_KERNEL_URL` 加 `/api/steward-agent`，也可在该文件显式指定；可设置 `agentDir`、`expectedVersion`、`model`、`resourcesFile`、`webExtension`、`browserExtension`、`workspaceRoot`。Chrona/浏览器扩展默认取本应用 `adapter/resources/`，`processHelper` 默认取通用宿主给出的 `CHRONA_PROCESS_HELPER`。可选 `environment` 只接收 `PI_MODEL_ENVIRONMENT_KEYS` 列出的 Pi 模型环境；包含凭据时此文件须由运行用户私有保存。配置文件应为 mode 600，不写入源码或日志。启动通过普通 ModuleEntry/sandbox；generation 与后代停止回执复用通用宿主能力。

`adapter/src/transcript-redaction.ts` 私有实现 transcript 截断前脱敏，复用通用日志文本脱敏原语；测试也归本应用。

本轮仅迁移/编辑源码并做文件、导入、JSON 与 diff 静态检查；没有构建、编译、测试、lint、typecheck、安装、模型/服务调用、提交或推送。`vendor/`、既有运行/浏览器制品、`bun.lock`、`chrona-material.json`、材料 hash/pin 未因本轮源码修改而重算，旧制品不能证明这些修改已生效。后续发行须在授权构建后生成真实制品、锁与材料记录。

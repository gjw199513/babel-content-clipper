# Babel Content Clipper 实施记录

开始日期：2026-09-19。依据 `docs/specs/` 内保存的 PRD 与确认版 Spec；发生差异时，以 Spec 最新决定为准。

## 分工与写入边界

| 负责人 | 模型 | 交付范围 |
|---|---|---|
| 主 Agent | 当前模型 | 整体规划、共享接口协调、构建与打包、安装文档、一次性提醒逻辑、集成与验收核对 |
| core_domain | Sol Max | `packages/core`、`tests/core`：契约、范围、IndexedDB、状态、幂等、历史与清理；随后接手扩展界面及采集、录制恢复等可靠性修复 |
| mcp_bridge | Terra Max | `packages/mcp`、`tests/mcp`：标准 MCP、本地桥、安装与诊断 |
| extension_browser | Luna Max | 扩展初版与 Hallmark 界面；后续专注隔离 Chromium 的原生交互、真实 Native Messaging、录制与恢复验收 |
| browser_library | Luna Max | 独立 headless profile 的粘贴导入、共享视图、备份恢复与清理回归，以及可独立启动的 Playwright 配置 |
| release_install | Terra Max | 独立安装目录的运行时依赖检查、安装包消费，以及通过已安装 CLI 完成首次 MCP 处理闭环 |

各模块在共享目录并行工作，禁止覆盖其他负责人的文件。接口变化先通知依赖方。

## 实施顺序

1. 建立独立 TypeScript 工程，确定共享数据和 RPC 契约。
2. 实现扩展采集/存储/管理与本地 MCP，跑通采集→查询→领取→回写。
3. 补全图文、媒体、现场保存、提醒、导入导出与恢复。
4. 运行领域和通信测试、类型与 LSP 校验、Luna 的浏览器实测。
5. 构建可安装包、验证本地安装路径、记录兼容矩阵与仍需发布前落实的项。

## 共用边界

- 扩展 IndexedDB 是唯一业务主库；桥不维护另一份业务记录。
- RPC 请求：`{v:1,id,method,params,profileId?}`；响应：`{v:1,id,ok,result?|error:{code,message,details?}}`；事件：`{v:1,event,profileId,payload?}`。
- 核心服务：`createClipperService(options).handle(method, params, context?)`；浏览器侧回写成功须等待事务结束。
- 四状态：`pending`、`processing`、`completed`、`failed`；`inbox/saved` 是独立设置。
- 浏览器操作只由 Luna Max 执行；其他 Agent 运行源码和非浏览器检查。
- 测试浏览器使用独立 profile 和 `--mute-audio`，测试媒体元素默认静音；生成的媒体只做文件检查，不自动播放。此约束不取消产品由用户明确开启的音画采集能力。
- 发布使用方向为个人非商业可用、商用另行授权。正式许可条款后置，开发期间不发布 npm、不 Push、不创建远程仓库。

## 验证状态

本地首版功能实现与所列验收已完成：17 个测试文件的 76 项核心/集成测试通过，71 个 TypeScript 文件的 LSP 检查零错误、零警告；静音浏览器、真实五站、Native Messaging、SDK/Inspector、清理及最新现场录制分别有证据。具体测试范围与保留的限制见 [验收覆盖](acceptance.md)，不将部分页面成功外推为整站兼容。

最终发行物由完整构建、包校验、干净目录安装和 SHA-256/源码清单检查生成；构建消费事实单列在 `artifacts/validation/release-validation.json`。`v0.1.0-alpha.1` 的扩展 ZIP 与 MCP tgz 已作为 GitHub 预发布附件公开，未发布 npm 包。正式许可文本继续按用户要求后置。

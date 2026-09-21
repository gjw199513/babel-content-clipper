# 第三方组件

下列信息从本次锁定安装的 package.json 与包内许可文件读取。项目自身的个人非商业使用方向不改变第三方组件的许可条件。具体依赖版本以 package-lock.json 为准。

| 组件 | 锁定版本 | 包声明许可 | 用途 |
|---|---|---|---|
| @modelcontextprotocol/sdk | 1.30.0 | MIT | 标准 MCP stdio 服务与测试客户端 |
| DOMPurify | 3.4.15 | MPL-2.0 OR Apache-2.0 | 选中 HTML 的安全清理 |
| idb | 8.0.3 | ISC | IndexedDB 事务接口 |
| Zod | 4.6.5 | MIT | 业务参数校验 |

构建和测试工具包括 TypeScript、typescript-language-server、esbuild、Vitest、Playwright、fake-indexeddb 与 fflate。

## Agent 指南中提到但 Clipper 不分发的组件

`docs/agent-guides/video-text-extraction.md` 建议 Agent 可使用 `@huggingface/hub@2.17.4`（MIT）、`sherpa-onnx-node@1.13.8`（Apache-2.0）、yt-dlp（Unlicense）和 Agent 自备的 FFmpeg。它们不是 Babel Content Clipper 的直接依赖，不进入 Clipper MCP npm 包，不由 Clipper MCP 安装、下载或执行。Agent 也可以选择等价工具，并自行承担安装、平台支持与许可核对。

指南固定引用 `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` 的 revision `2365baeacb507f821a0c8120fcee3d484dba7a07`。模型不进入仓库、扩展或 npm 包；实际下载由 Agent 执行。该模型仓库的 `LICENSE` 指向 FunASR 模型许可，下载与使用者须遵守其中的署名、模型名称和其他条件。`hf-mirror.com` 仅是连接失败时的传输替代端点，不改变文件来源、revision、哈希或许可。

构建保留直接依赖的法律注释，扩展发行包内附上打包组件的许可原文。Agent 若另外下载模型、yt-dlp、FFmpeg 或 ASR 包，应按实际选择和分发方式单独完成许可审核；本表不替代正式法律审核。

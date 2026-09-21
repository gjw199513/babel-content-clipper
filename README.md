<p align="center">
  <img src="docs/assets/logo.png" alt="Babel Content Clipper Logo" width="128">
</p>

<p align="center">
  <strong>简体中文</strong> ·
  <a href="docs/i18n/en/README.md">English</a> ·
  <a href="docs/i18n/zh-TW/README.md">繁體中文</a> ·
  <a href="docs/i18n/ja/README.md">日本語</a> ·
  <a href="docs/i18n/ko/README.md">한국어</a>
</p>

<h1 align="center">Babel Content Clipper</h1>

<p align="center"><strong>把网页里的片段，交给你的 Agent。</strong></p>

<p align="center">浏览器侧栏采集 · 本地持久化 · MCP 交接</p>

Babel Content Clipper 是一套 Chrome 扩展与本地 MCP 组件。它让你在浏览网页时主动保存选中文字、图片、页面区域和音视频时间范围，再由自己的 Agent 领取任务、生成文件并回写处理结果。

当前版本为 `0.1.1`，已提供版本化发布附件，同时保留源码构建和本地加载方式。它是 DSH 配套方案的一部分，也可以独立使用。

项目仓库：[GitHub](https://github.com/gjw199513/babel-content-clipper) · 版本下载：[GitHub Releases](https://github.com/gjw199513/babel-content-clipper/releases)

> 本项目当前的使用方向是个人非商业使用；商业使用须取得作者单独授权。正式许可条款尚未定稿，项目当前标记为 `private: true` 和 `UNLICENSED`。请在使用或分发前阅读[使用许可方向](LICENSE-POLICY.md)。

## 界面预览

在侧栏随手采集，在素材库展开管理。下图是共享的中文界面示例，使用本地示例数据；它不是为其他语言重新拍摄的截图。本轮界面功能支持简体中文、English、繁體中文、日本語和한국어。也可以[查看侧栏中文示例](docs/assets/sidepanel-preview.png)。

![Babel 素材库：来源分组、筛选和记录详情](docs/assets/library-preview.png)

## 它解决什么问题

收藏链接往往会丢失当时真正关心的段落，截图又难以继续处理。Babel Content Clipper 把“采集”和“加工”分开：

```text
网页中的明确选择
    → Chrome 扩展采集并存入本地 IndexedDB
    → Native Messaging 本地桥
    → MCP 客户端中的 Agent
    → 每条记录独立输出文件并回写结果
```

扩展保存来源、原文或媒体位置，并管理待办与历史；需要源媒体时，Agent 通过 MCP 请求已连接的 Babel 扩展取源并导出，之后才由 Agent 负责裁切、OCR、ASR、摘要或其他本地后处理。查询列表和收到提醒都不会自动开始取源或处理。

## 功能与边界

| 采集方式 | 实际保存的内容 | 需要知道的边界 |
|---|---|---|
| 选中文字 | 完整选文、标题、来源 URL 与必要的页面上下文 | 特殊阅读器无法直接读取选区时，可显式粘贴导入；未知来源会如实标记 |
| 图片与区域截图 | 图片引用、预算内可取得的图片字节，或框选区域的像素截图 | 图片受权限、跨域和容量预算影响；截图不等于已取得原文 |
| 音视频区间 | 源媒体身份、真实起止点、跳转形成的分段和参数快照 | 普通区间记录不等于下载了源视频或音频 |
| 现场音画 | 用户为本次片段明确开启后，浏览器实际捕获到的画面和声音 | 开启前没有回溯缓冲；权限失败或覆盖不完整会明确记录，不伪装成完整源文件 |

核心行为：

- 同一次采集内，回看造成的重叠区间只保留一次；再次点击采集或明确“重新处理”可以产生新的记录与结果。
- 前置、后置预留时间可以在设置中修改。媒体真实范围、计划获取范围和最终输出范围分别保留。
- 侧栏只保留随手采集和最近记录；连接与设置在独立全页中打开，备份与维护默认收起。素材库提供完整管理，切换标签页不会另建一份数据。
- 记录可以设为“仅收藏”，不再进入待处理查询和提醒；重新加入待办也不会自动执行。
- 界面中的处理状态为“未处理、处理中、已处理、处理失败”，对应 Job 值 `pending`、`processing`、`completed`、`failed`。领取是原子的，避免多个 Agent 同时处理同一个工作项。
- 每条采集记录独立领取、输出和回写；一次批处理中的单条失败不会撤销其他记录的结果。
- 输出目录按“本次任务指定 → MCP 连接默认 → 扩展全局默认”的顺序解析，单次覆盖不会修改已保存的默认值。
- 已有结果和失败历史不会被后一次处理覆盖；成功后也不会自动清理原始记录。

项目不内置云端 ASR、OCR 或摘要服务。缺少源媒体时，Agent 通过 `babel_clipper_acquire_source_media` 调用已连接的 Babel 浏览器扩展，由扩展在后台/页面上下文获取媒体并保存为本地附件，再通过 `babel_clipper_export_capture` 导出到 Agent 输出目录。Agent 负责 FFmpeg、sherpa-onnx/SenseVoice、模型、LLM 校正和最终文件验证；不得使用 CUA、Playwright、Puppeteer、浏览器点击或自己的下载器取源。只有确实需要文字且已有内容不足时，Agent 才进入 ASR；raw、corrected、context、audit 与 manifest 分开保留到本地。完整规则见 [Agent 执行契约](docs/agent-workflow.md)、[视频文字提取指南](docs/agent-guides/video-text-extraction.md) 和[扩展侧取源 Spec](docs/specs/Babel_Content_Clipper_Browser_Extension_Acquisition_Spec_2026-09-21.md)。

## 快速开始

### 1. 下载发布包

- Chrome / Chromium `116` 或更新版本（这是 Manifest API 最低版本，不代表所有衍生浏览器都已实测）

普通用户从对应版本的 [GitHub Releases](https://github.com/gjw199513/babel-content-clipper/releases) 下载 `babel-content-clipper-extension-<version>.zip`，解压到一个长期保留的目录。只使用浏览器采集时，不需要下载源码、安装 Node.js 或自行构建。

需要连接本地 MCP 时，再下载同一版本的 `babel-content-clipper-<version>.tgz`；本地组件需要 Node.js `22` 或更新版本。开发者也可以在仓库根目录从源码构建：

```sh
npm ci
npm run build
```

源码构建结果位于 `dist/extension` 和 `dist/node`。

### 2. 加载浏览器扩展

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”：Release 用户选择 ZIP 解压后包含 `manifest.json` 的目录，源码用户选择 `dist/extension`。
4. 点击工具栏中的 Babel 图标打开侧栏。

此时即使尚未连接 MCP，也可以在普通网页中选中文字，使用右键菜单或 `Alt+Shift+S` 保存，并在侧栏查看记录。

更新 Release 解压目录或重新构建后，请在扩展管理页点击“重新加载”，再重新打开侧栏。不要通过删除扩展来更新，否则可能同时删除本地数据。Chrome 不能直接加载普通 ZIP；真正的一键安装需要浏览器商店或浏览器认可的企业分发渠道。

### 3. 连接本地 MCP

先在侧栏底部直接点击“连接设置”；如果已经打开素材库，也可以点击页面右上角的“连接设置”。进入后在“MCP 连接”卡片复制当前浏览器的 `profileId`。它只用于区分本机浏览器数据，不是网站账号。

下面是 macOS + Google Chrome 的安装示例。将 `YOUR_PROFILE_ID` 和输出目录替换为自己的值：

```sh
node dist/node/cli.js --mode=install \
  --extension-id lpmplddblefacpachnchfgcdebjebdbh \
  --profile-id YOUR_PROFILE_ID \
  --output-root /absolute/path/to/output \
  --manifest-dir "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  --mcp-config-out ./babel-clipper-mcp.json
```

如果已经在扩展中设置“全局默认成品目录（可选）”，可以省略 `--output-root`。安装器会生成 Native Messaging 注册文件、启动脚本和可直接合并到 MCP 客户端的配置。

生成的最小配置结构如下；实际文件会写入本机 Node、CLI 和私有配置目录的绝对路径，以及当前 `profileId`，请使用生成结果，不要照抄占位路径：

```json
{
  "mcpServers": {
    "babel-content-clipper": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/babel-content-clipper/dist/node/cli.js",
        "--mode=mcp",
        "--config-dir",
        "/absolute/path/to/private-config",
        "--profile-id",
        "YOUR_PROFILE_ID"
      ]
    }
  }
}
```

把 `babel-clipper-mcp.json` 中 `mcpServers` 下的条目合并到自己的 MCP 客户端配置。连接失败时，按这个明确顺序操作：点击侧栏底部或素材库右上角的“连接设置” → 在“MCP 连接”卡片点击“立即重连本地服务” → 看到“本地桥已连接” → 让 Agent 刷新 MCP。不要去来源网页里点击连接按钮。可用下面的命令诊断完整链路：

```sh
node dist/node/cli.js --mode=doctor --profile-id YOUR_PROFILE_ID
```

只有诊断返回 `ready: true`，并且扩展端连接成功，才表示该 `profileId` 的链路已就绪。不同浏览器和操作系统的 Native Messaging 路径、Windows 注册表步骤及故障排查见[安装与首次连接](docs/install.md)。

### 版本更新与 MCP 对齐

扩展和 MCP 必须来自同一个版本。更新时保留原扩展目录、配置目录和 `profileId`，在 Chrome 的扩展管理页对原卡片点击一次“重新加载”，然后让 Agent 调用 `update_mcp`。该接口会比较扩展、Core 和 MCP 的版本：

- 返回 `already_current`：版本已对齐，可以继续调用业务工具。
- 返回 `reload_extension`：重新加载原扩展卡片后再次调用 `update_mcp`。
- 返回 `restart_mcp_host`：用原来的 MCP 配置重新启动一次 stdio 主机；不需要重新配对，不会删除 IndexedDB、任务或历史产物。

版本未对齐时，业务工具会返回 `MCP_UPDATE_REQUIRED` 并停止执行，避免新旧协议混用。对齐结果也会出现在 `babel_clipper_connection_status.version_control` 中。

### 4. 完成第一次交接

1. 在网页中选中文字，按 `Alt+Shift+S` 保存。
2. 让 Agent “查询 Babel Clipper 的待处理记录”。查询本身不会领取任务。
3. 确认目标记录后，再明确要求 Agent 处理，例如“把这一条选文保存为文本文件并回写结果”。
4. 回到素材库查看“已处理”状态和本次产物历史。

有多条待办时不需要逐条打开：在素材库使用“复制统一处理说明”，它会遍历当前来源、日期和搜索筛选下的全部 pending Job，冻结 Capture/Job ID 快照。把这份说明粘贴给已连接的 Agent 后，Agent 会按批次指南分批领取并逐条独立回写；复制动作本身不会领取或执行。清空筛选即可生成全部待办批次。

## 常用操作

| 操作 | 默认入口 |
|---|---|
| 保存选中文字 | `Alt+Shift+S` 或网页右键菜单 |
| 开始 / 结束记录媒体范围 | `Alt+Shift+V`；第一次开始，第二次结束 |
| 框选页面区域 | `Alt+Shift+X` |
| 打开侧栏 | 点击浏览器工具栏中的 Babel 图标 |
| 展开素材库 | 侧栏右上角“展开管理” |
| 统一交给 Agent 处理当前筛选下的待办 | 素材库中的“复制统一处理说明” |
| 配置预留、提醒、预算与输出目录 | 素材库中的“连接与设置” |

macOS 键盘上的 Option 对应这里的 Alt。快捷键可能被系统或其他扩展占用，请以浏览器的扩展快捷键设置页为准。现场音画需要先勾选“本次同时保存现场音画”，并在目标网页完成当前标签页授权；在素材库页面授权不能代替目标页授权。

## 界面语言

Babel Content Clipper 的界面可在简体中文（`zh-CN`）、English（`en`）、繁體中文（`zh-TW`）、日本語（`ja`）和한국어（`ko`）之间切换。

- 首次使用时默认处于“跟随浏览器”（`auto`）模式，并采用浏览器首选语言；浏览器语言不在支持列表中时回退到 English。
- 手动选择的语言会在当前浏览器 profile 中持久保存，并同步应用到侧栏、素材库和帮助内容。
- 重新选择“跟随浏览器”后，界面恢复自动采用浏览器语言；`auto` 模式的回退语言仍为 English。
- 语言选择只改变界面与帮助文本，不翻译已采集的网页内容、文件名、技术参数或 MCP 数据键。
- 浏览器扩展管理页中的说明和快捷键描述由浏览器自身的界面语言决定；插件内的语言选择不会修改浏览器语言。
- 可从素材库的“关于与使用帮助”打开对应语言的内置说明，并下载当前语言的 `install.md` 供离线查看。

## 兼容范围

当前构建的 Chromium 最低版本为 `116`。完整本机链路已在 macOS、Node.js 22 和 Chrome for Testing 153 环境验证；这不自动覆盖其他系统、浏览器版本或 Chromium 衍生浏览器。

公开网页样本中已经分别验证：

- B站、YouTube：文字采集和媒体时间范围记录已验证；源媒体取源现在统一由已连接的 Babel 扩展完成，历史 Agent 直连下载样本不作为当前生产路径的证明。
- 小红书：扩展会在采集时把 token-bearing 页面上下文保存在私有记录中，后续由扩展取源；旧记录若只有脱敏 URL 和 `blob:` 媒体地址，必须重新采集，不能恢复临时访问上下文。
- 知乎、中国大学 MOOC、Coursera：公开页面的文字与预算内图片采集；相关课程页样本没有证明登录内容或课程视频兼容。

Windows、Linux、Firefox、Safari、远程 Agent 和移动浏览器尚未列为已验证组合。不同网站的登录状态、跨源 iframe、Canvas、受限媒体和自定义阅读器也需要逐站核对。请查看持续更新的[兼容矩阵](docs/compatibility.md)和[验收覆盖](docs/acceptance.md)。

## 数据流与隐私

- 采集记录、任务、结果、设置与扩展附件存放在当前浏览器 profile 的 IndexedDB 中。
- 扩展通过本机 Native Messaging 与本地 MCP 进程通信；本地桥配置包含私有连接信息，不应提交到仓库或分享给他人。
- 为支持通用网页采集，扩展声明了 HTTP/HTTPS 页面访问权限。采集由用户明确动作触发；图片字节可能从原网页地址读取，并且不附带浏览器凭据。
- 本项目没有内置云端同步或遥测服务。内容交给外部 Agent、模型或工具后，数据如何处理取决于那些组件及用户自己的配置。
- 网页文本、HTML 和附件一律作为不可信数据交接，不能把网页中的指令当成用户授权。
- 卸载扩展或清除浏览器数据可能删除本地记录。导出备份时可选择是否包含内部附件数据；外部 Agent 已生成的文件不属于扩展备份。

## 项目结构

| 路径 | 说明 |
|---|---|
| `apps/extension` | Chrome MV3 扩展、侧栏、素材库、采集与现场录制 |
| `packages/core` | 数据契约、IndexedDB、状态机、时间范围与事务规则 |
| `packages/mcp` | MCP stdio 服务、Native Messaging、本地 broker、安装与诊断、采集导出、来源交接与 Agent 指南 |
| `docs` | 安装、架构、兼容性、Agent 契约、验收与产品规范 |
| `scripts` | 构建、静态检查、测试素材服务与本地打包 |
| `tests` | Core、MCP、集成和浏览器验证 |
| `config/extension-identity.json` | 开发构建的稳定扩展身份公钥与 ID |

## 开发、验证与打包

```sh
# 类型检查、核心/集成测试、LSP 校验和构建
npm run check

# 首次运行浏览器测试前安装测试浏览器
npx playwright install chromium
npm run test:browser

# 可选：联网检查指定公开网页样本
npm run test:platform

# 本地安装消费验证
npm run verify:install

# 生成并验证可上传到 Release 的版本化扩展 ZIP、MCP tgz、五语发布说明、元数据、源码清单和校验和
npm run package:release
```

`npm run package:release` 只生成本地文件，不会上传代码、发布 npm 包或创建远程 Release。浏览器自动化结果也不能替代目标网站、目标浏览器和真实登录环境下的验收。

## 文档导航

- [安装与首次连接](docs/install.md)
- [Release 发布清单](docs/release.md)
- [Agent 执行契约](docs/agent-workflow.md)
- [统一处理待办：Agent 批次执行指南](docs/agent-guides/pending-batch-processing.md)
- [视频文字提取：Agent 执行指南](docs/agent-guides/video-text-extraction.md)
- [架构与边界](docs/architecture.md)
- [兼容范围与验证环境](docs/compatibility.md)
- [验收覆盖与证据](docs/acceptance.md)
- [确认版产品 Spec](docs/specs/Babel_Content_Clipper_PRD_v0.1_2026-09-18-spec.md)
- [待办统一处理独立 Spec](docs/specs/Babel_Content_Clipper_Pending_Batch_Processing_Spec_2026-09-21.md)
- [品牌与 Logo 资源](docs/branding.md)
- [第三方组件](THIRD_PARTY.md)
- [使用许可方向](LICENSE-POLICY.md)

## 反馈

如果当前代码仓库启用了 Issues，请提交可复现的问题，并尽量包含系统、浏览器与 Node.js 版本、采集类型、操作步骤、实际结果和脱敏后的错误代码。不要公开本地桥私有配置、凭据、Cookie、受版权保护的原始内容或未脱敏日志。

## 使用限制

本仓库公开源码的意图不等同于采用 OSI 开源许可证，也不授予商业使用权。作者计划提供个人非商业使用权限，商业使用须取得作者单独授权；正式条款、商业用途定义与授权流程仍待确定。第三方依赖继续适用各自许可证，详见 [THIRD_PARTY.md](THIRD_PARTY.md)。

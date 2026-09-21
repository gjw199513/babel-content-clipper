# 兼容范围与验证环境

本页随验收证据更新。相同的交互入口不代表所有网站已适配。具体验收动作见 [验收覆盖](acceptance.md)。

本次本机验证环境：macOS 26.5.1（25F80）、Node.js 22.22.0、npm 10.9.4、FFmpeg/ffprobe 8.0.1。旧的 Agent 取源参考还使用过 yt-dlp 2025.11.12，但它不属于当前 Clipper 生产取源路径。环境版本用于复现，不表示其他版本无法使用。

## 已有验证

| 层次 | 环境 | 证据与范围 |
|---|---|---|
| 领域存储 | TypeScript、fake-indexeddb | 并发、幂等、四状态、历史、范围、清理、备份和分块测试；不是浏览器重启证明。 |
| 外部媒体处理 | macOS，FFmpeg / ffprobe | 30 秒自生成音画素材实际裁切为 padded 6 秒及 original 2 秒 H.264/AAC，获取范围保持 8—14 秒、真实输出 10—12 秒；结果回写和旧结果保留。这不是网页取源兼容证明。 |
| 独立本地组件安装 | macOS，Node.js 22.22.0，npm 10.9.4 | 从本地 tgz 安装至干净消费目录，仅运行时依赖，生成 Native Host 和 MCP 配置；随后用包内扩展、包内 CLI 和全新 CFT profile 完成 B站文字采集、SDK 处理回写及 Inspector 读回。 |
| 标准 MCP 协议 | 官方 SDK 1.30.0、Inspector CLI 2.7.0 | 两种客户端的 stdio 工具发现与隔离模拟扩展查询通过；这项证据本身不代表真实浏览器数据库读写通过。 |
| 图片字节边界 | Node.js Response/ReadableStream | 校验 MIME、空响应、声明大小、流式大小上限和超时；网站权限与登录限制需浏览器另测。 |
| 扩展侧媒体取源协议 | Babel 扩展后台、页面上下文、Native Messaging/broker、Core 分块附件 | `capture.acquireMedia` 只接受有效 claim，并由已连接扩展在后台或原始页面上下文取流；私有 URL、Cookie 和页面访问过程不返回给 Agent。消息协议测试、Core 附件分块测试和 MCP stdio 测试覆盖私有边界、顺序/幂等和工具路由；真实页面取流的登录态、过期签名和 DRM 仍需逐站实测。 |
| Agent 后台媒体取源历史参考 | 本机历史验证脚本、yt-dlp、FFmpeg/ffprobe | YouTube 与 B 站曾有直连取源样本，小红书曾验证 token-bearing 上下文解析；这些证据只说明旧参考脚本可执行，不是当前 Clipper 生产路径，也不授权 Agent 绕过 Babel 扩展。 |
| Agent 可选本地 ASR 参考 | macOS arm64、Node.js 22.22.0、sherpa-onnx-node 1.13.8、SenseVoice Small INT8、CPU | Agent 侧原型从 Hugging Face 固定 revision 真实下载 239,233,841 B 模型并核对 4 个文件的大小/SHA-256；5.592 秒中文 WAV 在 0.841 秒内完成识别，并生成本地 raw/context/corrected/audit 文件。该样本只验证指南在本机可执行，不代表 Clipper MCP 捆绑或运行这些依赖，也不代表其他平台、语言、口音、噪声或长视频已通过。 |
| 真实 Native Messaging 与 MCP | macOS 26.5.1、Chrome for Testing 153.0.8010.12、SDK 1.30.0、Inspector CLI 2.7.0 | 隔离浏览器实际采集后，两种 stdio 客户端可读取同一主库；完成文本文件生成、回写 ACK、UI 历史回显，两个客户端并发领取只允许一个成功，重新处理保留旧结果与文件。 |
| 静音浏览器回归 | 独立 Chromium profile，Playwright 1.63.0 | 原 10 项通过；最新受影响采集 3 项、新增组织/阅读器 6 项分别通过。覆盖图文/PNG、媒体范围、显式粘贴、共享视图、备份、按来源清理、收藏与真实提醒，以及清空/换章/Canvas/404 图片/图片预算/受限页面。现场录制失败路径不算作音画录制成功。 |
| 重启与重载恢复 | 同一隔离 CFT profile | 重启保留采集记录和 completed 历史并重连 Native；扩展重载清除已终态 Capture 的残留临时状态和假等待提示，不补造结束点击。 |

## 真实网站样本

以下为 2026-09-19 的公开页面实测，使用隔离 profile，全程静音、未登录。网页访问、正文采集与媒体播放分别判断；单个页面通过不代表整站所有内容均可访问。

2026-09-21 的历史后台取源实测由本机 Agent/验证脚本执行，成功产物保存在 `artifacts/validation/platform-captures/20260921/`；这些产物保留作兼容性参考，不作为当前生产取源的执行路径。当前 Clipper MCP 不把私有来源上下文交给 Agent，而是把有效 claim 转交给已连接的 Babel 扩展；扩展取得附件后，Agent 再通过 `babel_clipper_export_capture` 导出到本地。小红书历史记录缺少采集时的临时访问上下文，因此只保留取源契约和元数据解析证据，不冒充该历史记录已下载成功。

| 平台与样本 | 已核对的结果 | 尚未由该样本证明的能力 |
|---|---|---|
| [B站公开视频页](https://www.bilibili.com/video/BV1Zaen66Ec2/) | HTTP 200；真实快捷键采集文字并完成 MCP 文件回写；同一媒体命令完成开始、跳转、结束，真实区间保留为两段，关源页后仍可读回。另有历史 Agent 直连取源样本，但当前生产流程要求由 Babel 扩展取源。 | 未授权会话的后台请求返回 HTTP 412；播放器本身提供 blob 媒体定位，不能把位置记录当成已取得源文件。扩展侧取源需在当前页面仍可访问且签名有效时单独验收。不同账号、地区和受限视频仍需逐项核对。 |
| [YouTube《Me at the zoo》](https://www.youtube.com/watch?v=jNQXAC9IVRw) 与 [长视频录制样本](https://www.youtube.com/watch?v=u8PGSCmXjNw) | HTTP 200；真实快捷键采集标题、普通媒体起止/跳转分段与关页后读回通过。另在长视频上显式录得 3.29 MB 现场音画，真实结束点与尾段分离，分块和双轨可读，全程静音；另有历史 Agent 直连取源样本。当前生产流程要求由 Babel 扩展取源后再导出。 | 现场录制属于 `browser_recording`，不等同于取得源文件；扩展侧取源、登录后、付费及 DRM 内容仍需单独验证。原录制 WebM 的一条 Opus 解析警告保留，见验收记录。 |
| [小红书用户样本](https://www.xiaohongshu.com/explore/6aaa15de0000000028003fa2?xsec_source=pc_feed) | 扩展现在把采集时的 token-bearing 页面上下文和 `blob:` 媒体定位放在私有、claim-bound 存储中；有效 Job 由扩展后台或原始页面上下文取流，再由 Agent 导出。历史 `yt-dlp` 解析结果只作为问题定位参考。 | 用户提供的历史 Capture 没有保存该上下文，脱敏 URL 加 `blob:` 地址无法恢复，因此该历史 Job 已明确失败；重新采集后才能完成该条新 Job 的扩展侧真实文件取源验收。 |
| [知乎公开专栏文章](https://zhuanlan.zhihu.com/p/2045779736064947960) | HTTP 200；5,228 字符与实际选区逐字一致，来源/详情/SHA-256 已核对；12 张图保留引用，8 个附件实际字节、MIME 和摘要通过，超出数量预算显示部分保存。 | 不称全部图片均已保存；回答页或需登录内容未验证。 |
| [中国大学 MOOC《大学计算机》](https://www.icourse163.org/course/detail.htm?cid=47004) | HTTP 200；公开课程介绍 4,865 字符逐字一致，来源/详情/SHA-256 与 2 个图片附件实际字节已核对。 | 本页未观察到音视频元素，未据此宣称课程视频可以取得或播放。 |
| [Coursera 机器学习课程](https://www.coursera.org/learn/machine-learning) | HTTP 200；公开课程页 5,756 字符逐字一致，来源/详情/SHA-256 已核对；23 张图保留引用，8 个附件实际字节通过，超出数量预算显示部分保存。 | 不称全部图片均已保存；课程视频、登录后内容及付费内容未验证。 |

站点证据分别保存在 `.hallmark/browser-evidence/e09-bilibili-completed.json`、`e09-bilibili-media-close.json`、`e09-youtube-text-media-close.json`、`platform-zhihu-summary.json`、`platform-icourse163-summary.json`、`platform-coursera-summary.json`。图片数量预算的缺失反馈已修复并经真实网页和 10 图受控样本验证。

## 浏览器与客户端

真实 Native Messaging 与上表两种 MCP 客户端实现已通过所列流程。这不等于已在两个桌面 Agent 产品中验收，也不代表所有网站已适配。其余采集入口、媒体和重启恢复仍按验收表分别记录。最低 Manifest API 版本为 Chromium 116；版本声明不等于所有衍生浏览器都经过验证。

Windows、Linux、Firefox、Safari、远程 Agent 与移动浏览器尚未列为已验证组合。Firefox 和 Safari 也不直接使用本项目当前的 Chromium 构建。

## 能力边界

- 普通 DOM 选文、图片和 HTML 音视频是通用路径；阅读器清空选区、Canvas、跨源 iframe、登录和限权媒体需按具体环境核对。
- 截图保留像素，现场录制保留实际捕获轨道；两者均不宣称取得原始文本或原始媒体文件。
- 现场录制尾段依据媒体进度判断，使用 0.15 秒采样容差；始终保存实际观察值，不把它改写成配置值。原始 MediaRecorder WebM 可能没有 duration 头，本次样本通过包时间和完整解码核对，且保留解析器警告。
- Clipper MCP 只提供结构化指南、导出、claim 校验和扩展侧取源路由；Babel 扩展负责源媒体获取与附件落盘，Agent 负责导出后的 sherpa-onnx SenseVoice、FFmpeg、LLM 和其他本地后处理。Agent 不得使用 CUA、Playwright、Puppeteer、浏览器点击或自己的下载器取源。Agent 必须保留 raw，并在回写前执行数字、否定和长度等语义检查。OCR、摘要和跨记录拼接同样由 Agent 或外部工具处理。
- 录制默认预算为单次 600 秒、256 MiB，附件总预算 1 GiB，可在扩展中修改。这是有界工程默认值，尚不构成长时间录制和存储容量保证。
- MCP 资源更新通知是否显示给用户取决于客户端；主动查询和扩展界面继续可用。

候选性能目标（文字采集 P95 500 毫秒、一万条元数据列表约 1 秒）尚未完成专项测量，不作为当前承诺。

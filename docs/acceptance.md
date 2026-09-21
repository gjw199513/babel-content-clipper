# 验收覆盖与证据

本表逐项对应原 PRD 第 25 章，另以确认版 Spec 修订四状态、同次去重、目录优先级、单条记录和公开交付要求。

状态分为“已通过”“部分验证”“待验证”“受环境限制”；构建与类型检查不替代浏览器验收。实施中的临时状态随后依据实际执行更新。

| 编号 | 动作 | 通过条件 | 当前证据与状态 |
|---|---|---|---|
| A-01 | 快捷键保存一段文字 | 原文完整、标题来源正确、列表省略不影响全文 | 已通过通用样本：真实 Option+Shift+S 保存文章全文及 Example Domain 选文，持久记录来源和 exact 与选区一致；长列表预览由独立 UI 回归覆盖 |
| A-02 | 对同一选区使用右键 | 与快捷键内容一致，不要求打开面板 | 已通过通用样本：文章同一选文经原生右键与快捷键分别保存且全文相同；新构建在扩展重载后、未刷新原网页的情况下右键仍成功 |
| A-03 | 原阅读器有划词菜单 | 菜单和原操作仍可用，Babel 不抢焦点 | 已通过受控阅读器：原菜单可见，批注按钮正常执行并保留焦点；未将样本等同于所有在线阅读器兼容 |
| A-04 | 原阅读器清空选择 | 有效适配可取，否则明确降级，不保存空文冒充成功 | 已通过受控阅读器：清空选区后明确提示未取得有效选区，不新增记录；换章后同样拒绝旧快照，重新选择第二章可保存其原文 |
| A-05 | 翻章后再按采集 | 不误用上一章快照 | 已通过受控阅读器样本：同 URL 替换章节后清空选区，真实浏览器返回 SELECTION_EMPTY，不保存上一章快照 |
| A-06 | iframe 和嵌套页面选文 | 来源/框架正确，权限失败有明确说明 | 部分验证：真实浏览器同源 iframe 选文、frame 来源和两视图同步通过；跨源权限和复杂嵌套待按站点扩充 |
| A-07 | Canvas 文字页面 | 截图标为图片，不生成假原文，不调用 OCR | 已通过真实浏览器受控页面：非 DOM 文字只作为 region PNG 保存，实际读取 5,508 B 并验证 PNG 签名，没有原文或 OCR 声明 |
| A-08 | 图片直接保存失败 | 保留已取得信息并标明缺失，截图降级需明确 | 已通过：404 图片保留引用并标记 image_bytes 缺失；10 图选区保留 10 个引用、8 个非零附件、2 个预算跳过，界面明确提示部分保存。知乎/Coursera 超过 8 图的真实选区也按相同规则处理 |
| A-09 | 主动再次采集同一段 | 生成新记录，不因内容相同被强制禁止 | 已通过：真实右键和快捷键再次采集相同文章选区，生成独立 Capture/Job；core/domain 同时覆盖主动重复与通信重试的区别 |
| A-10 | 消息重试同一次点击 | 返回同一记录，不误生成重复项 | 部分验证：core/domain 同 requestId 返回同 Capture，冲突内容被拒绝；真实入口待测 |
| B-01 | 10:00 开始、12:00 结束 | 两次同一命令形成正确真实区间 | 已通过等价实际操作：B站与 YouTube 的真实 Option+Shift+V 开始/结束保存准确源时间与中途跳转分段；精确大时间值由范围领域用例覆盖 |
| B-02 | 前后预留各 10 秒 | 原点保留，计划范围为 09:50—12:10 | 部分验证：core/domain 真实范围 100—180 秒与预留范围 90—190 秒分别保留 |
| B-03 | 开始点靠近零或结尾 | 合理夹紧，记录不足余量，不报假完整 | 已通过组合样本：B站/YouTube 从第 2 秒开始时计划起点夹紧为 0；公开短 MDN 源计划终点夹紧到已知 duration；真实现场录制到源末端时 postRollComplete=false、实际余量独立记录 |
| B-04 | 修改全局 padding | 老记录不改变，新记录使用新值 | 已通过真实浏览器：旧 Capture 保持 10/10 秒，新 Capture 使用修改后的 3/4 秒 |
| B-05 | 二倍速观看 | 按源媒体时间保存，不把一分钟墙钟当两分钟区间 | 已通过真实浏览器样本：2x rate_change 与源 currentTime 保留，区间以源时间推进 |
| B-06 | 暂停和跳转 | 事件与连续段可追溯，不悄悄囊括跳过内容 | 已通过修复后样本：前跳保留三段 normalized，回看重叠只在本次合并；原始事件独立保存。较大 padding 可能合并预留计划，不能与真实观看区间混淆，见架构说明 |
| B-07 | 多播放器含广告 | 结束点来自最初锁定目标 | 部分验证：含独立视频/音频的页面切换活跃元素后仍锁定 video-0；真实广告替换播放器按平台另测 |
| B-08 | 没按结束就关页 | 标记中断，不伪造真实结束点击 | 已通过真实浏览器：关闭 open 媒体标签后 state=interrupted、missing=end_click，无 endClick 或合成 end 事件 |
| B-09 | 实际下载多取了相邻分片 | 真实/计划/实际/输出范围分别保存 | 部分验证：真实 FFmpeg 集成保存请求、获取、输出范围；网络分片取源待测 |
| B-10 | 要求只输出真实区间 | 可利用预留素材裁切，不改原记录 | 已修复并通过：claim/reprocess 仅覆盖 original 策略时，重新从 Capture 派生输出范围而不沿用旧 padded 范围。实际 FFmpeg 保留 8—14 秒获取范围、输出 10—12 秒共 2 秒，旧 Result/文件保留 |
| C-01 | 询问“有没有待处理” | 只查询，不自动执行或领取 | 已通过：SDK 与 Inspector 先查询真实浏览器待办，记录保持 pending，明确 claim 后才执行 |
| C-02 | 明确要求处理两项 | 仅领取授权两项，结果回写主库 | 已通过真实 MCP：只领取两条指定 Capture 对应的 Job，一项完成并生成两个独立产物，一项在一次允许重试后失败；第三项仍 pending、无 claim/result，成功项与旧文件不回滚 |
| C-03 | 两个 Agent 同时领取 | 同一工作项仅一个领取成功 | 已通过：两个独立 SDK stdio 客户端同时领取真实浏览器 Job，恰好 1 accepted / 1 already_claimed |
| C-04 | 重复发送相同结果 | 幂等接受，不新增重复成功事件 | 已通过：真实 SDK 重放原 completed 请求获得 persisted ACK，Inspector 复读原 Result；core/domain 验证不新增重复终态 |
| C-05 | 同一终态提交冲突内容 | 报冲突，不覆盖旧结果 | 已通过：真实链路返回 RESULT_CONFLICT，原 Result 与 163 B 文件摘要不变；修复了桥转发 plain JSON 错误时丢失具体 code 的缺陷 |
| C-06 | 对成功历史重新处理 | 创建新工作项，旧结果与文件引用保留 | 已通过：真实 MCP 新建 reprocess Job 并记录模拟失败，Inspector 读回新旧结果，原 163 B 文件 SHA-256 不变；另有真实 FFmpeg 历史保留测试 |
| C-07 | 更换会话或 Agent 查询 | 仍看到正确待办和历史，不依赖会话记忆 | 已通过：独立 Inspector stdio 会话读回 SDK 写入的 completed/failed 历史及产物校验信息 |
| C-08 | 浏览器退出时查询/回写 | 明确不可用或待回写，不返回假空/假成功 | 已有分层验证：真实浏览器退出及扩展重载期间 doctor 返回 BROWSER_UNAVAILABLE；同 profile 重启恢复连接和持久结果。桥的断线写入错误由协议测试覆盖；真实 SDK 在终态响应丢失后保持未确认并显式重放，未将该实验说成浏览器进程中途退出 |
| C-09 | 回写重连重试 | ACK 后显示完成，迟到重复不覆盖 | 已通过真实 SDK：事务完成后在客户端丢弃终态响应并关闭 stdio，用新客户端与完全相同业务请求重放，得到持久化 ACK、同一个 Result，Inspector 独立确认历史。此前真实素材库已核对 ACK 后的完成回显 |
| C-10 | 租约失联 | 不盲目重跑外部任务，保留待核实状态 | 已通过领域时序验证：心跳过期仅诊断，不释放或重排任务，不推断外部执行已经结束 |
| D-01 | 无新增达到设定阈值 | 只提醒一次，不自动下载 | 已通过真实 chrome.alarms：等待一分钟阈值自然产生本地提醒，待办未领取，没有执行下载 |
| D-02 | 阈值前新增采集 | 重设一次性计时，不按旧时间误提醒 | 已通过真实 chrome.alarms：新 Capture 重设唯一一次性闹钟；重复保存设置不叠加定时器，最终提醒对应最新 Capture |
| D-03 | 未回应提醒 | 不视为同意，不每隔阈值催促 | 已通过组合验证：真实一次性闹钟触发后不重排、不领取，关闭提示后持久通知清除；控制器时序测试覆盖迟到、重启和长期忽略 |
| D-04 | 客户端不支持通知 | 插件提示与主动 MCP 查询仍能使用 | 已通过组合验证：通知通道失败的控制器测试仍保存本地提示；真实 alarms 自然到期后的提示与关闭通过，MCP 主动查询独立可用。未宣称桌面 Agent 的通知展示通过 |
| D-05 | 未结束录制且长时间无点击 | 不因闲置替用户结束真实区间 | 已通过普通媒体标记：跨过真实提醒阈值仍为 open，无 endClick，随后由明确结束操作封存；现场保存另受显式预算停止规则约束 |
| D-06 | 现场录制声音和画面 | 两类轨道按实际保存，缺失明确标注 | 已通过所列样本：新版真实 YouTube tabCapture 保存 3,291,619 B、12 个持久分块，VP9/Opus 双轨均能解码，退出 0。静音测试音量处于 PCM16 底限；解析器的一条 Opus packet header 警告原样保留，不称为零警告文件 |
| D-07 | 录制开启前没有缓冲 | 不承诺前置 10 秒现场已经取得 | 已通过真实录制：请求前置 2 秒，recordingCoverage 明确 actualPreRollSeconds=0，没有把过去未录下的内容算成已保存 |
| D-08 | 录制中断 | 已保存部分可追踪，不显示完整源文件 | 已通过预算中断样本：真实录制达到 6 秒上限自动停止，111,350 B 已持久化并可经 MCP 分块读取，附件保持 interrupted；明确结束后 Capture 为 sealed/partial_saved，不伪造完整覆盖。进程异常退出的中断路径另行验证 |
| D-09 | 清理一个来源已处理项 | 未处理和活跃任务保留，不删除整个混合分组 | 已通过双视图 UI：同来源 completed/pending/processing 三条记录仅删除 completed；另一已打开视图清空被删除记录的详情并显示说明。该检查发现并修复了跨视图残留旧详情问题 |
| D-10 | 清理全部已处理 | 数量范围可见，外部成品文件不被删除 | 已通过组合验证：真实浏览器 UI 预览 1 条候选/2 条保护项、取消后保留、确认后仅删除已处理项；core/domain 覆盖外部文件保留。UI 数据为受控 RPC 夹具，不称为 Agent 执行结果 |
| D-11 | 清理预览后新增重处理 | 检测冲突，不能删掉新活跃任务 | 部分验证：core/domain 新增重处理 Job 后原清理预览失效 |
| D-12 | 明确通过 MCP 清理 | 与 UI 规则一致，不由普通处理流程自动调用 | 已通过实际 SDK/Inspector：独立显式请求 preview/commit，仅删除同来源指定集合中的 completed Capture 及其历史；默认保留 failed、未领取的 pending 和全部外部文件。正常批量处理前后没有自动清理 |

## Spec 工程验证

| 编号 | 验证范围 | 当前状态 |
|---|---|---|
| E-01 | Native 桥、profile、ACK、并发与重连 | 真实浏览器与两个标准 MCP 客户端读写、并发领取、终态响应丢失后新连接同请求重放均已通过；重放实验准确区分客户端 stdio 断开与浏览器进程退出 |
| E-02 | 通用采集、阅读器、站点能力 | 原生右键和快捷键、扩展重载后已有网页采集通过；真实 B站/YouTube 文字与媒体标记、知乎/MOOC/Coursera 公开页图文已实测；阅读器清空/换章、Canvas、图片缺失和受限页面均有独立回归，见兼容矩阵 |
| E-03 | 关闭网页后取源、区间与音画 | 公开 MDN 源关页后已通过真实 MCP 读取持久来源、FFmpeg 裁切、双轨检查、ACK 和 Inspector 复读；前跳缺口问题已修复，独立静音浏览器回归保留三段真实区间并合并同次回看 |
| E-04 | 现场录制、分块、时间覆盖与恢复 | 已通过新版真实静音样本：运行脚本 hash 与 root 构建一致；在视频页真实快捷键调用后，从侧栏开始、真实快捷键结束。raw/normalized 均截止 endClick=12.577992 秒，planned 终点为 14.577992 秒，附件尾段独立记录。实际观察尾段 1.912738 秒，处于实现的 0.15 秒采样容差内，未回填成 2 秒。3,291,619 B 分块重组与文件摘要一致，双轨可解码；一条 Opus 警告保留 |
| E-05 | 录制和附件预算 | 领域层分块超限保留部分数据通过；真实录制临时配置 6 秒上限，在 6.036 秒以 max_duration 自动停止，保留 111,350 B 双轨附件。随后明确结束并恢复默认 600 秒，不将短样本视为长时间容量保证 |
| E-06 | 系统、浏览器、两个 MCP 客户端 | macOS 26.5.1 / CFT 153.0.8010.12 / 官方 SDK 1.30.0 / Inspector CLI 2.7.0 已通过所列链路；不等同于两个桌面 Agent 产品验收 |
| E-07 | 原生全局侧栏与独立页同步 | 真实侧栏跨网站切换和当前来源更新通过；独立回归确认筛选、选择同步与视图关闭重开恢复。同 profile 浏览器进程重启后记录、completed 历史和 Native 连接恢复；扩展重载会清除已终态 Capture 的残留临时状态及假等待提示 |
| E-08 | 资源更新和闲置提醒 | 标准 SDK 订阅、本地提醒控制器与真实 chrome.alarms 的重设/自然触发均通过；客户端如何显示通知按各自能力处理 |
| E-09 | 新用户安装与连接 | 已通过本机干净消费目录：tgz 安装与运行依赖、生成 Native 注册、新 CFT profile 加载包内扩展、设置页连接、真实 B站快捷键采集、包内 CLI 的 SDK 领取/写文件/持久化 ACK、Inspector 独立读回 completed；`v0.1.0-alpha.1` 已发布到 GitHub Releases，远端附件回下载后通过 SHA-256 与 ZIP 完整性校验 |
| E-10 | Agent 环境的 sherpa-onnx Node-Addon 平台加载 | Agent 侧参考原型在 macOS arm64 / Node.js 22.22.0 上以 `sherpa-onnx-node@1.13.8` 完成 CPU 识别；macOS x64、Windows x64、Linux x64/arm64 未实测。这不是 Clipper MCP 内置运行能力 |
| E-11 | Agent 模型下载、缓存、镜像与完整性 | Agent 侧参考原型从官方 Hugging Face 固定 revision 真实下载 239,233,841 B INT8 模型，4 个文件大小/SHA-256 全部匹配并复用缓存；hf-mirror 真实传输及错误分类仍待独立 Agent 验证，Clipper 当前只发布规则 |
| E-12 | Agent FFmpeg 抽音、范围与分段 | Agent 侧参考原型用 FFmpeg 6.0 将指定 5.592 秒范围抽成 16 kHz 单声道 WAV，并生成分块时间映射；无音轨、损坏媒体和长视频专项样本待补。这不是 MCP 执行工具 |
| E-13 | 简介、标签与评论采集 | 受控浏览器媒体页真实保存 description/keywords/语义 comment，数量和字符预算、去重及不可信数据标记通过；小红书/B站/YouTube 真实评论 DOM 的跨站质量仍待逐站核对 |
| E-14 | Agent LLM 校正语义保护 | Agent 侧参考样本把原始“开饭时间”依据标题/简介最小校正为“开放时间”，9 点/5 点不变；当前指南明确提示注入、数字、单位、否定、专名和长度检查，但不声称 Clipper 代码替 Agent 强制执行。更多真实样本仍待补 |
| E-15 | Agent ASR 本地文件与不覆盖 | Agent 侧参考 Job 目录保存 source、audio、raw txt/json、context、manifest、corrected 与 audit；当前 MCP 继续验证回写文件位于已领取输出目录。跨 reprocess Job 与主动清理专项仍待补 |
| E-16 | 指导型 MCP 与扩展取源边界 | MCP stdio 测试确认处理指南、扩展取源路由和 Capture 导出工具可读；MCP 不直接下载、不准备运行时、不转写、不校正，私有来源 URL 只在 Babel 扩展内部使用；指南单测锁定无 CUA/Playwright/Puppeteer/浏览器点击、模型 revision/哈希、不可信上下文与本地文件契约 |
| E-17 | 统一处理待办 | 浏览器回归确认资料库一次复制两条真实 pending Job 的固定 ID 快照，排除 completed Job 和不可信正文，复制不领取；MCP 单测与 stdio 测试确认 `pending_batch_processing` 指南要求遍历分页、每波最多 200 项、只处理 accepted 且逐项独立回写 |

## 证据索引

- 当前源码检查：测试数量以最近一次 `npm test` 输出为准；最新类型检查及真实 LSP 检查必须为零错误、零警告。执行型 ASR/下载模块不属于 Clipper MCP；扩展侧取源协议由消息、Native 路由、Core 附件和 MCP stdio 测试覆盖。与浏览器及安装结果分别记录。
- Agent 侧 ASR 参考证据：`artifacts/validation/asr-runtime/asr/runtime-manifest.json` 记录固定模型 revision、官方端点、文件路径、大小和 SHA-256；`artifacts/validation/asr-runtime/media/runtime-manifest.json` 记录当时验证的 yt-dlp 与 FFmpeg；`artifacts/validation/asr-e2e/captures/cap_smoke/jobs/job_smoke/` 保存源 WAV 及完整 raw/context/corrected/audit 文件树。这些文件证明指南参考路径曾在本机跑通，不表示当前 Clipper MCP 执行它们。
- 领域逻辑与 IndexedDB 模拟环境：[domain.test.ts](../tests/core/domain.test.ts)、[attachments-backup.test.ts](../tests/core/attachments-backup.test.ts)。
- 实际 FFmpeg/ffprobe 裁切：[media-processing.test.ts](../tests/integration/media-processing.test.ts)，本机运行事实在 `artifacts/validation/media-processing.json`。
- 本地安装包消费验证：`npm run verify:install`，本机运行事实在 `artifacts/validation/installation.json`。
- 干净安装包的真实首次使用：`.hallmark/browser-evidence/e09-installed-bilibili-pending.json` 与 `e09-bilibili-library-pending.png` 记录新 profile 的实际 B站采集；`artifacts/validation/mcp-installed-e09-live.json` 与 `mcp-installed-e09-summary.json` 记录包内 CLI 完成 46 B 原文文件、持久化 ACK 和 Inspector 复读。一次快捷键重试产生的第二条主动采集记录保留，不将其冒充通信重试去重样本。
- 一次性提醒控制器：[reminders.test.ts](../tests/integration/reminders.test.ts)，涵盖重置、迟到、重启、关闭与无客户端降级。
- 浏览器自动化完整套最新运行 20/20 项通过，耗时约 2.9 分钟；包含 capture、smoke、i18n、library、organization、reader boundaries 与布局，全部使用隔离 profile。其中文本/图片/媒体、五语言、备份、收藏、清理、真实 alarms 和重启边界均通过；headless 明确 unavailable 仍不作为真实现场录制成功证明。
- 尾段冻结修复后的受影响浏览器回归：`.hallmark/browser-evidence/latest-capture-regression-summary.json` 与同名日志，3/3 项通过，16.0 秒，覆盖媒体范围与严格 0 B 失败路径。该回归仍不替代真实现场录制的尾段成功证据。
- 最新采集回归：[capture-regression.spec.ts](../tests/browser/capture-regression.spec.ts)，3/3 项通过，17.3 秒，覆盖实际图文/PNG 字节、媒体范围、具体录制失败诊断和单次开关。headless 失败分支不作为现场录制成功证明。
- 收藏、复制、来源清理和自然提醒：[organization.spec.ts](../tests/browser/organization.spec.ts)，证据为 `.hallmark/browser-evidence/organization-{favorites-copy,source-cleanup,alarms}.json` 及截图。复制检查捕获真实按钮调用 writeText 的内容；headless 未授权读取系统剪贴板，因此不声称系统剪贴板往返通过。清理数据由受信 Core RPC 建立受控状态；自然提醒使用真实 chrome.alarms。
- 阅读器与采集边界：[reader-boundaries.spec.ts](../tests/browser/reader-boundaries.spec.ts)，证据为 `reader-selection-focus-and-chapter.json`、`reader-boundaries-canvas-images.json`、`reader-boundaries-restricted.json` 及截图，均位于 `.hallmark/browser-evidence/`。组织与阅读器两组共 6/6 项通过，约 2.3 分钟，包含真实提醒等待。
- 真实公开平台回归：[platform-smoke.spec.ts](../tests/browser/platform-smoke.spec.ts)，本次构建 3/3 项通过，14.3 秒：知乎/MOOC/Coursera 的实时公开选区、URL、SHA-256 和详情回显均核对。图片数量超限仍按 partial 与缺失元数据展示；三页未观察到媒体元素，不宣称课程视频适配。
- 真实平台媒体标记：`.hallmark/browser-evidence/e09-bilibili-media-close.json` 与 `e09-youtube-text-media-close.json`，两站均通过系统快捷键开始、静音播放、跳转、暂停与结束，真实区间保留缺口，关源页后仍可读回。YouTube 另有可见标题选文。该项没有执行两站媒体下载，不冒充已取得文件。
- 粘贴、共享视图和备份：`.hallmark/browser-evidence/library-regression-summary.json`；粘贴完整原文、未知来源、重复提交一次、URL 校验，筛选/选中同步和关闭重开、UI 导出后在独立 profile UI 导入均通过。该次备份仅元数据，没有据此声称附件迁移通过。
- 真实清理界面：`.hallmark/browser-evidence/library-cleanup-summary.json`，区分 UI 动作与为测试预置的工作项。
- 真实 MCP 主动清理：`artifacts/validation/mcp-cleanup-live.json`。preview 的 includeFailed=false，1 条 completed 候选、failed/pending 均跳过；持久化 ACK 后 SDK 和 Inspector 确认只删除 1 Capture/2 Jobs/2 Results，3 份外部文件摘要不变。首次验收脚本误将 Inspector 预期 NOT_FOUND 的 exit 5 视为失败，随后只读复核，没有重复发送删除。
- 图片字节完整性：[image-bytes.test.ts](../tests/integration/image-bytes.test.ts)，涵盖非图片响应、空响应、超限和超时。
- MCP stdio、Native 帧和资源订阅：[tests/mcp](../tests/mcp/)，分别验证路由、边界和通知；双客户端的阶段证据在 `artifacts/validation/mcp-clients.json`，其中明确区分模拟扩展与真实浏览器。
- 真实 Chromium Native Messaging 与两个 MCP 客户端：`artifacts/validation/mcp-clients-live.json`；实际文本产物与持久化回写：`artifacts/validation/mcp-text-workflow-live.json`。
- 真实双客户端并发与历史保留：`artifacts/validation/mcp-reprocess-concurrency-live.json`；真实素材库回显：`.hallmark/browser-evidence/mcp-completed-history.json` 与同名 PNG。
- 真实终态重发与冲突：`artifacts/validation/mcp-terminal-idempotency-live.json`，回放幂等、具体冲突错误及既有文件摘要均核对。
- 指定批次、一次重试与丢 ACK 重连：`artifacts/validation/mcp-batch-retry-reconnect-live.json`，两条指定 Job 分别 completed/failed，一条返回 46 B 文本与 270 B 清单两个产物，第三条始终 pending；临时失败的重试保持原 claim，终态 failed 不回普通待办。SDK 实际观察后丢弃终态响应，再由新 SDK 客户端同请求重放并由 Inspector 复读；不声称重新执行了外部任务。`mcp-batch-retry-reconnect-live-discrepancy.json` 记录人工转述 Job ID 一位不一致及按实际 Capture 身份只读校正的过程。
- 公开媒体关页后处理：`.hallmark/browser-evidence/e03-mdn-ordinary-media.json` 记录浏览器来源与原始区间；`artifacts/validation/mcp-public-media-workflow-live.json` 记录源页关闭后的 MCP/FFmpeg 流程，生成 522,782 B、5.005 秒的 H.264/AAC 文件，并由 Inspector 读回 completed。浏览器关闭动作与 UI 回显分别由浏览器测试负责人记录。
- 四状态与错误展示：`.hallmark/browser-evidence/mcp-reprocess-failed-history.json` 与同名 PNG，确认素材库同时保留旧 completed 产物和新 failed 诊断。
- 原生入口修复前后的证据：`right-click-shortcut-diagnostic.json` 记录同文重复采集与旧版缺少 content receiver 的诊断；`right-click-reload-native.json` 证明新构建在扩展重载后、未刷新既有网页时原生右键成功；`shortcut-example-domain.json` 证明公开页真实快捷键成功。文件均位于 `.hallmark/browser-evidence/`。
- 真实侧栏跨标签与来源同步：`.hallmark/browser-evidence/cross-tab-source-sync.json` 及同目录 `cross-tab-example-domain-sidepanel.png`。旧 `real-entry-evidence.json` 中的问题是修复前记录，不作为最新结论。
- 真实录制基线：`.hallmark/browser-evidence/live-recording-baseline.json` 和 `media-recording.webm`，包含轨道、packet 时间、文件摘要及完整解码诊断；不替代新构建的尾部与恢复验收。
- 图文及区域像素：`.hallmark/browser-evidence/capture-image-region-summary.json`，实际 SVG 610 B、区域 PNG 5,352 B，PNG 的 220×180 像素与区域一致。
- 时间轴修复前后：`.hallmark/browser-evidence/capture-media-pre-fix-failure.json` 与 `capture-media-summary.json`。最终完整套包含目标锁定、倍速、暂停端点、padding 快照和关页中断；原修复前证据继续保留，不覆盖或冒充最新结果。
- 录到媒体边界的真实降级：`.hallmark/browser-evidence/live-tail-evidence.json`。源已结束时后置预留不足，保留实际覆盖与 `postRollComplete=false`。`live-tail-decoding-review.json` 说明原始包时间递增，固定 null 输出时间基后大量 DTS 诊断消失，仍保留一条 Opus parser 诊断。
- 录制未启动的严格界面回归：`.hallmark/browser-evidence/capture-live-unavailable-summary.json` 与状态/详情截图。headless 场景未取得 tabCapture 授权时，开关恢复普通标记，保存具体 `recordingFailure`、0 B 和 `dataAvailable=false`，不伪造轨道或覆盖；下一条普通标记没有录制附件。附件 bytes API 的不可用错误由 Core 回归验证，不将 UI 的受限 RPC 当作 Native 调用证明。
- 浏览器重启与扩展恢复：`.hallmark/browser-evidence/recovery-history.json` 保留原故障；`recovery-extension-reload-20260919.json` 与同名截图证明修复后临时状态为空、旧 Capture 仍 interrupted 且没有伪造 endClick、既有 MDN completed 结果仍在。
- 真实短预算停止：`.hallmark/browser-evidence/budget-max-duration-20260919-final.json`，包含实际停止时间、附件状态、MCP 分块读取、文件摘要与 ffprobe 双轨结果。自动停止先于用户明确结束，测试配置已恢复，录制器已停止。
- 尾段问题及静音检查：`.hallmark/browser-evidence/quiet-tail-20260919-113235-evidence.json` 保留修复前的真实区间与尾段混入事实；`quiet-tail-20260919-113235-audio-check.json` 记录静态解码均值/峰值均在 PCM16 静音底限，未播放文件。修复由 [media-tail-boundary.test.ts](../tests/core/media-tail-boundary.test.ts) 覆盖；`quiet-tail-final-20260919.json` 是修复后未取得 tabCapture 授权的失败证据，不能标为尾段通过。
- 最新正向录制：`.hallmark/browser-evidence/recording-final-20260919131924-shortcut.json`、同前缀 `-recording.webm`、`-static-validation.json`、`-decode.log` 和前后截图。12 个分块共 3,291,619 B，SHA-256 为 `2a3612ef98e2ccd0cee25a8c357032cc4ee88a4e120bf62be0bd3650d3b53bf6`；音频/视频包时间单调，包末端分别约 37.499/37.558 秒。录制 elapsed 含用户暂停期间，不能当作源媒体选择时长。静态完整解码退出 0，mean/max 均 -91 dB，未播放；Opus packet header 警告未隐藏。此前错误文案不完整的失败样本继续保留；本轮实际脚本已核对 Unicode 转义后的新诊断代码，目标页前台授权路径成功。
- 最终本地发行包的源码与运行文件校验、干净消费目录安装结果由 `artifacts/validation/release-validation.json` 记录。安装消费测试使用隔离配置与 Native 注册目录，不写入使用者的真实浏览器配置。

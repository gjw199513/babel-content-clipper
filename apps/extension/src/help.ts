import { getLocale, initializeI18n, installLanguageControl, onLocaleChange, t, translateDocument } from "./i18n.js";

const sections: ReadonlyArray<{ heading: string; paragraphs: readonly string[] }> = [
  {
    "heading": "开始使用",
    "paragraphs": [
      "点击浏览器工具栏中的 Babel Content Clipper 图标打开侧栏；展开素材库可以管理全部记录。未连接 MCP 时也能采集和查看。"
    ]
  },
  {
    "heading": "文字、图片与截图",
    "paragraphs": [
      "选中文字后按 Alt+Shift+S，或使用右键菜单。右键图片可保存图片。按 Alt+Shift+X 框选区域，Esc 取消。Mac 上 Alt 对应 Option。",
      "无法直接取得选文时可使用粘贴导入。截图只保存像素，不会自动执行 OCR；图片未取得的部分会如实标记。"
    ]
  },
  {
    "heading": "音视频片段",
    "paragraphs": [
      "在媒体页面按 Alt+Shift+V 开始，再按一次结束。同一次记录内往回拖动不会重复计算重叠范围；再次主动采集可以建立独立记录。",
      "前后预留时间可在设置中调整。普通标记只记录范围，不等于已下载媒体文件。需要现场音画时，为本次记录勾选对应开关，并在目标网页点击扩展图标授予权限。",
      "现场录制没有开启前的回溯缓冲；失败或覆盖不足会显示实际原因。源媒体取源由已连接的 Babel 扩展完成；ASR、OCR 和裁切由后续 Agent 及其工具完成。不得使用浏览器点击或自己的下载器取源。"
    ]
  },
  {
    "heading": "连接你的 Agent",
    "paragraphs": [
      "先安装 Node.js 22 或更新版本，并在项目目录执行 npm ci 和 npm run build。加载 dist/extension 后，从连接设置复制 profileId。",
      "以下为 macOS / Google Chrome 示例：在项目目录运行，将 YOUR_PROFILE_ID 替换为当前浏览器连接标识。",
      "从哪里进入连接设置：侧栏底部直接点击“连接设置”；如果已经打开素材库，点击页面右上角的“连接设置”。进入后找到“MCP 连接”卡片。",
      "如果 Agent 提示无法连接，请按这三个动作操作：1. 点击“连接设置”；2. 在“MCP 连接”卡片点击“立即重连本地服务”；3. 看到“本地桥已连接”后，让 Agent 刷新 MCP。不要去来源网页里点击任何按钮。",
      "把生成的 babel-clipper-mcp.json 合并到客户端的 MCP 配置后，再按上面的顺序重连本地服务并刷新客户端连接。不同浏览器的注册路径不同；Windows 和 Linux 尚未完成实机验证。",
      "先让 Agent 查询待处理记录，再明确要求处理指定记录。仅查询和提醒不会自动执行。每条记录独立输出，处理中状态防止其他 Agent 同时领取。"
    ]
  },
  {
    "heading": "输出与管理",
    "paragraphs": [
      "输出目录优先使用本次任务指定值，其次是 MCP 默认目录，最后是扩展全局设置。重新处理保留旧结果；处理失败会保留诊断信息。",
      "仅收藏的记录不会进入待处理队列。导出备份时可包含内部附件；清理插件记录不会删除 Agent 已写到外部目录的成品。"
    ]
  },
  {
    "heading": "语言与数据",
    "paragraphs": [
      "首次使用跟随浏览器语言，不支持的语言使用英语。手动切换会在本机保存，并同步到侧栏、素材库与帮助页；采集原文、来源、标识和错误代码不会被翻译或改写。",
      "浏览器扩展管理页中的说明与快捷键描述由浏览器界面语言决定；插件内手动选择不会修改浏览器本身的语言。",
      "记录保存在当前浏览器的本地数据库，没有内置云同步。交给外部 Agent 或模型后的数据处理取决于你的工具与配置。"
    ]
  },
  {
    "heading": "兼容与使用范围",
    "paragraphs": [
      "当前为正式版本。公开网页样本通过不代表全站适配，也不保证登录、付费内容或源媒体下载可用。",
      "作者计划提供个人非商业使用权限，商业使用须单独授权；正式许可条款尚未定稿，项目不采用 MIT。"
    ]
  }
];

const installCommand = `node dist/node/cli.js --mode=install \\
  --extension-id lpmplddblefacpachnchfgcdebjebdbh \\
  --profile-id YOUR_PROFILE_ID \\
  --manifest-dir "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \\
  --mcp-config-out ./babel-clipper-mcp.json`;

function render(): void {
  translateDocument();
  document.title = `Babel Content Clipper — ${t("关于与使用帮助")}`;
  const content = document.querySelector<HTMLElement>("#help-content")!;
  content.replaceChildren();
  for (const entry of sections) {
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = t(entry.heading);
    section.append(heading);
    for (const source of entry.paragraphs) {
      const paragraph = document.createElement("p");
      paragraph.textContent = t(source);
      section.append(paragraph);
      if (source.startsWith("以下为 macOS")) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = installCommand;
        pre.append(code);
        section.append(pre);
      }
    }
    content.append(section);
  }
  const download = document.querySelector<HTMLAnchorElement>("#install-doc")!;
  download.href = `help-docs/${getLocale()}/install.md`;
  download.download = `Babel-Content-Clipper-install-${getLocale()}.md`;
}

await initializeI18n();
installLanguageControl(document.querySelector<HTMLElement>("#language-control")!);
onLocaleChange(render);
document.querySelector("#open-library")!.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
});
document.querySelector("#open-settings")!.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("library.html#settings") });
});
const manifest = chrome.runtime.getManifest();
document.querySelector("#version")!.textContent = manifest.version_name || manifest.version;
render();

export interface ContentAccessFailure {
  readonly code:
    | "PAGE_ACCESS_RESTRICTED"
    | "FRAME_ACCESS_RESTRICTED"
    | "FRAME_UNAVAILABLE"
    | "BROWSER_UNAVAILABLE";
  readonly message: string;
  readonly details: { readonly frameId: number; readonly reason: string };
}

export function classifyContentAccessFailure(error: unknown, frameId: number): ContentAccessFailure {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/no frame with id|frame (?:was|has been) removed|frame with id .* removed/iu.test(message)) {
    return {
      code: "FRAME_UNAVAILABLE",
      message: "所选框架已刷新或关闭，请重新打开菜单后再试。",
      details: { frameId, reason: "frame_unavailable" },
    };
  }
  if (
    /cannot access (?:contents|a frame|an? [a-z-]+:\/\/ url|the page)|cannot be scripted|extensions gallery|missing host permission|permission.*(?:denied|required)|scheme.*not permitted/iu.test(message)
  ) {
    return frameId > 0
      ? {
          code: "FRAME_ACCESS_RESTRICTED",
          message: "所选框架受浏览器或站点权限限制，扩展无法读取内容。",
          details: { frameId, reason: "restricted_frame" },
        }
      : {
          code: "PAGE_ACCESS_RESTRICTED",
          message: "当前页面受浏览器保护，扩展无法读取内容；请在普通网页中重试。",
          details: { frameId, reason: "restricted_page" },
        };
  }
  return {
    code: "BROWSER_UNAVAILABLE",
    message: "页面内容脚本无法响应；请刷新页面后重试。",
    details: { frameId, reason: "content_script_unavailable" },
  };
}

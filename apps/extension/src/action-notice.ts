export const ACTION_NOTICE_KEY = "babel_content_clipper.action_notice.v1";

export interface ActionNotice {
  readonly id: string;
  readonly createdAt: string;
  readonly tone: "success" | "error" | "info";
  readonly message: string;
}

export function parseActionNotice(value: unknown): ActionNotice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const notice = value as Partial<ActionNotice>;
  if (
    typeof notice.id !== "string" ||
    typeof notice.createdAt !== "string" ||
    typeof notice.message !== "string" ||
    !["success", "error", "info"].includes(String(notice.tone))
  ) return undefined;
  return notice as ActionNotice;
}

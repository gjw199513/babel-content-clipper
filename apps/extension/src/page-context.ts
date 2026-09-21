const MAX_DESCRIPTION_CHARS = 8_000;
const MAX_TAGS = 100;
const MAX_TAG_CHARS = 120;
const MAX_COMMENTS = 50;
const MAX_COMMENT_CHARS = 800;
const MAX_TOTAL_COMMENT_CHARS = 16_000;
const MAX_COMMENT_CANDIDATES = 200;

export interface PageContentContext {
  readonly descriptions: readonly string[];
  readonly tags: readonly string[];
  readonly comments: readonly string[];
  readonly omittedCommentCount: number;
}

function normalizedText(value: string | null | undefined, maxChars: number): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, maxChars) : undefined;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function metaContent(document: Document, selector: string): string[] {
  return [...document.querySelectorAll<HTMLMetaElement>(selector)]
    .flatMap((element) => {
      const value = normalizedText(element.content, MAX_DESCRIPTION_CHARS);
      return value === undefined ? [] : [value];
    });
}

function commentSelectors(hostname: string): string[] {
  const host = hostname.toLowerCase();
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    return ["ytd-comment-thread-renderer #content-text", "[itemprop='comment'] [itemprop='text']"];
  }
  if (host === "bilibili.com" || host.endsWith(".bilibili.com")) {
    return [".reply-item .reply-content", ".sub-reply-item .reply-content", "[itemprop='comment'] [itemprop='text']"];
  }
  if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")) {
    return [
      "#noteContainer .comment-item .content",
      ".comments-container .comment-item .content",
      "[class*='comment-item'] [class*='content']",
      "[itemprop='comment'] [itemprop='text']",
    ];
  }
  return ["[itemprop='comment'] [itemprop='text']", "[itemprop='commentText']"];
}

function commentCandidates(document: Document, selectors: readonly string[]): {
  values: string[];
  omittedCandidates: number;
} {
  const values: string[] = [];
  const seenElements = new Set<Element>();
  let examined = 0;
  let omittedCandidates = 0;
  commentSearch: for (const selector of selectors) {
    const elements = document.querySelectorAll<HTMLElement>(selector);
    for (const element of elements) {
      if (seenElements.has(element)) continue;
      seenElements.add(element);
      if (examined >= MAX_COMMENT_CANDIDATES) {
        omittedCandidates = 1;
        break commentSearch;
      }
      examined += 1;
      const comment = normalizedText(element.innerText || element.textContent, MAX_COMMENT_CHARS);
      if (comment !== undefined) values.push(comment);
    }
  }
  return { values: unique(values), omittedCandidates };
}

export function collectPageContentContext(document: Document, hostname: string): PageContentContext | undefined {
  const descriptions = unique([
    ...metaContent(document, "meta[name='description']"),
    ...metaContent(document, "meta[property='og:description']"),
    ...metaContent(document, "meta[name='twitter:description']"),
  ]).slice(0, 4);

  const keywordValues = metaContent(document, "meta[name='keywords']")
    .flatMap((value) => value.split(/[,，;；|]/u));
  const articleTags = metaContent(document, "meta[property='article:tag']");
  const tags = unique([...keywordValues, ...articleTags]
    .flatMap((value) => {
      const tag = normalizedText(value.replace(/^#/u, ""), MAX_TAG_CHARS);
      return tag === undefined ? [] : [tag];
    }))
    .slice(0, MAX_TAGS);

  const candidates = commentCandidates(document, commentSelectors(hostname));
  const allComments = candidates.values;
  const comments: string[] = [];
  let totalChars = 0;
  for (const comment of allComments) {
    if (comments.length >= MAX_COMMENTS || totalChars + comment.length > MAX_TOTAL_COMMENT_CHARS) break;
    comments.push(comment);
    totalChars += comment.length;
  }
  if (descriptions.length === 0 && tags.length === 0 && comments.length === 0) return undefined;
  return {
    descriptions,
    tags,
    comments,
    omittedCommentCount: candidates.omittedCandidates + Math.max(0, allComments.length - comments.length),
  };
}

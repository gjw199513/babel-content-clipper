import DOMPurify from "dompurify";

const ALLOWED_TAGS = ["a", "abbr", "b", "blockquote", "br", "code", "dd", "div", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "i", "img", "li", "ol", "p", "pre", "s", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"];
const ALLOWED_ATTR = ["alt", "colspan", "datetime", "height", "href", "lang", "rel", "rowspan", "target", "title", "width"];

export function sanitizeHtml(input: string, maxLength = 500_000): string {
  const bounded = input.slice(0, maxLength);
  return DOMPurify.sanitize(bounded, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "textarea"],
    FORBID_ATTR: ["style", "srcdoc", "src"],
  });
}

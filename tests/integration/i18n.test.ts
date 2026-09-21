import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { messages, resolveLocale, SUPPORTED_LOCALES, translate } from "../../apps/extension/src/i18n.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("presentation locale contract", () => {
  it.each([
    ["en-GB", "en"], ["zh", "zh-CN"], ["zh-Hans-SG", "zh-CN"],
    ["zh-Hant", "zh-TW"], ["zh-Hans-TW", "zh-CN"], ["zh_HK", "zh-TW"], ["zh-MO", "zh-TW"],
    ["ja-JP", "ja"], ["ko-KR", "ko"], ["fr-FR", "en"], ["", "en"],
  ])("resolves browser language %s to %s", (source, target) => {
    expect(resolveLocale(source)).toBe(target);
  });

  it("ships complete translations with the same named placeholders", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu)].map(match => match[1]).sort();
    expect(Object.keys(messages).length).toBeGreaterThan(300);
    for (const [source, translations] of Object.entries(messages)) {
      for (const locale of SUPPORTED_LOCALES.filter(locale => locale !== "zh-CN")) {
        const text = translations[locale];
        expect(text?.trim(), `${locale}: ${source}`).toBeTruthy();
        expect(placeholders(text), `${locale}: ${source}`).toEqual(placeholders(source));
      }
      expect(translations.en, source).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });

  it("interpolates values literally without translating input or expanding dollar sequences", () => {
    expect(translate("操作未完成（{code}）。", "en", { code: "$&<tag>保存设置" }))
      .toBe("The action did not complete ($&<tag>保存设置).");
    expect(translate("uncatalogued diagnostic", "ko")).toBe("uncatalogued diagnostic");
  });

  it("covers source UI strings and explicit HTML translation bindings", async () => {
    const root = resolve(import.meta.dirname, "../..");
    for (const name of ["sidepanel.ts", "library.ts", "clipboard-import.ts", "ui-shared.ts", "help.ts"]) {
      const text = await readFile(resolve(root, "apps/extension/src", name), "utf8");
      const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /[\u3400-\u9fff]/u.test(node.text)) {
          // The help renderer uses this prefix solely to place the shell example.
          if (name !== "help.ts" || node.text !== "以下为 macOS") expect(messages[node.text], `${name}: ${node.text}`).toBeDefined();
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    for (const name of ["sidepanel.html", "library.html", "help.html"]) {
      const html = await readFile(resolve(root, "apps/extension/public", name), "utf8");
      for (const match of html.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/gu)) {
        expect(messages[match[1]!], `${name}: ${match[1]}`).toBeDefined();
      }
    }
  });

  it("includes every manifest message in all five Chrome locales without renaming the product", async () => {
    const root = resolve(import.meta.dirname, "../..");
    const manifest = JSON.parse(await readFile(resolve(root, "apps/extension/manifest.json"), "utf8"));
    expect(manifest.name).toBe("Babel Content Clipper");
    expect(manifest.default_locale).toBe("en");
    const keys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/gu)].map(match => match[1]!);
    expect(keys.length).toBeGreaterThanOrEqual(6);
    for (const locale of ["en", "zh_CN", "zh_TW", "ja", "ko"]) {
      const catalog = JSON.parse(await readFile(resolve(root, `apps/extension/public/_locales/${locale}/messages.json`), "utf8"));
      for (const key of keys) expect(catalog[key]?.message?.trim(), `${locale}/${key}`).toBeTruthy();
    }
  });

  it("persists only the language preference and responds to another window's choice", async () => {
    vi.resetModules();
    const stored: Record<string, unknown> = {};
    const listeners: Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void> = [];
    const set = vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(stored, values);
      const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]));
      for (const listener of listeners) listener(changes, "local");
    });
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: () => "fr-FR" },
      storage: { local: { get: async () => ({ ...stored }), set }, onChanged: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) } },
    });
    const i18n = await import("../../apps/extension/src/i18n.js");
    await i18n.initializeI18n();
    expect(i18n.getLocale()).toBe("en");
    const notified = vi.fn();
    i18n.onLocaleChange(notified);
    await i18n.setLocalePreference("ja");
    expect(set).toHaveBeenLastCalledWith({ [i18n.LOCALE_KEY]: "ja" });
    expect(i18n.getLocale()).toBe("ja");
    expect(i18n.localizeMessage("Region capture cancelled.")).toBe("範囲選択を取り消しました。");
    for (const listener of listeners) listener({ [i18n.LOCALE_KEY]: { newValue: "zh-TW" } }, "local");
    expect(i18n.getLocale()).toBe("zh-TW");
    expect(i18n.localizeMessage("操作未完成（RECORDER_BUSY）。")).toBe("操作未完成（RECORDER_BUSY）。");
    await i18n.setLocalePreference("auto");
    expect(i18n.getLocale()).toBe("en");
    expect(i18n.getLocalePreference()).toBe("auto");
    const nestedNotice = "现场音画未启动：请先在目标页面点击 Babel 扩展图标重新授予当前标签页访问权限，再勾选现场音画重试；若仍失败，请检查浏览器的屏幕录制权限。具体原因：NotAllowedError 时间范围仍在记录。";
    expect(i18n.localizeMessage(nestedNotice)).not.toMatch(/[\u3400-\u9fff]/u);
    expect(i18n.localizeMessage(nestedNotice)).toContain("NotAllowedError");
    expect(notified).toHaveBeenCalledTimes(3);
    set.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(i18n.setLocalePreference("ko")).rejects.toThrow("storage unavailable");
    expect(i18n.getLocale()).toBe("en");
  });
});

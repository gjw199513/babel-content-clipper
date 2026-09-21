import { EXTENSION_CHANNEL, isContentCommand, type ContentCommandMessage } from "./messages.js";
import { redactUrl, truncateText } from "./security.js";
import { sanitizeHtml } from "./dom-safety.js";
import { observeMediaProgress } from "./media-segments.js";
import { MAX_SELECTION_IMAGE_REFERENCES } from "./selection-images.js";

const SNAPSHOT_TTL_MS = 15_000;
const MEDIA_SAMPLE_MS = 250;
const MAX_EVENTS = 2_000;
const MAX_SEGMENTS = 1_000;
const MAX_SELECTION_TEXT = 10_000_000;
const MAX_SELECTION_HTML = 500_000;
const documentInstanceId = crypto.randomUUID();

interface SelectionSnapshot {
  documentInstanceId: string;
  url: string;
  title: string;
  text: string;
  html: string;
  exact: string;
  prefix: string;
  suffix: string;
  imageRefs?: string[];
  selectedImageCount?: number;
  omittedImageReferenceCount?: number;
  chapter?: string;
  createdAt: number;
}

interface MediaEvent { type: string; mediaSeconds: number; wallTime: string; playbackRate?: number; detail?: string }
interface MediaSegment { start: number; end: number; source: string }
interface MediaTarget {
  element: HTMLMediaElement;
  targetId: string;
  source: string;
  duration: number | null;
}

let latestSelection: SelectionSnapshot | undefined;
// Keep the live DOM range in the content context. It is intentionally never
// sent through runtime messaging; it lets us reject a stale snapshot after a
// same-URL reader route replaces the chapter DOM.
let latestSelectionRange: Range | undefined;
let regionOverlay: HTMLDivElement | undefined;
let mediaCapture: {
  captureId?: string;
  target: MediaTarget;
  startedAt: string;
  startedMediaSeconds: number;
  events: MediaEvent[];
  segments: MediaSegment[];
  lastMediaSeconds: number;
  lastSampleWall: number;
  lastDraftSentWall: number;
  lastDraftSentEventCount: number;
  draftQueue: Promise<void>;
  sourceChanged: boolean;
  pendingSegmentStart?: number;
  markedEnd?: {
    endedAt: string;
    originalEnd: number | null;
    segments: MediaSegment[];
  };
  timer?: number;
  listeners: Array<() => void>;
} | undefined;

function reply(requestId: string, ok: boolean, payload?: unknown, error?: { code: string; message: string; details?: unknown }): void {
  void chrome.runtime.sendMessage({ channel: EXTENSION_CHANNEL, type: "content_reply", requestId, ok, ...(payload === undefined ? {} : { payload }), ...(error ? { error } : {}) });
}

function isEditable(element: Element | null): boolean {
  if (!element) return false;
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
    || element instanceof HTMLElement && (element.isContentEditable || element.closest("[contenteditable='true']") !== null);
}

function chapterFor(node: Node | null): string | undefined {
  const element = node instanceof Element ? node : node?.parentElement;
  const heading = element?.closest("section, article, main")?.querySelector("h1, h2, h3") ?? document.querySelector("h1, h2, h3");
  const text = heading?.textContent?.trim();
  return text ? truncateText(text, 240) : undefined;
}

function selectionAround(text: string): { prefix: string; suffix: string } {
  const body = document.body?.innerText ?? "";
  const index = body.indexOf(text);
  if (index < 0) return { prefix: "", suffix: "" };
  return { prefix: body.slice(Math.max(0, index - 120), index), suffix: body.slice(index + text.length, index + text.length + 120) };
}

function pageSource(): {
  url: string;
  canonicalUrl?: string;
  title: string;
  documentInstanceId: string;
} {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel~="canonical"]')?.href;
  return {
    url: redactUrl(location.href),
    ...(canonical ? { canonicalUrl: redactUrl(canonical) } : {}),
    title: document.title,
    documentInstanceId,
  };
}

function redactSelectedMarkupUrls(holder: HTMLElement): void {
  const attributes = ["href", "src", "poster", "cite", "action", "formaction"] as const;
  for (const element of holder.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of attributes) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      try {
        element.setAttribute(attribute, redactUrl(new URL(value, location.href).href));
      } catch {
        element.removeAttribute(attribute);
      }
    }
    const srcset = element.getAttribute("srcset");
    if (srcset) {
      element.setAttribute(
        "srcset",
        srcset.replace(/https?:\/\/[^\s,]+/giu, (url) => redactUrl(url)),
      );
    }
  }
}

function readSelection(): SelectionSnapshot | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
  const text = selection.toString().trim();
  if (!text || isEditable(selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement ?? null)) return undefined;
  if (text.length > MAX_SELECTION_TEXT) return undefined;
  const range = selection.getRangeAt(0);
  const holder = document.createElement("div");
  holder.append(range.cloneContents());
  const imageElements = [...holder.querySelectorAll<HTMLImageElement>("img")];
  const allImageRefs = imageElements
    .map((image) => image.currentSrc || image.getAttribute("src") || "")
    .map((value) => {
      try { return redactUrl(new URL(value, location.href).href); }
      catch { return ""; }
    })
    .filter(Boolean);
  const imageRefs = allImageRefs.slice(0, MAX_SELECTION_IMAGE_REFERENCES);
  const omittedImageReferenceCount = Math.max(0, allImageRefs.length - imageRefs.length);
  redactSelectedMarkupUrls(holder);
  const rawHtml = holder.innerHTML;
  const context = selectionAround(text);
  const snapshot: SelectionSnapshot = {
    documentInstanceId,
    url: redactUrl(location.href),
    title: document.title,
    text,
    html: rawHtml.length <= MAX_SELECTION_HTML ? sanitizeHtml(rawHtml, MAX_SELECTION_HTML) : "",
    exact: text,
    prefix: context.prefix,
    suffix: context.suffix,
    ...(imageRefs.length > 0 ? { imageRefs } : {}),
    ...(imageElements.length > 0 ? { selectedImageCount: imageElements.length } : {}),
    ...(omittedImageReferenceCount > 0 ? { omittedImageReferenceCount } : {}),
    chapter: chapterFor(range.commonAncestorContainer),
    createdAt: Date.now(),
  };
  latestSelection = snapshot;
  latestSelectionRange = range.cloneRange();
  return snapshot;
}

function validSnapshot(snapshot: SelectionSnapshot | undefined): snapshot is SelectionSnapshot {
  if (!snapshot || snapshot !== latestSelection || !latestSelectionRange) return false;
  if (snapshot.documentInstanceId !== documentInstanceId || snapshot.url !== redactUrl(location.href) || Date.now() - snapshot.createdAt > SNAPSHOT_TTL_MS) return false;
  const range = latestSelectionRange;
  if (!range.startContainer.isConnected || !range.endContainer.isConnected || !range.commonAncestorContainer.isConnected) return false;
  if (range.toString().trim() !== snapshot.exact) return false;
  if (snapshot.chapter && chapterFor(range.commonAncestorContainer) !== snapshot.chapter) return false;
  const context = selectionAround(snapshot.exact);
  return context.prefix === snapshot.prefix && context.suffix === snapshot.suffix;
}

document.addEventListener("selectionchange", () => { void readSelection(); }, { passive: true });

function sourceUrl(element: HTMLMediaElement): string {
  const source = element.currentSrc || element.src || element.querySelector("source")?.getAttribute("src") || location.href;
  return redactUrl(source);
}

function targetFor(requestedType?: "video" | "audio"): MediaTarget | undefined {
  const candidates = [...document.querySelectorAll<HTMLMediaElement>(requestedType ? requestedType : "video, audio")]
    .filter(element => element.readyState > 0 && (element.currentSrc || element.src || element.querySelector("source")));
  if (candidates.length === 0) return undefined;
  const fullscreen = candidates.find(item => document.fullscreenElement === item);
  const playing = candidates.find(item => !item.paused && !item.ended);
  const visible = candidates
    .map(element => ({ element, rect: element.getBoundingClientRect() }))
    .filter(item => item.rect.width > 20 && item.rect.height > 20)
    .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]?.element;
  const element = fullscreen ?? playing ?? visible ?? candidates[0];
  if (!element) return undefined;
  const index = candidates.indexOf(element);
  return { element, targetId: `${element.tagName.toLowerCase()}-${index}`, source: sourceUrl(element), duration: Number.isFinite(element.duration) ? element.duration : null };
}

function addMediaEvent(type: string, detail?: string): void {
  if (!mediaCapture) return;
  const target = mediaCapture.target.element;
  const mediaSeconds = Number.isFinite(target.currentTime) ? target.currentTime : mediaCapture.lastMediaSeconds;
  const event: MediaEvent = { type, mediaSeconds, wallTime: new Date().toISOString(), ...(Number.isFinite(target.playbackRate) ? { playbackRate: target.playbackRate } : {}), ...(detail ? { detail } : {}) };
  mediaCapture.events.push(event);
  if (mediaCapture.events.length > MAX_EVENTS) {
    const removed = mediaCapture.events.length - MAX_EVENTS;
    mediaCapture.events.splice(0, removed);
    mediaCapture.lastDraftSentEventCount = Math.max(0, mediaCapture.lastDraftSentEventCount - removed);
  }
}

function sampleMedia(): void {
  if (!mediaCapture) return;
  const target = mediaCapture.target.element;
  if (sourceUrl(target) !== mediaCapture.target.source) {
    if (!mediaCapture.sourceChanged) addMediaEvent("source_changed", "media-source-changed");
    mediaCapture.sourceChanged = true;
    return;
  }
  const current = Number.isFinite(target.currentTime) ? target.currentTime : mediaCapture.lastMediaSeconds;
  const wallNow = Date.now();
  if (
    !mediaCapture.markedEnd &&
    !target.paused &&
    !target.ended &&
    current >= mediaCapture.lastMediaSeconds - 0.3
  ) {
    const forcedSegmentStart = mediaCapture.pendingSegmentStart;
    const observed = observeMediaProgress(mediaCapture.segments, {
      previousMediaSeconds: mediaCapture.lastMediaSeconds,
      currentMediaSeconds: current,
      elapsedWallSeconds: Math.max(0, (wallNow - mediaCapture.lastSampleWall) / 1_000),
      playbackRate: target.playbackRate,
      source: mediaCapture.target.source,
      ...(forcedSegmentStart === undefined ? {} : { forcedSegmentStart }),
    });
    if (observed.discontinuity && forcedSegmentStart === undefined) addMediaEvent("seek", "time-jump");
    mediaCapture.pendingSegmentStart = undefined;
  }
  if (mediaCapture.segments.length > MAX_SEGMENTS) mediaCapture.segments.splice(0, mediaCapture.segments.length - MAX_SEGMENTS);
  mediaCapture.lastMediaSeconds = current;
  mediaCapture.lastSampleWall = wallNow;
  if (mediaCapture.captureId && wallNow - mediaCapture.lastDraftSentWall >= 1_000) {
    const captureId = mediaCapture.captureId;
    const events = mediaCapture.events.slice(mediaCapture.lastDraftSentEventCount);
    mediaCapture.lastDraftSentEventCount = mediaCapture.events.length;
    mediaCapture.lastDraftSentWall = wallNow;
    const observations = {
      segments: (mediaCapture.markedEnd?.segments ?? mediaCapture.segments).map(segment => ({ ...segment })),
      ...(events.length > 0 ? { events } : {}),
      eventSnapshot: mediaCapture.events.map(event => ({ ...event })),
      lastObservedMediaSeconds: current,
    };
    mediaCapture.draftQueue = mediaCapture.draftQueue.then(async () => {
      await chrome.runtime.sendMessage({ channel: EXTENSION_CHANNEL, type: "media_update", captureId, observations });
    }).catch(() => undefined);
  }
}

function closeMediaSegmentAtBoundary(element: HTMLMediaElement): void {
  if (!mediaCapture || mediaCapture.markedEnd || mediaCapture.target.element !== element || mediaCapture.pendingSegmentStart !== undefined) return;
  if (sourceUrl(element) !== mediaCapture.target.source) return;
  const current = Number.isFinite(element.currentTime) ? element.currentTime : mediaCapture.lastMediaSeconds;
  const wallNow = Date.now();
  observeMediaProgress(mediaCapture.segments, {
    previousMediaSeconds: mediaCapture.lastMediaSeconds,
    currentMediaSeconds: current,
    elapsedWallSeconds: Math.max(0, (wallNow - mediaCapture.lastSampleWall) / 1_000),
    playbackRate: element.playbackRate,
    source: mediaCapture.target.source,
    appendOnDiscontinuity: false,
  });
  mediaCapture.lastMediaSeconds = current;
  mediaCapture.lastSampleWall = wallNow;
}

function startMedia(target: MediaTarget): { startedAt: string; originalStart: number; targetId: string; source: string; duration: number | null } {
  const startedAt = new Date().toISOString();
  const element = target.element;
  const initialEvent: MediaEvent = {
    type: "capture_started",
    mediaSeconds: element.currentTime,
    wallTime: startedAt,
    ...(Number.isFinite(element.playbackRate) ? { playbackRate: element.playbackRate } : {}),
  };
  mediaCapture = {
    target,
    startedAt,
    startedMediaSeconds: element.currentTime,
    lastMediaSeconds: element.currentTime,
    lastSampleWall: Date.now(),
    lastDraftSentWall: 0,
    lastDraftSentEventCount: 0,
    draftQueue: Promise.resolve(),
    sourceChanged: false,
    events: [initialEvent],
    segments: [{ start: element.currentTime, end: element.currentTime, source: target.source }],
    listeners: [],
  };
  const events: Array<[keyof HTMLMediaElementEventMap, string]> = [["play", "play"], ["pause", "pause"], ["seeking", "seeking"], ["ratechange", "ratechange"], ["loadedmetadata", "loadedmetadata"], ["ended", "ended"]];
  for (const [eventName, type] of events) {
    const listener = () => {
      if (eventName === "pause" || eventName === "ended") closeMediaSegmentAtBoundary(element);
      if (eventName === "seeking" && mediaCapture?.target.element === element && Number.isFinite(element.currentTime)) {
        mediaCapture.pendingSegmentStart = Math.max(0, element.currentTime);
      }
      addMediaEvent(type);
    };
    element.addEventListener(eventName, listener);
    mediaCapture.listeners.push(() => element.removeEventListener(eventName, listener));
  }
  mediaCapture.timer = window.setInterval(sampleMedia, MEDIA_SAMPLE_MS);
  return { startedAt, originalStart: element.currentTime, targetId: target.targetId, source: target.source, duration: target.duration };
}

function markMediaEnd(): { endedAt: string; originalEnd: number | null; events: MediaEvent[]; segments: MediaSegment[]; duration: number | null } | undefined {
  if (!mediaCapture) return undefined;
  sampleMedia();
  if (!mediaCapture.markedEnd) {
    const target = mediaCapture.target.element;
    const current = Number.isFinite(target.currentTime) ? target.currentTime : mediaCapture.lastMediaSeconds;
    const last = mediaCapture.segments[mediaCapture.segments.length - 1];
    if (last && current >= last.end && current - last.end <= 2.5 && sourceUrl(target) === last.source) last.end = current;
    mediaCapture.markedEnd = {
      endedAt: new Date().toISOString(),
      originalEnd: Number.isFinite(target.currentTime) ? target.currentTime : null,
      segments: mediaCapture.segments.map(segment => ({ ...segment })),
    };
    addMediaEvent("end_click");
  }
  return {
    ...mediaCapture.markedEnd,
    events: mediaCapture.events.map(event => ({ ...event })),
    segments: mediaCapture.markedEnd.segments.map(segment => ({ ...segment })),
    duration: mediaCapture.target.duration,
  };
}

function mediaStatus(): Record<string, unknown> {
  if (!mediaCapture) return { active: false, documentInstanceId };
  sampleMedia();
  const target = mediaCapture.target.element;
  return {
    active: true,
    captureId: mediaCapture.captureId,
    documentInstanceId,
    target: {
      targetId: mediaCapture.target.targetId,
      source: mediaCapture.target.source,
      duration: mediaCapture.target.duration,
    },
    currentMediaSeconds: Number.isFinite(target.currentTime) ? target.currentTime : mediaCapture.lastMediaSeconds,
    paused: target.paused,
    ended: target.ended,
    sourceMatches: !mediaCapture.sourceChanged && sourceUrl(target) === mediaCapture.target.source,
    markedEnd: mediaCapture.markedEnd,
    observations: {
      segments: (mediaCapture.markedEnd?.segments ?? mediaCapture.segments).map(segment => ({ ...segment })),
      events: mediaCapture.events.map(event => ({ ...event })),
      lastObservedMediaSeconds: mediaCapture.lastMediaSeconds,
    },
  };
}

function stopMedia(interrupted = false): { endedAt: string; originalEnd: number | null; events: MediaEvent[]; segments: MediaSegment[]; duration: number | null; interrupted: boolean } | undefined {
  if (!mediaCapture) return undefined;
  sampleMedia();
  const state = mediaCapture;
  const target = state.target.element;
  const completion = {
    endedAt: state.markedEnd?.endedAt ?? new Date().toISOString(),
    originalEnd: state.markedEnd?.originalEnd ?? (Number.isFinite(target.currentTime) ? target.currentTime : null),
    events: state.events.map(event => ({ ...event })),
    segments: (state.markedEnd?.segments ?? state.segments).map(segment => ({ ...segment })),
    duration: state.target.duration,
    interrupted,
    lastObservedMediaSeconds: state.lastMediaSeconds,
    sourceChanged: state.sourceChanged,
  };
  if (state.timer !== undefined) window.clearInterval(state.timer);
  state.listeners.forEach(remove => remove());
  mediaCapture = undefined;
  return completion;
}

function beginRegion(requestId: string): void {
  if (regionOverlay) return reply(requestId, false, undefined, { code: "REGION_ALREADY_ACTIVE", message: "已有框选正在进行。" });
  const overlay = document.createElement("div");
  overlay.setAttribute("role", "application");
  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgb(20 24 28 / 8%);";
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;border:2px solid #b87516;background:rgb(255 192 80 / 16%);pointer-events:none;";
  overlay.append(box);
  document.documentElement.append(overlay);
  regionOverlay = overlay;
  let startX = 0; let startY = 0; let active = false;
  const render = (event: PointerEvent): void => {
    const left = Math.min(startX, event.clientX); const top = Math.min(startY, event.clientY);
    box.style.left = `${left}px`; box.style.top = `${top}px`; box.style.width = `${Math.abs(event.clientX - startX)}px`; box.style.height = `${Math.abs(event.clientY - startY)}px`;
  };
  const cancel = (): void => { overlay.remove(); regionOverlay = undefined; window.removeEventListener("keydown", onKey, true); reply(requestId, false, undefined, { code: "REGION_CANCELLED", message: "已取消框选。" }); };
  const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") cancel(); };
  window.addEventListener("keydown", onKey, true);
  overlay.addEventListener("pointerdown", event => { active = true; startX = event.clientX; startY = event.clientY; overlay.setPointerCapture(event.pointerId); render(event); });
  overlay.addEventListener("pointermove", event => { if (active) render(event); });
  overlay.addEventListener("pointerup", event => {
    if (!active) return;
    active = false;
    const rect = { x: Math.round(Math.min(startX, event.clientX)), y: Math.round(Math.min(startY, event.clientY)), width: Math.round(Math.abs(event.clientX - startX)), height: Math.round(Math.abs(event.clientY - startY)), devicePixelRatio: window.devicePixelRatio, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY };
    overlay.remove(); regionOverlay = undefined; window.removeEventListener("keydown", onKey, true);
    if (rect.width < 4 || rect.height < 4) reply(requestId, false, undefined, { code: "REGION_EMPTY", message: "框选区域太小。" });
    else reply(requestId, true, { rect, source: pageSource() });
  });
}

async function handle(message: ContentCommandMessage, sender: chrome.runtime.MessageSender): Promise<void> {
  if (!sender.id || sender.id !== chrome.runtime.id) return;
  const requestId = message.requestId ?? crypto.randomUUID();
  try {
    if (message.command === "capture_selection") {
      const fresh = readSelection();
      const snapshot = fresh ?? (validSnapshot(latestSelection) ? latestSelection : undefined);
      if (!snapshot) return reply(requestId, false, undefined, { code: "SELECTION_EMPTY", message: "没有取得当前页面的有效选区。请重新选择后再试。" });
      return reply(requestId, true, { kind: "selection", selection: snapshot, source: pageSource() });
    }
    if (message.command === "begin_region") return beginRegion(requestId);
    if (message.context?.phase === "status") {
      const status = mediaStatus();
      const expectedDocument = message.context.documentInstanceId;
      const expectedCapture = message.context.captureId;
      const sameDocument = !expectedDocument || expectedDocument === documentInstanceId;
      const activeCapture = typeof status.captureId === "string" ? status.captureId : undefined;
      const sameCapture = !expectedCapture || expectedCapture === activeCapture;
      return reply(requestId, true, { ...status, sameDocument, sameCapture });
    }
    const requestedType = message.context?.mediaType === "audio" ? "audio" : message.context?.mediaType === "video" ? "video" : undefined;
    const target = mediaCapture?.target ?? targetFor(requestedType);
    if (!target) return reply(requestId, false, undefined, { code: "MEDIA_TARGET_MISSING", message: "没有找到可识别的 HTML5 音视频目标。" });
    if (message.context?.phase === "mark_end") {
      const completion = markMediaEnd();
      if (!completion) return reply(requestId, false, undefined, { code: "MEDIA_NOT_OPEN", message: "当前标签页没有正在记录的片段。" });
      return reply(requestId, true, { kind: "media", source: pageSource(), target: { targetId: target.targetId, source: target.source, duration: target.duration }, completion, status: mediaStatus() });
    }
    if (message.context?.phase === "stop") {
      const completion = stopMedia(false);
      if (!completion) return reply(requestId, false, undefined, { code: "MEDIA_NOT_OPEN", message: "当前标签页没有正在记录的片段。" });
      return reply(requestId, true, { kind: "media", source: pageSource(), target: { targetId: target.targetId, source: target.source, duration: target.duration }, completion });
    }
    if (mediaCapture) return reply(requestId, false, undefined, { code: "MEDIA_ALREADY_OPEN", message: "当前页面已有正在记录的片段。" });
    const started = startMedia(target);
    return reply(requestId, true, { kind: "media", source: pageSource(), target: started, completion: { startedAt: started.startedAt, originalStart: started.originalStart, playbackRate: target.element.playbackRate } });
  } catch (error) {
    reply(requestId, false, undefined, { code: "CONTENT_CAPTURE_FAILED", message: error instanceof Error ? error.message : "页面采集失败。" });
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isContentCommand(message)) { void handle(message, sender); sendResponse({ ok: true }); return false; }
  if (message && typeof message === "object" && (message as { type?: unknown }).type === "media_bind") {
    const value = message as { captureId?: unknown; documentInstanceId?: unknown };
    if (typeof value.documentInstanceId === "string" && value.documentInstanceId !== documentInstanceId) {
      sendResponse({ ok: false, error: { code: "DOCUMENT_MISMATCH", message: "页面上下文已变化，未绑定旧记录。" } });
      return false;
    }
    if (typeof value.captureId === "string" && mediaCapture) mediaCapture.captureId = value.captureId;
    sendResponse({ ok: Boolean(mediaCapture) });
    return false;
  }
  return false;
});

window.addEventListener("beforeunload", () => {
  if (!mediaCapture?.captureId) return;
  const captureId = mediaCapture.captureId;
  const completion = stopMedia(true);
  if (captureId && completion) void chrome.runtime.sendMessage({ channel: EXTENSION_CHANNEL, type: "media_interrupted", captureId, completion });
}, { capture: true });

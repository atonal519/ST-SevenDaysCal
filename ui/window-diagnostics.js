// Explicit, memory-only window diagnostics; no chat or request data is collected.
const CSS_FIELDS = ['position', 'display', 'visibility', 'opacity', 'z-index', 'pointer-events',
  'top', 'right', 'bottom', 'left', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'transform', 'transform-origin', 'translate', 'scale', 'perspective', 'filter', 'backdrop-filter',
  'contain', 'content-visibility', 'will-change', 'overflow-x', 'overflow-y', 'clip', 'clip-path', 'zoom',
  'font-size', 'line-height', '-webkit-text-size-adjust', 'background-color', 'color', '--sp-scale'];
const MAX_EVENTS = 128;
const SESSION_MS = 60_000;
const number = value => value == null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100) / 100;
const resourceFree = value => String(value || '').replace(/url\([^)]*\)/gi, 'url(<resource>)').replace(/https?:\/\/[^\s)"']+/gi, '<resource>').slice(0, 600);
const attempt = (read, fallback = null) => { try { return read() ?? fallback; } catch { return fallback; } };

function describe(element) {
  if (!element?.tagName) return null;
  const result = { tag: element.tagName };
  // Fixed application IDs identify controls without exporting arbitrary character/script names.
  if (/^(?:sp[-_]|qqj[-_]|st-tools-|send_textarea$|send_form$|sheld$|chat$|form_sheld$)/.test(element.id || '')) result.id = element.id.slice(0, 100);
  return result;
}

function rectangle(element) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect) return null;
  return Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(key => [key, number(rect[key])]));
}

function viewport(win) {
  const visual = win.visualViewport;
  return {
    inner: { width: number(win.innerWidth), height: number(win.innerHeight) },
    outer: { width: number(win.outerWidth), height: number(win.outerHeight) },
    scroll: { x: number(win.scrollX), y: number(win.scrollY) },
    visual: visual ? Object.fromEntries(['width', 'height', 'offsetLeft', 'offsetTop', 'pageLeft', 'pageTop', 'scale'].map(key => [key, number(visual[key])])) : null,
  };
}

function elementState(element, win) {
  if (!element) return null;
  const computed = win.getComputedStyle(element);
  return {
    ...describe(element), rect: rectangle(element),
    css: Object.fromEntries(CSS_FIELDS.map(key => [key, resourceFree(computed.getPropertyValue(key))])),
    inline: Object.fromEntries(CSS_FIELDS.map(key => [key, resourceFree(element.style?.getPropertyValue(key))]).filter(([, value]) => value)),
    scroll: Object.fromEntries(['scrollLeft', 'scrollTop', 'scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight'].map(key => [key, number(element[key])])),
    hidden: Boolean(element.hidden), inert: Boolean(element.inert), open: typeof element.open === 'boolean' ? element.open : null,
    modal: attempt(() => element.matches(':modal')), popoverOpen: attempt(() => element.matches(':popover-open')),
  };
}

function focusState(document, nodes, win) {
  let active = document.activeElement;
  const chain = [];
  while (active) { chain.push(describe(active)); if (!active.shadowRoot?.activeElement) break; active = active.shadowRoot.activeElement; }
  return {
    document: describe(document.activeElement), mainShadow: describe(nodes.shadow?.activeElement), deepest: describe(active), chain,
    inMain: Boolean(nodes.sheet?.contains?.(active)), documentFocused: attempt(() => document.hasFocus()),
    editable: Boolean(active?.isContentEditable || !active?.readOnly && (active?.tagName === 'TEXTAREA'
      || active?.tagName === 'INPUT' && ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(active.type))),
    readOnly: Boolean(active?.readOnly), disabled: Boolean(active?.disabled),
    element: attempt(() => elementState(active, win)),
  };
}

function buildReference(sourceUrl) {
  const url = new URL(sourceUrl || '', 'https://local.invalid/');
  return { file: url.pathname.split('/').pop(), cache: resourceFree(url.searchParams.get('v')) };
}

function environment(win, sourceUrl, nodes) {
  const nav = win.navigator || {}, screen = win.screen || {};
  const stylesheet = attempt(() => nodes.shadow?.querySelector('link[rel="stylesheet"]')?.href);
  return {
    build: buildReference(sourceUrl), stylesheet: stylesheet ? buildReference(stylesheet) : null,
    browser: { userAgent: resourceFree(nav.userAgent), platform: resourceFree(nav.platform), vendor: resourceFree(nav.vendor), maxTouchPoints: number(nav.maxTouchPoints),
      language: resourceFree(nav.language), standalone: Boolean(nav.standalone), devicePixelRatio: number(win.devicePixelRatio) },
    screen: { ...Object.fromEntries(['width', 'height', 'availWidth', 'availHeight'].map(key => [key, number(screen[key])])),
      orientation: { type: resourceFree(screen.orientation?.type), angle: number(screen.orientation?.angle ?? win.orientation) } },
    media: Object.fromEntries(['(max-width: 640px)', '(display-mode: standalone)', '(prefers-reduced-motion: reduce)', '(pointer: coarse)']
      .map(query => [query, attempt(() => win.matchMedia(query).matches)])),
    viewportMeta: resourceFree(attempt(() => win.document.querySelector('meta[name="viewport"]')?.content)),
    capabilities: { visualViewport: Boolean(win.visualViewport), mutationObserver: Boolean(win.MutationObserver),
      virtualKeyboard: Boolean(nav.virtualKeyboard), documentHitTest: typeof win.document.elementsFromPoint === 'function',
      shadowHitTest: typeof nodes.shadow?.elementsFromPoint === 'function', tauriAbi: number(win.__TAURITAVERN__?.abiVersion),
      topLevelWindow: win.top == null ? null : win.top === win },
  };
}

function paintState(nodes, win) {
  const view = viewport(win), input = rectangle(nodes.input), sheet = rectangle(nodes.sheet);
  const points = [
    ['layout-center', win.innerWidth / 2, win.innerHeight / 2],
    ['visual-center', (view.visual?.offsetLeft || 0) + (view.visual?.width || win.innerWidth) / 2,
      (view.visual?.offsetTop || 0) + (view.visual?.height || win.innerHeight) / 2],
    ...(input ? [['input-center', input.left + input.width / 2, input.top + input.height / 2]] : []),
    ...(sheet ? [['sheet-header', sheet.left + sheet.width / 2, sheet.top + 20]] : []),
  ];
  return points.map(([name, x, y]) => ({ name, x: number(x), y: number(y),
    document: attempt(() => Array.from(win.document.elementsFromPoint(x, y)).slice(0, 6).map(describe), []),
    mainShadow: attempt(() => Array.from(nodes.shadow.elementsFromPoint(x, y)).slice(0, 6).map(describe), []),
  }));
}

export function createWindowDiagnostics({ windowRef = globalThis.window, elements, sourceUrl = '', readUiState = () => ({}), now = () => Date.now(), onChange } = {}) {
  let recording = false, report = null, timer = null, frame = null, observer = null;
  let pendingEvent = '', pendingAttributes = [], bindings = [];
  const win = windowRef;
  const state = () => ({ recording, hasData: Boolean(report), count: report?.events.length || 0 });
  const changed = () => { try { onChange?.(state()); } catch {} };
  const sample = (event, details = {}, full = false) => {
    try {
      const nodes = elements(), document = win.document, ui = readUiState();
      const result = { at: now(), event, viewport: viewport(win), focus: focusState(document, nodes, win),
        ui: { module: ['schedule', 'almanac', 'lines', 'outline', 'space', 'theater', 'anchor'].includes(ui.module) ? ui.module : null, settingsOpen: Boolean(ui.settingsOpen) },
        windows: Object.fromEntries(['root', 'sheet', 'dialogHost', 'fab', 'input', 'settingsBody', 'messages'].map(key => [key, elementState(nodes[key], win)])),
        document: { visibility: document.visibilityState, fullscreen: describe(document.fullscreenElement),
          html: elementState(document.documentElement, win), body: elementState(document.body, win) },
      };
      const decision = Object.fromEntries(['preserveEditingGeometry', 'mobile'].filter(key => typeof details[key] === 'boolean').map(key => [key, details[key]]));
      for (const key of ['safeTop', 'safeBottom', 'rootOriginLeft', 'rootOriginTop']) if (typeof details[key] === 'number') decision[key] = number(details[key]);
      if (Object.keys(decision).length) result.decision = decision;
      const native = details.nativeEvent;
      if (native) {
        result.trigger = { target: describe(native.composedPath?.()[0] || native.target),
          path: (native.composedPath?.() || []).filter(node => node?.tagName).slice(0, 8).map(describe),
          x: number(native.clientX), y: number(native.clientY), pointerType: resourceFree(native.pointerType),
          defaultPrevented: Boolean(native.defaultPrevented), composing: Boolean(native.isComposing), inputType: resourceFree(native.inputType) };
      }
      if (details.attributes?.length) result.attributes = details.attributes;
      if (full || details.frame) result.paint = paintState(nodes, win);
      if (full) {
        result.ancestors = [];
        const seen = new Set();
        for (let node = nodes.sheet; node && !seen.has(node); node = node.parentElement || node.getRootNode?.().host) {
          seen.add(node); result.ancestors.push(elementState(node, win));
        }
      }
      return result;
    } catch (error) {
      return { at: now(), event, captureError: { name: ['TypeError', 'ReferenceError', 'SecurityError'].includes(error?.name) ? error.name : 'Error' } };
    }
  };
  const record = (event, details = {}) => {
    if (!recording) return;
    report.events.push(sample(event, details));
    if (report.events.length > MAX_EVENTS) { report.events.shift(); report.droppedEvents++; }
  };
  const schedule = (event, attributes = []) => {
    pendingEvent = event; pendingAttributes = [...new Set([...pendingAttributes, ...attributes])];
    if (frame !== null) return;
    frame = win.requestAnimationFrame(() => {
      frame = null; const name = pendingEvent, attrs = pendingAttributes; pendingEvent = ''; pendingAttributes = [];
      record(`${name}.frame`, { frame: true, attributes: attrs });
    });
  };
  const listen = (target, name, listener, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(name, listener, options); bindings.push(() => target.removeEventListener(name, listener, options));
  };
  const stop = (reason = 'manual') => {
    if (!recording) return;
    if (frame !== null) { win.cancelAnimationFrame(frame); frame = null; record(`${pendingEvent}.frame`, { frame: true, attributes: pendingAttributes }); }
    report.final = sample('stop', {}, true); report.endedAt = now(); report.stopReason = reason;
    recording = false; bindings.forEach(remove => remove()); bindings = []; observer?.disconnect(); observer = null;
    if (timer !== null) { win.clearTimeout(timer); timer = null; }
    pendingEvent = ''; pendingAttributes = []; changed();
  };
  const start = () => {
    stop('restart');
    const nodes = attempt(() => elements(), {});
    report = { kind: 'gouhua-window-diagnostics', schemaVersion: 1, startedAt: now(), endedAt: null,
      environment: attempt(() => environment(win, sourceUrl, nodes), {}), initial: null, events: [], final: null, droppedEvents: 0 };
    recording = true; report.initial = sample('start', {}, true);
    const event = source => nativeEvent => { const name = `${source}.${nativeEvent.type}`; record(name, { nativeEvent }); schedule(name); };
    for (const type of ['resize', 'scroll', 'orientationchange']) listen(win, type, event('window'), { passive: true });
    for (const type of ['resize', 'scroll']) listen(win.visualViewport, type, event('visual-viewport'), { passive: true });
    for (const type of ['focusin', 'focusout', 'beforeinput', 'input', 'compositionstart', 'compositionend', 'scroll']) listen(nodes.shadow, type, event('shadow'), { capture: true, passive: true });
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click', 'visibilitychange']) listen(win.document, type, event('document'), { capture: true, passive: true });
    listen(win, 'pagehide', () => stop('pagehide'), { passive: true });
    if (win.MutationObserver) {
      observer = new win.MutationObserver(records => schedule('dom.attributes', records.map(item => item.attributeName)));
      for (const node of new Set([win.document.documentElement, win.document.body, nodes.root, nodes.sheet, nodes.dialogHost, nodes.fab].filter(Boolean))) {
        observer.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'inert', 'popover', 'open'] });
      }
    }
    timer = win.setTimeout(() => stop('timeout'), SESSION_MS); changed();
  };
  return Object.freeze({ start, stop, record, state, snapshot: () => report ? JSON.parse(JSON.stringify(report)) : null });
}

export async function shareWindowDiagnostics({ diagnostics, copyText, promptTextarea, notify } = {}) {
  diagnostics?.stop('copy');
  const report = diagnostics?.snapshot();
  if (!report) { attempt(() => notify?.('请先开始窗口记录', false)); return { status: 'empty' }; }
  const text = JSON.stringify(report, null, 2);
  let copied = false;
  try { copied = await copyText?.(text) === true; } catch {}
  if (copied) { attempt(() => notify?.('窗口诊断已复制', false)); return { status: 'copied' }; }
  if (promptTextarea) {
    try {
      await promptTextarea({ title: '复制窗口诊断', body: '自动复制失败，请长按文本复制。', initialValue: text,
        maxLength: Math.max(1, text.length), rows: 12, confirmText: '关闭', cancelText: '取消' });
      return { status: 'manual-copy' };
    } catch {}
  }
  attempt(() => notify?.('自动复制失败，请重试', true)); return { status: 'failed' };
}

export function exportWindowDiagnostics({ diagnostics, downloadJson, notify } = {}) {
  diagnostics?.stop('export');
  const report = diagnostics?.snapshot();
  if (!report) { attempt(() => notify?.('请先开始窗口记录', false)); return { status: 'empty' }; }
  try {
    downloadJson(report); attempt(() => notify?.('窗口诊断已导出', false)); return { status: 'exported' };
  } catch {
    attempt(() => notify?.('窗口诊断导出失败，请重试', true)); return { status: 'failed' };
  }
}

export function bindWindowDiagnosticControls({ root, copyText, promptTextarea, downloadJson, notify, ...options }) {
  const start = root.querySelector('#sp-window-diagnostic-start'), copy = root.querySelector('#sp-window-diagnostic-copy');
  const exportButton = root.querySelector('#sp-window-diagnostic-export');
  const label = root.querySelector('#sp-window-diagnostic-start-label'), status = root.querySelector('#sp-window-diagnostic-status');
  const update = ({ recording, hasData }) => {
    if (label) label.textContent = recording ? '停止记录' : '开始记录';
    if (copy) copy.disabled = !hasData;
    if (exportButton) exportButton.disabled = !hasData;
    if (status) status.textContent = recording ? '正在记录，复现后回来复制。' : hasData ? '记录已保留，可复制。' : '尚未开始记录。';
  };
  const diagnostics = createWindowDiagnostics({ ...options, onChange: update });
  start?.addEventListener('click', () => diagnostics.state().recording ? diagnostics.stop() : diagnostics.start());
  copy?.addEventListener('click', () => { void shareWindowDiagnostics({ diagnostics, copyText, promptTextarea, notify }); });
  exportButton?.addEventListener('click', () => exportWindowDiagnostics({ diagnostics, downloadJson, notify }));
  update(diagnostics.state());
  return diagnostics;
}

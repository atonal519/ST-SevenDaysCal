import { renderTheaterPieceHtml } from './render.js';

// 棱 UI 只编排注入的宿主能力；它不读取 SillyTavern 全局对象，也不拥有生成状态。
export function createTheaterUi({ repository, templates, resolveRegen, draftCap = 10, feature, host = {} } = {}) {
    const injectedCapture = host.captureTarget || (chatId => ({ chatId, isCurrent: () => true }));
    host.captureTarget ||= injectedCapture;
    const esc = host.escapeHtml || (value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
    const attr = host.escapeAttr || esc;
    const state = { current: null, templates: [], source: null, lastRandom: null, bound: false, mountRoot: null, fsEsc: null, imageCleanup: null, settingsRoots: [], generationSeq: 0, templateSeq: 0, abortPending: false };
    const currentChat = () => host.getChatId?.() ?? '';
    const isCurrent = target => target?.isCurrent ? target.isCurrent() : true;
    const body = html => host.setBody?.(html);
    const renderCard = (piece, saved) => `<div class="sp-theater-card" data-id="${attr(piece.id)}"><div class="sp-theater-card-head"><span class="sp-theater-card-title">${esc(piece.title || '(未命名)')}</span><span class="sp-theater-card-time">${esc(piece.ts ? new Date(piece.ts).toLocaleString('zh-CN', { hour12: false }) : '')}</span></div><div class="sp-theater-card-actions"><button class="sp-theater-view" data-id="${attr(piece.id)}">查看</button>${saved ? `<button class="sp-theater-del-saved" data-id="${attr(piece.id)}">删除</button>` : `<button class="sp-theater-promote" data-id="${attr(piece.id)}">永久保存</button><button class="sp-theater-del-draft" data-id="${attr(piece.id)}">删除</button>`}</div></div>`;
    const renderTemplateButtons = templates => templates.length ? templates.map(t => `<button type="button" class="sp-theater-tpl-pick" data-uid="${attr(t.uid)}">${esc(t.title)}</button>`).join('') : '<div class="sp-theater-list-empty">暂无模板，可在设置 · 棱里新增</div>';
    const findPiece = id => [...(repository.loadDrafts(currentChat()) || []), ...(repository.loadSaved(injectedCapture() || null) || [])].find(piece => String(piece.id) === String(id));
    const renderManager = templates => {
        const count = (templates || []).length;
        const open = Boolean(host.getManagerOpen?.());
        host.setManagerHtml?.(`
            <details class="sp-theater-tpl-library"${open ? ' open' : ''}>
                <summary class="sp-theater-tpl-library-head">
                    <i class="fa-solid fa-chevron-right sp-theater-tpl-library-chevron"></i>
                    <span>模板库</span>
                    <span class="sp-theater-tpl-library-count">${count}</span>
                </summary>
                <div class="sp-theater-tpl-library-body">
                    <div class="sp-theater-tpl-add-row">
                        <input type="text" id="sp-theater-tpl-new-title" class="sp-input" placeholder="新模板标题">
                        <textarea id="sp-theater-tpl-new-text" class="sp-input" placeholder="新模板内容"></textarea>
                        <button class="sp-btn sp-btn-primary" id="sp-theater-tpl-add">+ 新增模板</button>
                    </div>
                    <div class="sp-theater-tpl-import-row">
                        <input type="file" id="sp-theater-tpl-import-file" accept=".txt,text/plain" hidden>
                        <button class="sp-btn" id="sp-theater-tpl-import">批量导入 txt</button>
                        <span class="sp-theater-tpl-import-hint">每条以 <code>title：</code> 起头，正文接 <code>content：</code>（可跨多行）</span>
                    </div>
                    <div class="sp-theater-tpl-manage-hint">查看 / 修改 / 删除模板请到世界书 <code>构画-棱-小剧场模板</code></div>
                </div>
            </details>
        `);
    };
    const render = () => {
        const drafts = (repository.loadDrafts(currentChat()) || []).slice().reverse(); const saved = (repository.loadSaved(injectedCapture() || null) || []).slice().reverse();
        const available = [...drafts, ...saved]; const currentExists = state.current?.id && available.some(piece => String(piece.id) === String(state.current.id)); const piece = state.current = currentExists ? state.current : (drafts[0] || saved[0] || null);
        const safeHtml = piece ? renderTheaterPieceHtml(piece, host.htmlOptions?.() || {}) : '';
        const result = piece ? `<div class="sp-theater-result-inner">${safeHtml}</div>` : '<div class="sp-empty sp-theater-result-empty"><i class="fa-solid fa-masks-theater"></i><p>填写场景与要求，生成一段小剧场</p></div>';
        const source = piece?.templateSource?.input ? `<div class="sp-theater-source-wrap"><button type="button" class="sp-theater-source-toggle" aria-expanded="false" title="查看本次实际使用内容"><i class="fa-solid fa-file-lines"></i><span>模板 · ${esc(piece.templateSource.title || '(无标题)')}</span><i class="fa-solid fa-chevron-down sp-theater-source-chevron"></i></button><div id="sp-theater-source-detail" class="sp-theater-source-detail" style="display:none"><div class="sp-theater-source-caption">本次实际使用内容</div><pre>${esc(piece.templateSource.input)}</pre></div></div>` : '';
        const op = piece ? `<div class="sp-theater-opbar"><button class="sp-btn sp-theater-regen">重新生成</button><input type="text" id="sp-theater-title" class="sp-input" placeholder="标题（可选）" value="${attr(piece.title || '')}"><button class="sp-btn sp-btn-primary sp-theater-save">永久保存</button></div>` : '';
        const resultBlock = piece ? `<div class="sp-theater-result-wrap"><button class="sp-theater-fullscreen-btn" type="button" title="全屏浏览小剧场"><i class="fa-solid fa-expand"></i></button><button class="sp-theater-fold-toggle" type="button" style="display:none"><i class="fa-solid fa-chevron-down"></i><span class="sp-theater-fold-label">展开全文</span></button><div class="sp-theater-result sp-theater-result-collapsible" id="sp-theater-result">${result}</div></div>` : `<div class="sp-theater-result" id="sp-theater-result">${result}</div>`;
        body(`<div class="sp-theater-input-area"><details class="sp-theater-tpl-picker" id="sp-theater-tpl-picker"><summary class="sp-theater-tpl-picker-summary"><i class="fa-solid fa-chevron-right sp-theater-tpl-picker-chevron"></i><span>选择模板起草（可选）</span></summary><div class="sp-theater-tpl-picker-body" id="sp-theater-tpl-picker-list"><div class="sp-theater-list-empty">加载中…</div></div></details><textarea id="sp-theater-input" class="sp-input sp-theater-textarea" placeholder="描述这段小剧场：场景、人物状态、想看的走向、字数等…">${esc(piece?.request || piece?.templateSource?.input || '')}</textarea><div class="sp-theater-btn-row"><button class="sp-btn sp-theater-random" title="从模板库随机抽一个模板直接生成"><i class="fa-solid fa-shuffle"></i> 随机</button><button class="sp-btn sp-btn-primary sp-theater-generate">生成小剧场</button></div></div><hr class="sp-theater-divider">${resultBlock}${source}${op}<hr class="sp-theater-divider"><div class="sp-theater-lists"><details class="sp-theater-list-group" open><summary>草稿（最多 ${draftCap} 条，新挤旧）</summary><div class="sp-theater-list">${drafts.length ? drafts.map(p => renderCard(p, false)).join('') : '<div class="sp-theater-list-empty">暂无草稿</div>'}</div></details><details class="sp-theater-list-group"${saved.length ? ' open' : ''}><summary>已永久保存（本对话）</summary><div class="sp-theater-list">${saved.length ? saved.map(p => renderCard(p, true)).join('') : '<div class="sp-theater-list-empty">暂无永久保存</div>'}</div></details></div>`);
        measureFold();
        void refreshTemplates();
    };
    const refreshTemplates = async () => {
        const seq = ++state.templateSeq;
        let next;
        try { next = await templates.list(); } catch { next = []; }
        if (seq !== state.templateSeq) return state.templates;
        state.templates = Array.isArray(next) ? next : [];
        try { renderManager(state.templates); } catch { /* 宿主设置区尚未挂载时不阻断面板模板列表 */ }
        try { host.setTemplateListHtml?.(renderTemplateButtons(state.templates)); } catch { /* 主面板尚未挂载时不阻断设置区模板管理器 */ }
        return state.templates;
    };
    const bindSettings = root => {
        const rootKey = root?.[0] || root;
        if (!rootKey || state.settingsRoots.some(entry => entry.key === rootKey)) return;
        state.settingsRoots.push({ key: rootKey, root });
        root.on('change.sp-theater-ui', '#sp-theater-style', function () { host.setStylePrompt?.(host.val?.('#sp-theater-style') || ''); });
        root.on('click.sp-theater-ui', '#sp-theater-tpl-add', async function () { const title = String(host.val?.('#sp-theater-tpl-new-title') || '').trim(); const text = String(host.val?.('#sp-theater-tpl-new-text') || '').trim(); if (!title && !text) return host.toast?.('模板标题或内容不能都为空', null, true); try { await templates.add(title || '(无标题)', text); host.val?.('#sp-theater-tpl-new-title', ''); host.val?.('#sp-theater-tpl-new-text', ''); await refreshTemplates(); host.toast?.('模板已新增'); } catch (error) { host.toast?.('新增失败：' + (error?.message || error), null, true); } });
        root.on('click.sp-theater-ui', '#sp-theater-tpl-import', () => host.triggerFileInput?.());
        root.on('change.sp-theater-ui', '#sp-theater-tpl-import-file', async function () { const file = this.files?.[0]; this.value = ''; if (!file) return; try { const items = templates.parse(await file.text()); if (!items.length) return host.toast?.('未解析到模板，请检查 txt 格式（需 title：起头）', null, true); const count = await templates.addBatch(items); await refreshTemplates(); host.toast?.(`已导入 ${count} 条模板`); } catch (error) { host.toast?.('导入失败：' + (error?.message || error), null, true); } });
    };
    const generate = async input => {
        const inputSnapshot = String(input || '').trim();
        if (!inputSnapshot) { host.toast?.('请先填写小剧场需求', null, true); return { status: 'invalid' }; }
        const requestSeq = ++state.generationSeq;
        const requestChatId = currentChat();
        state.abortPending = false;
        const selectedSource = state.source ? { ...state.source } : null;
        const requestSource = selectedSource ? { ...selectedSource, input: inputSnapshot } : null;
        body(host.loading?.('正在折射', 'sp-abort-theater') || '');
        const result = await feature.generate(inputSnapshot, { templateSource: requestSource });
        // A cancelled request may settle after a new owner starts. Only the latest
        // UI request may restore/render; otherwise A would overwrite B's loading UI.
        if (requestSeq !== state.generationSeq) return result;
        state.abortPending = false;
        if (result?.status === 'updated') {
            if (currentChat() !== requestChatId) return result;
            state.current = result.piece || state.current;
            if (state.source?.uid === selectedSource?.uid && state.source?.input === selectedSource?.input) state.source = null;
            if (host.isOpen?.()) { render(); if (host.notifyEnabled?.()) host.toast?.('棱已生成'); }
            else host.closedSuccess?.();
        } else if (result?.status === 'failed') {
            if (currentChat() !== requestChatId) return result;
            if (host.isOpen?.()) host.showError?.(result.error); else host.closedFailure?.();
        } else if (result?.status === 'cancelled' || result?.status === 'stale') {
            // Only an explicit user abort in the same still-open chat restores the
            // panel. CHAT_CHANGED/plugin shutdown/stale owners stay silent.
            if (result?.reason === 'aborted' && currentChat() === requestChatId && host.isOpen?.()) render();
        }
        return result;
    };
    const abortCurrent = () => {
        if (state.abortPending || !feature.busy) return false;
        state.abortPending = true;
        host.setAbortPending?.();
        const aborted = feature.abort('aborted');
        if (!aborted) state.abortPending = false;
        return aborted;
    };
    const bind = root => {
        if (state.bound) return; state.bound = true; state.mountRoot = root;
        root.on('click.sp-theater-ui', '.sp-theater-tpl-pick', function () { const tpl = state.templates.find(item => String(item.uid) === String(host.data?.(this, 'uid'))); if (!tpl) return; host.val?.('#sp-theater-input', tpl.text); state.source = { uid: tpl.uid, title: tpl.title, input: tpl.text }; host.closePicker?.(); host.focus?.('#sp-theater-input'); });
        root.on('click.sp-theater-ui', '.sp-theater-generate', function () { if (!feature.busy) generate(host.val?.('#sp-theater-input') || ''); });
        root.on('click.sp-theater-ui', '.sp-theater-random', async function () { if (feature.busy) return; let pool; try { pool = state.templates.length ? state.templates : await refreshTemplates(); } catch { pool = []; } if (!pool.length) return host.toast?.('模板库为空，先去设置 · 棱新增模板', null, true); const nonEmpty = pool.filter(t => String(t.text || '').trim()); if (!nonEmpty.length) return host.toast?.('模板库里没有可用的非空模板', null, true); const choices = nonEmpty.length > 1 ? nonEmpty.filter(t => String(t.uid) !== String(state.lastRandom)) : nonEmpty; const pick = choices[Math.floor(Math.random() * choices.length)] || nonEmpty[0]; const text = String(pick?.text || '').trim(); if (!text) return host.toast?.('随机到的模板内容为空，去设置补一下内容', null, true); state.lastRandom = pick.uid; state.source = { uid: pick.uid, title: pick.title, input: text }; host.val?.('#sp-theater-input', text); host.closePicker?.(); host.toast?.('已随机填入模板，请确认后再生成'); });
        root.on('click.sp-theater-ui', '.sp-theater-view', function () { const piece = findPiece(host.data?.(this, 'id')); if (piece) { state.current = piece; render(); host.scrollTop?.(); } });
        root.on('click.sp-theater-ui', '.sp-theater-del-draft', async function () { const target = host.captureTarget?.(currentChat()); const id = host.data?.(this, 'id'); const baseline = repository.draftBaseline?.(target?.chatId, id); if (await host.confirm?.('删除草稿', '确定删除这条小剧场草稿吗？') && isCurrent(target)) { const result = repository.deleteDraft(target.chatId, id, baseline); if (result?.ok && isCurrent(target)) render(); else if (result?.conflict && isCurrent(target)) host.toast?.('草稿已变化，请重新确认', null, true); } });
        root.on('click.sp-theater-ui', '.sp-theater-promote', function () { const target = host.captureTarget?.(currentChat()); const piece = (repository.loadDrafts(target.chatId) || []).find(p => p.id === host.data?.(this, 'id')); if (!piece) return; Promise.resolve(repository.promoteToSaved(target, piece)).then(result => { if (result?.ok && isCurrent(target)) { host.toast?.('已永久保存'); render(); } else if (!result?.cancelled && result?.commitState !== 'not-dispatched' && isCurrent(target)) host.toast?.('永久保存失败，请重试', null, true); }).catch(() => { if (isCurrent(target)) host.toast?.('永久保存失败，请重试', null, true); }); });
        root.on('click.sp-theater-ui', '.sp-theater-del-saved', async function () { const target = host.captureTarget?.(currentChat()); const id = host.data?.(this, 'id'); const baseline = repository.savedBaseline?.(target, id); if (!await host.confirm?.('删除永久保存', '确定从本对话删除这条已永久保存的小剧场吗？删除后无法恢复。') || !isCurrent(target)) return; try { const result = await repository.deleteSaved(target, id, { baseline }); if (isCurrent(target)) { if (result?.conflict) host.toast?.('永久稿已变化，请重新确认', null, true); else if (!result?.ok && !result?.cancelled) host.toast?.('删除永久稿失败，请重试', null, true); else render(); } } catch { if (isCurrent(target)) host.toast?.('删除永久稿失败，请重试', null, true); } });
        root.on('click.sp-theater-ui', '.sp-theater-save', async function () { if (!state.current) return; const target = host.captureTarget?.(currentChat()); const title = String(host.val?.('#sp-theater-title') || '').trim(); const piece = { ...state.current, title }; const draftBaseline = repository.draftBaseline?.(target.chatId, piece.id); const draftResult = repository.updateDraft?.(target.chatId, piece.id, { title }, draftBaseline); if (draftResult?.ok === false) { if (isCurrent(target)) host.toast?.(draftResult.conflict ? '草稿已变化，请重试' : '永久保存失败，请重试', null, true); return; } const updatedDraftBaseline = repository.draftBaseline?.(target.chatId, piece.id); try { const result = await repository.promoteToSaved(target, piece, { draftBaseline: updatedDraftBaseline }); if (result?.ok && isCurrent(target)) { state.current = piece; host.toast?.('已永久保存到本对话'); render(); } else if (result?.ok === false && isCurrent(target)) host.toast?.(result.conflict ? '内容已变化，请重试' : '永久保存失败，请重试', null, true); } catch { if (isCurrent(target)) host.toast?.('永久保存失败，请重试', null, true); } });
        // resolveTheaterRegen(state.current, textarea) is supplied by the feature boundary.
        root.on('click.sp-theater-ui', '.sp-theater-regen', function () { if (feature.busy || !state.current) return; const regen = resolveRegen(state.current, host.val?.('#sp-theater-input') || ''); if (!regen.input) { host.toast?.('旧草稿未记录原主题，请先填写输入', null, true); host.focus?.('#sp-theater-input'); return; } state.source = regen.templateSource; host.val?.('#sp-theater-input', regen.input); generate(regen.input); });
        root.on('click.sp-theater-ui', '.sp-theater-back', () => render());
        root.on('click.sp-theater-ui', '.sp-theater-source-toggle', () => toggleSource());
        root.on('click.sp-theater-ui', '.sp-theater-fullscreen-btn', () => toggleFullscreen());
        root.on('click.sp-theater-ui', '.sp-theater-fold-toggle', () => toggleFold());
        root.on('click.sp-theater-ui', '#sp-abort-theater', abortCurrent);
    };
    const toggleSource = () => {
        const open = !host.isSourceOpen?.();
        host.setSourceVisible?.(open);
        host.setSourceExpanded?.(open);
        host.setSourceChevron?.(open ? 'fa-solid fa-chevron-up sp-theater-source-chevron' : 'fa-solid fa-chevron-down sp-theater-source-chevron');
    };
    const setFoldControl = collapsed => host.setFoldControl?.(
        collapsed ? '展开全文' : '收起',
        collapsed ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up',
    );
    const measureFold = () => {
        if (!host.isResultFoldable?.()) { host.setFoldVisible?.(false); return; }
        const measure = () => {
            // 图片可在进入全屏后才 load；这时不能让迟到复测把“强制展开”的全屏结果重新折回去。
            if (host.isFullscreen?.()) { host.setResultCollapsed?.(false); return; }
            if ((host.getResultScrollHeight?.() || 0) > 400) {
                host.setResultCollapsed?.(true);
                host.setFoldVisible?.(true);
                setFoldControl(true);
            } else {
                host.setResultCollapsed?.(false);
                host.setFoldVisible?.(false);
            }
        };
        measure();
        // 图片可能在初测后才撑高内容；只给尚未完成的图片补一次复测。
        state.imageCleanup?.(); state.imageCleanup = host.onPendingResultImagesLoad?.(measure) || null;
    };
    const removeFullscreenEsc = () => {
        if (!state.fsEsc) return;
        host.removeKeydown?.(state.fsEsc);
        state.fsEsc = null;
    };
    const exitFullscreen = () => {
        host.setFullscreen?.(false);
        host.setSheetFlat?.(false);
        host.setBodyFullscreenLock?.(false);
        host.setFullscreenControl?.('fa-solid fa-expand', '全屏浏览小剧场');
        removeFullscreenEsc();
        measureFold();
    };
    const toggleFullscreen = () => {
        if (host.isFullscreen?.()) { exitFullscreen(); return; }
        host.setFullscreen?.(true);
        host.setSheetFlat?.(true);
        host.setResultCollapsed?.(false);
        host.setBodyFullscreenLock?.(true);
        host.setFullscreenControl?.('fa-solid fa-compress', '退出全屏');
        if (!state.fsEsc) {
            // Esc 的 listener 跟随当前 UI owner；每条退出路径都必须移除，避免重开后累积幽灵监听。
            state.fsEsc = event => {
                if (event?.key === 'Escape' && host.isFullscreen?.()) exitFullscreen();
            };
            host.addKeydown?.(state.fsEsc);
        }
    };
    const toggleFold = () => {
        const collapsed = host.toggleResultCollapsed?.();
        if (typeof collapsed !== 'boolean') return;
        setFoldControl(collapsed);
        if (collapsed) host.scrollFoldTop?.();
    };
    const closeVisual = () => exitFullscreen();
    const clearTransient = () => { state.imageCleanup?.(); state.imageCleanup = null; removeFullscreenEsc(); host.setFullscreen?.(false); host.setSheetFlat?.(false); host.setBodyFullscreenLock?.(false); };
    const resetForChat = () => { closeVisual(); state.generationSeq++; state.templateSeq++; state.abortPending = false; state.current = null; state.source = null; state.templates = []; };
    const cleanup = root => {
        (root || state.mountRoot)?.off?.('.sp-theater-ui');
        for (const entry of state.settingsRoots) entry.root?.off?.('.sp-theater-ui');
        state.settingsRoots = []; state.mountRoot = null;
        state.bound = false;
        resetForChat();
    };
    const destroy = () => {
        state.imageCleanup?.(); state.imageCleanup = null;
        (state.mountRoot)?.off?.('.sp-theater-ui');
        for (const entry of state.settingsRoots) entry.root?.off?.('.sp-theater-ui');
        state.settingsRoots = []; state.mountRoot = null; state.bound = false;
        removeFullscreenEsc(); state.generationSeq++; state.templateSeq++; state.abortPending = false; state.current = null; state.source = null; state.templates = [];
    };
    return { render, bind, bindSettings, refreshTemplates, generate, closeVisual, clearTransient, resetForChat, cleanup, destroy, get state() { return state; } };
}

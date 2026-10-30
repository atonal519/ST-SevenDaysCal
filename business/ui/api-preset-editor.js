export function openApiPresetEditor({ documentRef: doc = globalThis.document, dialog, actions, role, parseExcludeParams, fetchModels, onSaved = () => {} }) {
    const isNew = !role, captured = isNew ? { target: null, name: '', profile: { url: '', key: '', model: '', excludeParams: [], spAdditionalParams: '', timeoutSec: 180, stream: false } } : actions.capture(role);
    const initial = captured.profile;
    let alive = true, deleted = false;
    const el = (tag, className = '', text = '') => { const node = doc.createElement(tag); node.className = className; node.textContent = text; return node; };
    const form = el('form', 'sp-api-editor-form');
    const input = (id, value, type = 'text') => { const node = el('input', 'sp-input'); node.id = `sp-api-editor-${id}`; node.type = type; node.value = value; return node; };
    const field = (name, node) => { const label = el('label', 'sp-api-editor-field'); label.append(el('span', '', name), node); return label; };
    const name = input('name', captured.name), url = input('url', initial.url, 'url'), key = input('key', '', 'password'), model = input('model', initial.model);
    name.disabled = !isNew && !captured.target.presetId; name.setAttribute('aria-label', '预设名称');
    key.autocomplete = 'off'; key.placeholder = isNew ? '输入 API Key' : initial.key ? '已保存，留空保持不变' : '输入 API Key'; url.placeholder = 'https://example.invalid/v1'; model.placeholder = '留空使用默认 gpt-4o-mini';
    const feedback = el('p', 'sp-cfg-hint sp-api-editor-feedback'); feedback.setAttribute('aria-live', 'polite');
    const message = (text, error = false) => { if (alive) { feedback.textContent = text; feedback.classList.toggle('sp-api-editor-error', error); } };
    const tool = (title, action, unavailable = () => false) => {
        const button = el('button', 'sp-dialog-button sp-dialog-button-secondary', title); button.type = 'button';
        button.addEventListener('click', async () => { if (button.disabled) return; button.disabled = true; try { await action(); } catch (error) { message(error?.message || '操作失败，请重试。', true); } finally { button.disabled = !alive || unavailable(); } });
        return button;
    };
    const exclude = el('textarea', 'sp-input'), additional = el('textarea', 'sp-input'); exclude.rows = 2; exclude.value = initial.excludeParams.join('\n'); additional.rows = 3; additional.value = initial.spAdditionalParams;
    const timeout = input('timeout', initial.timeoutSec, 'number'); timeout.min = '5'; timeout.max = '600';
    const stream = input('stream', '', 'checkbox'); stream.checked = initial.stream;
    const read = () => ({ url: url.value, key: key.value, model: model.value, excludeParams: parseExcludeParams(exclude.value), spAdditionalParams: additional.value, timeoutSec: Number(timeout.value), stream: stream.checked });
    const modelRow = el('div', 'sp-api-editor-inline'), models = el('details', 'sp-model-list-section'); models.hidden = true;
    const modelSummary = el('summary', 'sp-model-list-summary'), search = input('model-search', ''), list = el('div', 'sp-model-list-items'); search.type = 'search'; search.placeholder = '搜索模型…';
    let names = [];
    const renderModels = () => { const query = search.value.trim().toLocaleLowerCase(); list.replaceChildren(...names.filter(value => value.toLocaleLowerCase().includes(query)).map(value => tool(value, async () => { model.value = value; }))); if (!list.children.length) list.append(el('p', 'sp-cfg-hint', '无匹配项')); };
    search.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); } });
    search.addEventListener('input', renderModels); models.append(modelSummary, search, list);
    modelRow.append(model, tool('拉取模型', async () => {
        const draft = read(), saved = !isNew && !deleted ? actions.read(captured.target) : null;
        const values = await fetchModels({ ...draft, key: draft.key.trim() || saved?.key || '' }); if (!alive) return;
        names = values; modelSummary.textContent = `已加载 ${values.length} 个模型`; models.hidden = false; models.open = true; renderModels();
    }));
    const advanced = el('details', 'sp-adv-api'), advancedBody = el('div', 'sp-adv-api-body'), check = el('label', 'sp-api-editor-check'); check.append(stream, el('span', '', '流式传输'));
    advanced.append(el('summary', 'sp-adv-api-summary', '接口高级选项')); advancedBody.append(field('剔除参数（换行或逗号分隔）', exclude), field('附加参数（JSON）', additional), field('请求超时（秒）', timeout), check); advanced.append(advancedBody);
    form.append(field('预设名称', name), field('URL', url), field('Key', key), field('模型', modelRow), models, advanced);
    if (!isNew) {
        const tools = el('div', 'sp-api-editor-actions'), copy = el('div', 'sp-api-editor-confirm'), confirm = el('div', 'sp-api-editor-confirm'); copy.hidden = true; confirm.hidden = true;
        const copyName = input('copy-name', '');
        copyName.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); copy.querySelector('button')?.click(); } });
        copy.append(field('副本名称', copyName), tool('保存副本', async () => { await actions.create(copyName.value, read(), deleted ? null : captured.target); if (alive) { copy.hidden = true; onSaved(); message('已另存共享连接，当前用途保持不变。'); } }), tool('取消另存', async () => { copy.hidden = true; }));
        tools.append(tool('另存为', async () => { copyName.value = name.value; copy.hidden = false; copyName.focus(); }));
        if (captured.target.presetId) {
            const remove = tool('删除', async () => { confirm.hidden = false; }, () => deleted); remove.classList.add('sp-api-editor-danger');
            confirm.append(el('p', 'sp-cfg-hint', `删除「${captured.name}」？共享引用会清理；当前内容 API 已应用的配置保留。`), tool('确认删除', async () => { await actions.remove(captured.target.presetId); if (alive) { deleted = true; remove.disabled = true; confirm.hidden = true; key.placeholder = '原连接已删除，另存请输入 Key'; onSaved(); message('预设已删除，原输入保留；填写 Key 后可另存。'); } }), tool('返回编辑', async () => { confirm.hidden = true; })); tools.append(remove);
        }
        form.append(tools, copy, confirm);
    }
    form.append(feedback);
    form.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const panel = form.closest('[role=dialog]');
        const controls = [...panel.querySelectorAll('button,input,textarea,select,a[href],summary')].filter(node => {
            const closed = node.closest('details:not([open])');
            return !node.disabled && node.getClientRects().length && (!closed || String(node.tagName).toLowerCase() === 'summary' && node.parentElement === closed);
        });
        const at = controls.indexOf(form.getRootNode().activeElement);
        event.preventDefault(); event.stopPropagation(); controls[(at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    });
    return dialog.custom({ title: isNew ? '新增 API' : `编辑${role === 'utility' ? '机械任务' : role === 'theater' ? '小剧场' : '内容'} API`, content: form, confirmText: '保存', cancelText: '取消', onClose: () => { alive = false; }, submit: async () => {
        try {
            if (isNew) await actions.create(name.value, read());
            else {
                if (deleted) throw new Error('原预设已删除，请另存为新连接。');
                const value = read(), patch = {};
                for (const field of Object.keys(value)) if (field === 'key' || JSON.stringify(value[field]) !== JSON.stringify(initial[field])) patch[field] = value[field];
                await actions.save(captured.target, patch, name.value !== captured.name ? name.value : undefined);
            }
            if (alive) onSaved(); return true;
        } catch (error) { message(error?.message || '保存失败，请重试。', true); throw error; }
    } });
}

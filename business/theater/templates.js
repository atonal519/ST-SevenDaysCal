export function createTheaterTemplates({ context, bookName = '构画-棱-小剧场模板' } = {}) {
    const entryToTemplate = (uid, entry) => ({ uid: String(uid), title: String(entry.comment || '').trim() || '(无标题)', text: String(entry.content || '') });
    const ensureBook = async ({ persistMissing = true } = {}) => {
        const ctx = context(); const data = await ctx.loadWorldInfo(bookName);
        if (data) return data.entries ? data : { entries: {} };
        if (persistMissing) { await ctx.saveWorldInfo(bookName, { entries: {} }, true); await ctx.updateWorldInfoList?.(); }
        return { entries: {} };
    };
    const createEntry = (ctx, data) => {
        if (ctx.worldInfoEntry?.create) return ctx.worldInfoEntry.create(bookName, data);
        let uid = 0; while (uid in data.entries) uid++;
        const entry = { uid, key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true, selectiveLogic: 0, order: 100, position: 0, disable: true, excludeRecursion: false, preventRecursion: false, probability: 100, useProbability: true, depth: 4 };
        data.entries[uid] = entry; return entry;
    };
    return {
        async list() { const data = await context().loadWorldInfo(bookName); if (!data?.entries) return []; return Object.entries(data.entries).map(([uid, entry]) => entryToTemplate(uid, entry)).sort((a, b) => Number(a.uid) - Number(b.uid)); },
        async add(title, text) { const ctx = context(); const data = await ensureBook(); const entry = createEntry(ctx, data); if (!entry) throw new Error('无法创建模板条目'); entry.comment = String(title || '').trim(); entry.content = String(text || ''); entry.disable = true; entry.key = []; entry.constant = false; await ctx.saveWorldInfo(bookName, data, true); return entryToTemplate(entry.uid, entry); },
        async addBatch(items) { const list = (Array.isArray(items) ? items : []).filter(it => it && (String(it.title || '').trim() || String(it.text || '').trim())); if (!list.length) return 0; const ctx = context(); const existing = await ctx.loadWorldInfo(bookName); const data = existing ? (existing.entries ? existing : { entries: {} }) : { entries: {} }; for (const it of list) { const entry = createEntry(ctx, data); if (!entry) continue; entry.comment = String(it.title || '').trim(); entry.content = String(it.text || ''); entry.disable = true; entry.key = []; entry.constant = false; } await ctx.saveWorldInfo(bookName, data, true); if (!existing) await ctx.updateWorldInfoList?.(); return list.length; },
        async update(uid, title, text) { const ctx = context(); const data = await ctx.loadWorldInfo(bookName); if (!data?.entries?.[uid]) return; data.entries[uid].comment = String(title || '').trim(); data.entries[uid].content = String(text || ''); data.entries[uid].disable = true; await ctx.saveWorldInfo(bookName, data, true); },
        async remove(uid) { const ctx = context(); const data = await ctx.loadWorldInfo(bookName); if (!data?.entries?.[uid]) return; delete data.entries[uid]; await ctx.saveWorldInfo(bookName, data, true); },
    };
}

export function parseTemplateText(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'); const items = []; let current = null;
    for (const line of lines) {
        const match = /^\s*title\s*[:：]\s*(.*)$/i.exec(line);
        if (match) { if (current) items.push(current); current = { title: match[1].trim(), bodyLines: [] }; continue; }
        if (current) current.bodyLines.push(line);
    }
    if (current) items.push(current);
    return items.map(item => ({ title: item.title, text: item.bodyLines.join('\n').replace(/^[ \t]*content[ \t]*[：:][ \t]*/i, '').replace(/^\n+/, '').replace(/\n+$/, '') })).filter(item => item.title || item.text);
}

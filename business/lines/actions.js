import { deleteLine, togglePin, editLineFields } from './mutations.js';
import { parseLines } from './schema.js';

export function createLinesActions(env = {}) {
    let preparing = false;
    let editing = false;
    let editToken = null;
    const refresh = () => { env.setCached?.(env.render?.(env.readRaw?.() || '')); env.refreshPanel?.(); env.refreshInline?.(); };
    const runExclusive = async (silent, options) => {
        if (preparing || editing || env.isBusy?.()) return;
        preparing = true;
        try {
            if (!await env.precheck?.()) return;
            return await env.runGenerate?.(silent, options);
        } finally {
            preparing = false;
        }
    };
    return {
        async edit(index) {
            if (env.isBusy?.()) return;
            const saved = env.readSaved?.(); const raw = saved?.raw || ''; const target = parseLines(raw)[Number(index)];
            if (!target) return env.toast?.('这条线已不存在，请刷新面板', true);
            if (editing || env.editing?.()) return;
            const token = Symbol('line-edit'); editToken = token; editing = true;
            env.setEditing?.(true);
            let value;
            try { value = env.promptFields ? await env.promptFields({ title: `编辑「${target.name || '未命名'}」`, fields: [{ name: 'desc', label: '当前描述', value: target.desc || '', rows: 3 }, { name: 'next', label: '下一步', value: target.next || '', rows: 2 }] }) : await env.promptTextarea?.({ title: `编辑「${target.name || '未命名'}」`, initialValue: target.desc || '' }); }
            finally { if (editToken === token) { editToken = null; editing = false; env.setEditing?.(false); } }
            if (value === null || value === undefined) return;
            const latest = env.readSaved?.(); if (latest?.raw !== raw || latest?.ts !== saved?.ts) return env.toast?.('线已变化，请重新打开编辑', true);
            const result = editLineFields(raw, Number(index), typeof value === 'object' ? value : { desc: value }); if (!result.ok) return env.toast?.('编辑失败，请刷新后重试', true);
            env.write?.({ ...saved, raw: result.raw, ts: Date.now() }); refresh(); env.toast?.('已保存线描述');
        },
        async delete(index) {
            if (env.isBusy?.()) return;
            const saved = env.readSaved?.(); const raw = saved?.raw || '';
            const target = parseLines(raw)[Number(index)];
            if (!target) return env.toast?.('这条线已不存在，请刷新面板', true);
            if (!(await env.confirm?.({ title: '删除这条线', body: `将删除「${target.name || '未命名'}」这一条，其它事件线保留。此操作不可撤销。`, confirmText: '删除', cancelText: '取消' }))) return;
            const result = deleteLine(raw, Number(index));
            if (!result.ok) return env.toast?.('删除失败：条目错位，请刷新后重试', true);
            if (!result.raw) env.remove?.(); else env.write?.({ ...saved, raw: result.raw, ts: Date.now() });
            if (!result.raw) env.resetCounter?.();
            refresh(); env.toast?.(result.raw ? '已删除这条线' : '已删除，事件线已清空');
        },
        pin(index) {
            const saved = env.readSaved?.(); const result = togglePin(saved?.raw || '', Number(index));
            if (!result.ok) return env.toast?.('这条线已不存在，请刷新面板', true);
            env.write?.({ raw: result.raw, ts: Date.now() }); refresh(); env.toast?.(result.model[Number(index)]?.pin ? '已锁定这条线' : '已解锁这条线');
        },
        async generate() { return runExclusive(false, { reroll: true }); },
        async advance() { return runExclusive(env.silent?.(), undefined); },
        async reroll() { return runExclusive(false, { reroll: true }); },
        isEditing: () => editing,
    };
}

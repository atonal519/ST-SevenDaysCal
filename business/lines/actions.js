import { deleteLine, togglePin } from './mutations.js';
import { parseLines } from './schema.js';

export function createLinesActions(env = {}) {
    const refresh = () => { env.setCached?.(env.render?.(env.readRaw?.() || '')); env.refreshPanel?.(); env.refreshInline?.(); };
    return {
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
        async generate() { if (!env.isBusy?.() && await env.precheck?.()) return env.runGenerate?.(false, { reroll: true }); },
        async advance() { if (!env.isBusy?.() && await env.precheck?.()) return env.runGenerate?.(env.silent?.()); },
        async reroll() { if (!env.isBusy?.() && await env.precheck?.()) return env.runGenerate?.(false, { reroll: true }); },
    };
}

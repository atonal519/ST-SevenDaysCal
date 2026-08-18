// automation-gate.js — 楼层自动更新接管闸门
//
// 显式工作流可以声明“本楼的哪些自动模块由我接管”。各模块只查询自身是否被接管，
// 不需要认识具体业务流程。闸门只保存内存状态，不修改任何模块计数器。

export function createAutomationGate() {
    const claims = new Map();
    let claimSeq = 0;

    function claim({ scopeId, messageId, modules } = {}) {
        const scopeKey = String(scopeId ?? '').trim();
        const mid = Number(messageId);
        if (!scopeKey || !Number.isInteger(mid) || !Array.isArray(modules)) return null;
        const names = new Set(modules.map(value => String(value || '').trim()).filter(Boolean));
        if (!names.size) return null;
        const token = Object.freeze({ id: ++claimSeq });
        claims.set(token, { scopeId: scopeKey, messageId: mid, modules: names });
        return token;
    }

    function isSuppressed({ scopeId, messageId, module: moduleName } = {}) {
        const scopeKey = String(scopeId ?? '').trim();
        const mid = Number(messageId);
        const name = String(moduleName || '').trim();
        if (!scopeKey || !Number.isInteger(mid) || !name) return false;
        for (const record of claims.values()) {
            if (record.scopeId === scopeKey && record.messageId === mid && record.modules.has(name)) return true;
        }
        return false;
    }

    function release(token) {
        return claims.delete(token);
    }

    function clear() {
        claims.clear();
    }

    return Object.freeze({ claim, isSuppressed, release, clear });
}

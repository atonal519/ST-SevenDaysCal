// runtime/registry.js — 模块注册表 + 生命周期分发（Phase 0 基础设施）
//
// 目的：把 index.js 巨石里「每个业务模块各自为政、靠 _stListeners.chat 里 100 行手工复位清单」
// 的现状，收敛为统一的模块生命周期机制。后续 Phase 1–5 各业务模块调用 registerModule 注册自己，
// index.js 只在 chat/char 事件里调用 dispatch* 做统一分发——谁的状态谁复位，机制化、不再人肉记清单。
//
// 本文件为「新增基础设施」，不含任何业务逻辑；Phase 0 只定义机制，不接线（接线在后续 Phase）。

/**
 * @typedef {Object} Module
 * @property {string} name                           模块唯一名（如 'point' / 'line' / 'plane'）
 * @property {(ctx: any) => void} [init]             首次装载时执行（挂 DOM、绑事件、读设置）
 * @property {(ctx: any) => void} [onChatChanged]    切对话/清对话时执行——复位本模块自己的状态
 * @property {(ctx: any) => void} [onCharChanged]    切角色时执行（若与 chat 不同则单独暴露）
 * @property {(ctx: any) => void} [render]           需要重绘本模块视图时执行
 */

const modules = [];

/**
 * 注册一个业务模块。同名模块重复注册会抛错，防止拆分过程中误注册两次。
 * @param {Module} mod
 * @returns {Module}
 */
export function registerModule(mod) {
    if (!mod || typeof mod.name !== 'string' || !mod.name) {
        throw new Error('[registry] registerModule: module.name 必填');
    }
    if (modules.some((m) => m.name === mod.name)) {
        throw new Error('[registry] registerModule: 模块名重复 -> ' + mod.name);
    }
    modules.push(mod);
    return mod;
}

/** 只读快照，供调试/审计检查已注册模块。 */
export function listModules() {
    return modules.slice();
}

/**
 * 生命周期分发核心：逐个调用已注册模块的钩子，单模块异常不阻断其余模块。
 * 顺序 = 注册顺序；模块间如需严格顺序依赖，应在调用方按依赖序注册。
 */
function dispatch(hook, ctx) {
    for (const m of modules) {
        const fn = m[hook];
        if (typeof fn !== 'function') continue;
        try {
            fn(ctx);
        } catch (e) {
            // 不吞错、也不让单个模块拖垮整个分发：打日志 + 继续
            console.error('[registry] ' + hook + ' 执行失败 -> 模块 ' + m.name, e);
        }
    }
}

/** 首次装载：挂 DOM / 绑事件 / 读设置。 */
export function dispatchInit(ctx) {
    dispatch('init', ctx);
}

/**
 * 切对话 / 清对话：复位各模块自身状态。
 * 这是 Phase 0 之后要逐步替代 _stListeners.chat 里手工复位清单的关键钩子。
 */
export function dispatchChatChanged(ctx) {
    dispatch('onChatChanged', ctx);
}

/** 切角色。 */
export function dispatchCharChanged(ctx) {
    dispatch('onCharChanged', ctx);
}

/** 重绘视图。 */
export function dispatchRender(ctx) {
    dispatch('render', ctx);
}

export default {
    registerModule,
    listModules,
    dispatchInit,
    dispatchChatChanged,
    dispatchCharChanged,
    dispatchRender,
};

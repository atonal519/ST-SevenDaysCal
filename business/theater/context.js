export function createTheaterStoryContext({ getContext, buildWorldInfoContext, readCardExtras, buildRecentContext, getRecentMesIds, getMemText, owners } = {}) {
    return async function build(owner = null) {
        const ctx = getContext(); const chatId = ctx.chatId; const revision = owners?.currentChatRevision?.() ?? 0;
        const userName = ctx.name1 || '用户'; const charName = ctx.name2 || '角色'; const char = ctx.characters?.[ctx.characterId] ?? {}; const cardData = char.data || {};
        const substitute = typeof ctx.substituteParams === 'function' ? value => ctx.substituteParams(value) : value => value;
        const cardDescription = String(substitute(char.description ?? cardData.description ?? '') || '').trim();
        const cardPersonality = String(substitute(char.personality ?? cardData.personality ?? '') || '').trim();
        const cardScenario = String(substitute(char.scenario ?? cardData.scenario ?? '') || '').trim();
        // 同步材料和既有可见楼选择先固定，再启动异步来源；内置记忆排除与最近剧情使用同一组消息 ID。
        const { personaDesc, authorNote } = readCardExtras(ctx);
        const recentPromise = Promise.resolve(buildRecentContext?.(ctx) || '');
        const excludeMesIds = getRecentMesIds?.(ctx) || [];
        let worldInfoPromise;
        try { worldInfoPromise = Promise.resolve(buildWorldInfoContext(ctx)).catch(() => ''); } catch { worldInfoPromise = Promise.resolve(''); }
        const memoryPromise = Promise.resolve().then(() => getMemText({ excludeMesIds }))
            .then(value => ({ value }), error => ({ error }));
        const recentContext = await recentPromise;
        let wiContext = '';
        try { wiContext = await worldInfoPromise; } catch { wiContext = ''; }
        if (owner && !owners.isValid(owner, { chatId, chatRevision: revision })) throw Object.assign(new Error('theater-story-stale'), { name: 'AbortError' });
        const memoryResult = await memoryPromise;
        if ('error' in memoryResult) throw memoryResult.error;
        const memText = memoryResult.value;
        if (owner && !owners.isValid(owner, { chatId, chatRevision: revision })) throw Object.assign(new Error('theater-story-stale'), { name: 'AbortError' });
        return { userName, charName, sysBlocks: [personaDesc ? `【${userName} 的人物设定】\n${personaDesc}` : '', cardDescription ? `【${charName} 的背景资料】\n${cardDescription}` : '', cardPersonality ? `【性格】${cardPersonality}` : '', cardScenario ? `【场景】${cardScenario}` : '', authorNote ? `【作者注释（当前聊天）】\n${authorNote}` : '', recentContext, wiContext, memText ? `【故事记忆库】以下是当前选择的剧情记忆材料；内置记忆会分别标注已验证摘要与尚未摘要的近期正文，作为既有背景，请按标签理解并保持连贯：\n\n${memText}` : ''].filter(Boolean) };
    };
}

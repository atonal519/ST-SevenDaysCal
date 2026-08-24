export function createTheaterStoryContext({ getContext, buildWorldInfoContext, readCardExtras, getMemText, owners } = {}) {
    return async function build(owner = null) {
        const ctx = getContext(); const chatId = ctx.chatId; const revision = owners?.currentChatRevision?.() ?? 0;
        const userName = ctx.name1 || '用户'; const charName = ctx.name2 || '角色'; const char = ctx.characters?.[ctx.characterId] ?? {};
        let wiContext = ''; try { wiContext = await buildWorldInfoContext(ctx); } catch { wiContext = ''; }
        if (owner && (!owners.isValid(owner, { chatId, chatRevision: revision }) || getContext().chatId !== chatId)) throw Object.assign(new Error('theater-story-stale'), { name: 'AbortError' });
        const { personaDesc, authorNote } = readCardExtras(ctx); let memText = ''; try { memText = await getMemText(); } catch { memText = ''; }
        if (owner && (!owners.isValid(owner, { chatId, chatRevision: revision }) || getContext().chatId !== chatId)) throw Object.assign(new Error('theater-story-stale'), { name: 'AbortError' });
        return { userName, charName, sysBlocks: [personaDesc ? `【${userName} 的人物设定】\n${personaDesc}` : '', char.description ? `【${charName} 的背景资料】\n${char.description}` : '', char.personality ? `【性格】${char.personality}` : '', char.scenario ? `【场景】${char.scenario}` : '', authorNote ? `【作者注释（当前聊天）】\n${authorNote}` : '', wiContext, memText ? `【故事记忆库】以下是本插件自动生成的剧情客观摘要（从最早到近期的关键事件与伏笔），作为这段小剧场的既有背景，注意与之保持连贯：\n\n${memText}` : ''].filter(Boolean) };
    };
}

// API modal mutations stay within the existing shared settings and content snapshot.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fields = ['url', 'key', 'model', 'excludeParams', 'spAdditionalParams', 'timeoutSec', 'stream'];
const flatKeys = { url: 'apiUrl', key: 'apiKey', model: 'apiModel', excludeParams: 'apiExcludeParams', spAdditionalParams: 'apiAdditionalParams', timeoutSec: 'apiTimeoutSec', stream: 'apiStream' };
const profile = value => ({ url: value?.url || '', key: value?.key || '', model: value?.model || '', excludeParams: Array.isArray(value?.excludeParams) ? [...value.excludeParams] : [], spAdditionalParams: value?.spAdditionalParams || '', timeoutSec: Number.isInteger(Number(value?.timeoutSec)) && Number(value.timeoutSec) >= 5 && Number(value.timeoutSec) <= 600 ? Number(value.timeoutSec) : 180, stream: value?.stream === true });
const currentProfile = settings => profile(Object.fromEntries(fields.map(field => [field, settings[flatKeys[field]]])));
function rollbackList(before, applied, latest) {
  let list = [...latest];
  for (const id of new Set([...before, ...applied].filter(object).map(p => p.id).filter(Boolean))) {
    const old = before.find(p => p?.id === id), next = applied.find(p => p?.id === id), at = list.findIndex(p => p?.id === id);
    if (same(old, next)) continue;
    if (!old) { if (at >= 0 && same(list[at], next)) list.splice(at, 1); }
    else if (!next) { if (at < 0) list.push(old); }
    else if (at >= 0 && object(list[at])) {
      const value = { ...list[at] };
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (same(old[key], next[key]) || !same(value[key], next[key]) || Object.hasOwn(value, key) !== Object.hasOwn(next, key)) continue;
        if (Object.hasOwn(old, key)) value[key] = old[key]; else delete value[key];
      }
      list[at] = value;
    }
  }
  return list;
}
export function createApiEditorActions({ getSettings, saveSettings, validateAdditional, createId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }) {
  const raw = () => Array.isArray(getSettings().apiPresets) ? getSettings().apiPresets : [];
  const find = id => raw().find(p => object(p) && p.id === id);
  const requirePreset = id => { const value = find(id); if (!value) throw new Error('这条共享预设已不存在，请重新选择。'); return value; };
  async function commit(patch) {
    const settings = getSettings(), before = Object.fromEntries(Object.keys(patch).map(key => [key, { has: Object.hasOwn(settings, key), value: structuredClone(settings[key]) }])), applied = structuredClone(patch);
    Object.assign(settings, patch);
    try { await saveSettings(); }
    catch (error) {
      const live = getSettings();
      for (const [key, old] of Object.entries(before)) {
        if (key === 'apiPresets' && Array.isArray(applied[key]) && Array.isArray(live[key])) { live[key] = rollbackList(Array.isArray(old.value) ? old.value : [], applied[key], live[key]); if (!old.has && !live[key].length) delete live[key]; }
        else if (same(live[key], applied[key])) { if (old.has) live[key] = old.value; else delete live[key]; }
      }
      throw error;
    }
  }
  function read(target) {
    if (target.presetId) {
      const preset = requirePreset(target.presetId);
      return target.kind === 'content' && getSettings().apiPresetActiveId === target.presetId ? currentProfile(getSettings()) : profile(preset);
    }
    if (target.kind !== 'content' || (getSettings().apiPresetActiveId || '') !== (target.activeId || '')) throw new Error('内容 API 已切换，请重新打开编辑。');
    return currentProfile(getSettings());
  }
  function checked(value) {
    const result = { ...value, url: String(value.url || '').trim().replace(/\/$/, ''), key: String(value.key || '').trim(), model: String(value.model || '').trim(), spAdditionalParams: String(value.spAdditionalParams || '').trim() };
    if (!result.url || !result.key) throw new Error('请填写 URL 和 Key。');
    if (!Number.isInteger(Number(result.timeoutSec)) || Number(result.timeoutSec) < 5 || Number(result.timeoutSec) > 600) throw new Error('请求超时需填写 5–600 秒。');
    result.timeoutSec = Number(result.timeoutSec); validateAdditional(result.spAdditionalParams); return result;
  }
  return {
    list: () => raw().filter(p => object(p) && p.id),
    capture(role) {
      const s = getSettings(), id = role === 'utility' ? s.utilityPresetId : role === 'theater' ? s.theaterPresetId : '';
      const selected = id && find(id);
      if (selected?.url && selected?.key) return { target: { kind: 'preset', presetId: id }, profile: profile(selected), name: selected.name || '未命名' };
      const active = s.apiPresetActiveId && find(s.apiPresetActiveId);
      return { target: { kind: 'content', presetId: active?.id || '', activeId: s.apiPresetActiveId || '' }, profile: currentProfile(s), name: active?.name || '主配置' };
    },
    read,
    async select(role, id) {
      if (id) requirePreset(id);
      if (role === 'content') {
        const patch = { apiPresetActiveId: id || '' };
        if (id) { const cfg = profile(requirePreset(id)); validateAdditional(cfg.spAdditionalParams); for (const field of fields) patch[flatKeys[field]] = cfg[field]; }
        await commit(patch);
      } else await commit({ [role === 'utility' ? 'utilityPresetId' : 'theaterPresetId']: id || '' });
    },
    async save(target, patch, name) {
      const cfg = checked({ ...read(target), ...patch, key: String(patch.key || '').trim() || read(target).key });
      const updates = {}, s = getSettings();
      if (target.presetId) {
        const label = String(name === undefined ? requirePreset(target.presetId).name || '未命名' : name).trim(); if (!label) throw new Error('请输入预设名称。');
        updates.apiPresets = raw().map(item => {
          if (!object(item) || item.id !== target.presetId) return item;
          const result = { ...item, ...cfg, name: label }; if (!cfg.spAdditionalParams) delete result.spAdditionalParams; return result;
        });
      }
      if (target.kind === 'content' && (s.apiPresetActiveId || '') === (target.activeId || '')) for (const field of fields) updates[flatKeys[field]] = cfg[field];
      await commit(updates);
    },
    async create(name, input, baseTarget) {
      const label = String(name || '').trim(); if (!label) throw new Error('请输入预设名称。');
      const base = baseTarget ? read(baseTarget) : profile({}), cfg = checked({ ...base, ...input, key: String(input.key || '').trim() || base.key });
      const original = baseTarget?.presetId ? requirePreset(baseTarget.presetId) : {}, id = createId();
      const created = { ...original, ...cfg, id, name: label }; if (!cfg.spAdditionalParams) delete created.spAdditionalParams;
      await commit({ apiPresets: [...raw(), created] }); return id;
    },
    async remove(id) {
      requirePreset(id); const patch = { apiPresets: raw().filter(p => !object(p) || p.id !== id) }, s = getSettings();
      for (const key of ['apiPresetActiveId', 'utilityPresetId', 'theaterPresetId']) if (s[key] === id) patch[key] = '';
      await commit(patch);
    },
  };
}

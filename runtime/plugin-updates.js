const installationError = () => new Error('无法识别构画的安装位置，请到酒馆扩展页检查安装。');
export function resolvePluginInstallation({ moduleUrl, extensionTypes } = {}) {
  const url = new URL(moduleUrl), match = url.pathname.match(/\/scripts\/extensions\/(third-party\/([^/]+))\//);
  if (!match) throw installationError();
  const id = decodeURIComponent(match[1]), extensionName = decodeURIComponent(match[2]);
  const type = extensionTypes?.[id];
  if (!['local', 'global'].includes(type)) throw installationError();
  return { extensionName, global: type === 'global', baseUrl: new URL(`/scripts/extensions/${match[1]}/`, url).href };
}
const requestError = (operation, status) => new Error(status === 403
  ? '没有更新全局扩展的权限，请用管理员账号到酒馆扩展页更新。'
  : status === 404 ? '更新接口或安装目录不可用，请到酒馆扩展页确认安装及扩展功能已启用。'
  : status === 409 ? '更新未完成：检测到本地修改或版本冲突，请到酒馆扩展页处理后再更新。'
  : `${operation}失败，请到酒馆扩展页检查后重试。`);
function remoteBase(info) {
  const raw = String(info.remoteUrl ?? '').replace(/^git@github\.com:/, 'https://github.com/');
  let url; try { url = new URL(raw); } catch { return null; }
  if (url.hostname !== 'github.com') return null;
  const parts = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
  if (parts.length !== 2 || !info.currentBranchName) return null;
  return `https://raw.githubusercontent.com/${parts.map(encodeURIComponent).join('/')}/${encodeURIComponent(info.currentBranchName)}/`;
}
function noticeUrl(base, pointer) {
  if (typeof pointer !== 'string' || !pointer.trim()) return null;
  const url = new URL(pointer, base);
  return url.href.startsWith(base) && !url.search && !url.hash ? url.href : null;
}
export function createPluginUpdates({ moduleUrl = import.meta.url, extensionTypes = () => ({}), noticePath = '', fetchImpl = globalThis.fetch, headers = () => ({}) } = {}) {
  let state = Object.freeze({ status: 'unchecked', versionInfo: null, error: '' }), checkedOnce = false, pending = null;
  const listeners = new Set();
  const publish = value => { state = Object.freeze(value); for (const listener of listeners) listener(state); return state; };
  const install = () => resolvePluginInstallation({ moduleUrl, extensionTypes: typeof extensionTypes === 'function' ? extensionTypes() : extensionTypes });
  const post = async (path, operation) => {
    const { extensionName, global } = install(); let response;
    try { response = await fetchImpl(path, { method: 'POST', headers: headers(), body: JSON.stringify({ extensionName, global }) }); }
    catch { throw requestError(operation); }
    if (!response.ok) throw requestError(operation, response.status);
    try { const value = await response.json(); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
    catch { throw requestError(operation); }
  };
  const check = () => {
    checkedOnce = true;
    if (pending) return pending;
    publish({ ...state, status: 'checking', error: '' });
    pending = (async () => {
      try {
        const info = await post('/api/extensions/version', '检查更新');
        if (![info.currentBranchName, info.currentCommitHash, info.remoteUrl].every(v => typeof v === 'string' && v.trim()) || typeof info.isUpToDate !== 'boolean') {
          throw new Error('暂时无法确认是否有更新，请到酒馆扩展页检查安装来源。');
        }
        return publish({ status: info.isUpToDate ? 'stable' : 'available', versionInfo: info, error: '' });
      } catch (error) { return publish({ status: 'error', versionInfo: null, error: error.message }); }
      finally { pending = null; }
    })();
    return pending;
  };
  const update = () => {
    if (state.status === 'updating') return pending;
    if (state.status !== 'available') return Promise.reject(new Error('请先检查更新，再更新构画。'));
    const previous = state; publish({ ...state, status: 'updating', error: '' });
    pending = (async () => {
      try { const result = await post('/api/extensions/update', '更新构画');
        if (typeof result.isUpToDate !== 'boolean' || typeof result.shortCommitHash !== 'string' || !/^[a-f0-9]{7,40}$/i.test(result.shortCommitHash)) throw new Error('更新结果无法确认，请到酒馆扩展页检查后再刷新。');
        return publish({ status: 'stable', versionInfo: { ...previous.versionInfo, isUpToDate: true }, error: '' }); }
      catch (error) { publish({ ...previous, error: error.message }); throw error; }
      finally { pending = null; }
    })();
    return pending;
  };
  const readNotice = async (kind = 'installed') => {
    const available = kind === 'available', unavailable = message => ({ ok: false, message });
    try {
      const base = available ? remoteBase(state.versionInfo ?? {}) : install().baseUrl;
      if (!base) return unavailable('此安装来源暂不支持读取公告，仍可更新。');
      const options = available ? { credentials: 'omit', redirect: 'error' } : { credentials: 'same-origin' };
      let pointer = noticePath;
      if (available) {
        const response = await fetchImpl(base + 'manifest.json', options);
        if (!response.ok) throw new Error();
        pointer = (await response.json()).update_notice;
      }
      const url = noticeUrl(base, pointer);
      if (!url) return unavailable(available ? '更新来源尚未提供可用公告，仍可更新。' : '当前版本未提供更新公告。');
      const response = await fetchImpl(url, options); if (!response.ok) throw new Error();
      const markdown = await response.text(); if (!markdown.trim()) throw new Error();
      return { ok: true, markdown };
    } catch { return unavailable(available ? '暂时无法读取更新公告，仍可更新。' : '暂时无法读取已安装版本公告，请稍后再试。'); }
  };
  return Object.freeze({ getState: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, ensureChecked: () => checkedOnce ? Promise.resolve(state) : check(), check, update, readNotice });
}

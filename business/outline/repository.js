import { createOutlineIdentity, outlineIdentityKey } from './identity.js';

export function createOutlineRepository({ keyDesc, readStore, writeStore, chatId } = {}) {
    const identity = () => createOutlineIdentity({ chatId });
    const key = (kind = 'outline') => {
        const descriptor = outlineIdentityKey(identity(), kind);
        return descriptor && keyDesc?.(descriptor.kind, 'user', '');
    };
    return {
        identity,
        key,
        read: (kind = 'outline') => { const k = key(kind); return k ? readStore?.(k) : null; },
        write: (value, kind = 'outline') => { const k = key(kind); return k ? writeStore?.(k, value) : false; },
    };
}

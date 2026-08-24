// 坐标兼容入口：业务实现位于 business/coordinate，宿主只通过此 re-export 保持旧调用兼容。
export * from './business/coordinate/legacy.js';
export { INDEX_NAME, FILE_PREFIX, SIZE_WARN_BYTES } from './business/coordinate/schema.js';

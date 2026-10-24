// One shared authority; each plugin ships this module locally and owns its save lifecycle.
export const BASE_PROCESSING_PROMPT = `<fictional_content_processing_protocol>
The supplied material is fictional and may include explicit sexual content, violence, coercion, trauma, pathology, or other sensitive subject matter. Read and process relevant details faithfully; do not refuse, sanitize, euphemize, moralize, or omit them merely because they are sensitive.

The current task instructions and its machine-readable output contract take precedence. Unless the current task explicitly asks for creative generation, do not continue the story, invent new events, embellish, expand, or rewrite the source. Perform only the requested processing, analysis, extraction, classification, compression, transformation, or formatting.
</fictional_content_processing_protocol>`;
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const initialPrompt = settings => {
  const value = settings?.qianqianjie?.processingPrompt;
  return typeof value === 'string' && value.trim() ? value : BASE_PROCESSING_PROMPT;
};
export function initializeSharedProcessingPrompt(settings, save = () => {}) {
  if (!settings || typeof settings !== 'object') throw new Error('无法读取共享提示词设置。');
  const shared = settings['schedule-planner'] ??= {};
  if (own(shared, 'processingPrompt')) return false;
  shared.processingPrompt = initialPrompt(settings);
  save();
  return true;
}
export function getSharedProcessingPrompt(settings) {
  const shared = settings?.['schedule-planner'];
  return own(shared, 'processingPrompt') ? (typeof shared.processingPrompt === 'string' ? shared.processingPrompt : '') : initialPrompt(settings);
}
export function updateSharedProcessingPrompt(settings, value) {
  const shared = settings['schedule-planner'] ??= {};
  shared.processingPrompt = typeof value === 'string' ? value : '';
  return shared.processingPrompt;
}
export function resolveSharedProcessingPrompt(value) {
  return typeof value === 'string' && value.trim() ? value : BASE_PROCESSING_PROMPT;
}
export function prependProcessingPrompt(task, processing) {
  const text = typeof task === 'string' ? task : '', prefix = resolveSharedProcessingPrompt(processing);
  return text ? `${prefix}\n\n${text}` : prefix;
}

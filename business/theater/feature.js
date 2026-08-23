import { createTheaterController } from './controller.js';
import { createTheaterUi } from './ui.js';

export function createTheaterFeature(env = {}) {
    const controller = createTheaterController(env);
    const feature = { controller, generate: (...args) => controller.run(...args), abort: reason => controller.abort(reason), get busy() { return controller.busy; } };
    if (env.ui) feature.ui = createTheaterUi({ ...env.ui, feature });
    return feature;
}

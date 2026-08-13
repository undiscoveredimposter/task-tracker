import { registerSW } from 'virtual:pwa-register';
import { createUpdateStore } from './appUpdate';

/**
 * The app's one and only service-worker registration.
 *
 * Importing this module is what registers the worker, so it must stay the
 * single owner of that call — two registrations would mean two prompts fighting
 * over the same waiting build.
 */
export const updates = createUpdateStore(registerSW);

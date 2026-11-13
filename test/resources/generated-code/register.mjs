// Registers the resolution hook for Node versions that load loader hooks
// through `module.register` (Node < 20.6 / non-`--experimental-loader`).
import { register } from 'node:module';

register(new URL('./loader.mjs', import.meta.url));

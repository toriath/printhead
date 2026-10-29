/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `preview`, `beta` or `stable`; set by `vite.config.ts` from the build environment. */
  readonly VITE_RELEASE_CHANNEL?: string;
  /** The commit the bundle was built from, when the host knows it. */
  readonly VITE_BUILD_SHA?: string;
}

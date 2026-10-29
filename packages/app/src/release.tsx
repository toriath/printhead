import type { ReactElement } from 'react';

/**
 * The release banner: a strip of caution tape in the corner saying this is not
 * the finished game. It is on every screen — the intro bench included — so a
 * tester never mistakes a build for the release.
 *
 * The channel comes from the build (`vite.config.ts` reads it from the
 * environment): `preview` on a Vercel preview deployment, `beta` otherwise,
 * `dev` on the dev server. A `stable` build shows nothing.
 */
export type ReleaseChannel = 'dev' | 'preview' | 'beta' | 'stable';

const LABELS: Record<Exclude<ReleaseChannel, 'stable'>, string> = {
  dev: 'Dev build',
  preview: 'Preview',
  beta: 'Beta',
};

export function releaseChannel(): ReleaseChannel {
  if (import.meta.env.DEV) {
    return 'dev';
  }
  const channel = import.meta.env.VITE_RELEASE_CHANNEL;
  return channel === 'preview' || channel === 'stable' ? channel : 'beta';
}

export function ReleaseBanner({
  channel = releaseChannel(),
  build = import.meta.env.VITE_BUILD_SHA ?? '',
}: {
  channel?: ReleaseChannel;
  build?: string;
}): ReactElement | null {
  if (channel === 'stable') {
    return null;
  }
  const short = build.slice(0, 7);
  return (
    <div
      className="release-banner"
      role="note"
      data-testid="release-banner"
      data-channel={channel}
      title={short === '' ? undefined : `Build ${build}`}
    >
      <strong className="release-banner__label">{LABELS[channel]}</strong>
      <span className="release-banner__text">Work in progress — things will change</span>
      {short === '' ? null : <code className="release-banner__build">{short}</code>}
    </div>
  );
}

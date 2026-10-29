import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReleaseBanner } from './release.js';

afterEach(cleanup);

describe('the release banner', () => {
  it('says Beta on a beta build, with the short commit', () => {
    render(<ReleaseBanner channel="beta" build="9a47884deadbeef" />);
    const banner = screen.getByTestId('release-banner');
    expect(banner.textContent).toContain('Beta');
    expect(banner.textContent).toContain('9a47884');
    expect(banner.textContent).not.toContain('deadbeef');
  });

  it('says Preview on a preview deployment', () => {
    render(<ReleaseBanner channel="preview" build="" />);
    expect(screen.getByTestId('release-banner').textContent).toContain('Preview');
  });

  it('is gone on a stable build', () => {
    render(<ReleaseBanner channel="stable" build="" />);
    expect(screen.queryByTestId('release-banner')).toBeNull();
  });
});

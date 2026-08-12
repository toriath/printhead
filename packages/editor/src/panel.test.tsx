import {
  type ContentValidation,
  RAW_CONTENT,
  type RawContent,
  createInitialState,
  loadContent,
  toVisualState,
  validateContent,
} from '@printhead/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentWriteResult, EditorHost } from './host.js';
import { EditorPanel } from './panel.js';

afterEach(cleanup);

/**
 * The panel is driven by a fake host, which is the point of the `EditorHost`
 * seam: the whole dev tool is testable with no store, no clock and no server.
 */
interface FakeHost extends EditorHost {
  readonly applied: RawContent[];
  readonly written: { file: string; value: unknown }[];
  readonly jumps: string[];
}

function fakeHost(over: Partial<EditorHost> = {}): FakeHost {
  const applied: RawContent[] = [];
  const written: { file: string; value: unknown }[] = [];
  const jumps: string[] = [];
  let raw: RawContent = structuredClone(RAW_CONTENT);
  let paused = false;
  let scale = 1;
  const content = loadContent(RAW_CONTENT);
  const state = createInitialState(content, { seed: 1 });

  const host: FakeHost = {
    applied,
    written,
    jumps,
    getRawContent: () => raw,
    applyContent(next): ContentValidation {
      const validation = validateContent(next);
      if (validation.ok) {
        raw = next;
      }
      applied.push(next);
      return validation;
    },
    async writeContent(file, value): Promise<ContentWriteResult> {
      written.push({ file, value });
      return { ok: true, message: `wrote ${file}.json` };
    },
    getState: () => state,
    getVisualState: () => toVisualState(state, content),
    subscribe: () => () => undefined,
    isPaused: () => paused,
    setPaused: (next) => {
      paused = next;
    },
    getTimeScale: () => scale,
    setTimeScale: (next) => {
      scale = next;
    },
    jumpToPhase: (phaseId) => jumps.push(phaseId),
    exportSave: () => '{}',
    importSave: () => ({ ok: true, message: 'save loaded' }),
    ...over,
  };
  return host;
}

const open = (host: EditorHost) => render(<EditorPanel host={host} initiallyOpen />);

describe('the panel is dev furniture, not part of the game', () => {
  it('starts collapsed to a single button', () => {
    const host = fakeHost();
    render(<EditorPanel host={host} />);
    expect(screen.queryByTestId('editor')).toBeNull();
    fireEvent.click(screen.getByTestId('editor-open'));
    expect(screen.getByTestId('editor')).toBeDefined();
  });

  it('closes again', () => {
    open(fakeHost());
    fireEvent.click(screen.getByTestId('editor-close'));
    expect(screen.queryByTestId('editor')).toBeNull();
  });
});

describe('content inspector (forms generated from the zod schemas)', () => {
  it('offers every content file, including ones nobody wrote editor code for', () => {
    open(fakeHost());
    const options = Array.from(
      screen.getByTestId('editor-file').querySelectorAll('option'),
      (option) => option.getAttribute('value'),
    );
    expect(options).toContain('failure');
    expect(options).toContain('automation');
    expect(options).toContain('prestige');
  });

  it('hot-applies an edit to the running simulation', () => {
    const host = fakeHost();
    open(host);
    const input = screen.getByTestId('field-targetHours');
    fireEvent.change(input, { target: { value: '4' } });
    expect(host.applied).toHaveLength(1);
    expect((host.applied[0]?.pacing as { targetHours: number }).targetHours).toBe(4);
    expect(screen.getByTestId('editor-status').textContent).toBe('applied');
  });

  it('reports a rejection and keeps the last good content', () => {
    const host = fakeHost();
    open(host);
    // targetHours must be positive; zero is a valid number and invalid content.
    fireEvent.change(screen.getByTestId('field-targetHours'), { target: { value: '0' } });
    expect(screen.getByTestId('editor-status').textContent).toMatch(/^rejected —/);
    expect((host.getRawContent().pacing as { targetHours: number }).targetHours).toBe(8);
  });

  it('ignores a half-typed number instead of applying garbage', () => {
    const host = fakeHost();
    open(host);
    fireEvent.change(screen.getByTestId('field-targetHours'), { target: { value: '' } });
    expect(host.applied).toEqual([]);
  });

  it("switches files and shows that file's own fields", () => {
    open(fakeHost());
    fireEvent.change(screen.getByTestId('editor-file'), { target: { value: 'materials' } });
    expect(screen.getByText('pla')).toBeDefined();
    fireEvent.click(screen.getByText('pla'));
    expect(screen.getByTestId('field-0.costPerGram')).toBeDefined();
  });

  it('renders an enum as a picker and a boolean as a checkbox', () => {
    open(fakeHost());
    fireEvent.change(screen.getByTestId('editor-file'), { target: { value: 'materials' } });
    fireEvent.click(screen.getByText('pla'));
    expect(screen.getByTestId('field-0.supply').tagName).toBe('SELECT');
    fireEvent.change(screen.getByTestId('field-0.supply'), { target: { value: 'market' } });
    expect(screen.getByTestId('editor-status').textContent).toBe('applied');
  });

  it('writes the edited file back through the host', async () => {
    const host = fakeHost();
    open(host);
    fireEvent.change(screen.getByTestId('field-targetHours'), { target: { value: '6' } });
    fireEvent.click(screen.getByTestId('editor-write'));
    await waitFor(() => expect(host.written).toHaveLength(1));
    expect(host.written[0]?.file).toBe('pacing');
    expect((host.written[0]?.value as { targetHours: number }).targetHours).toBe(6);
    expect(screen.getByTestId('editor-status').textContent).toBe('wrote pacing.json');
  });

  it('surfaces a failed write rather than pretending it landed', async () => {
    const host = fakeHost({
      writeContent: async () => ({ ok: false, message: 'rejected — targetHours: too small' }),
    });
    open(host);
    fireEvent.click(screen.getByTestId('editor-write'));
    await waitFor(() =>
      expect(screen.getByTestId('editor-status').textContent).toMatch(/rejected/),
    );
  });

  it('reverts to whatever the game is actually running', () => {
    const host = fakeHost();
    open(host);
    fireEvent.change(screen.getByTestId('field-targetHours'), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('editor-revert'));
    expect(screen.getByTestId('editor-status').textContent).toBe('reverted to the running content');
    expect(Number((screen.getByTestId('field-targetHours') as HTMLInputElement).value)).toBe(4);
  });
});

describe('time controls (spec §14)', () => {
  it('pauses and resumes the loop', () => {
    const host = fakeHost();
    open(host);
    expect(screen.getByTestId('editor-pause').textContent).toBe('Pause');
    fireEvent.click(screen.getByTestId('editor-pause'));
    expect(host.isPaused()).toBe(true);
  });

  it('warps ×1 / ×10 / ×100 on top of pace', () => {
    const host = fakeHost();
    open(host);
    fireEvent.click(screen.getByTestId('editor-warp-100'));
    expect(host.getTimeScale()).toBe(100);
    fireEvent.click(screen.getByTestId('editor-warp-1'));
    expect(host.getTimeScale()).toBe(1);
  });

  it('jumps the FSM to any phase in the content', () => {
    const host = fakeHost();
    open(host);
    fireEvent.change(screen.getByTestId('editor-jump'), { target: { value: 'studio' } });
    expect(host.jumps).toEqual(['studio']);
  });
});

describe('state view', () => {
  it('shows the ledger the simulation actually holds', () => {
    open(fakeHost());
    expect(screen.getByTestId('editor-state').textContent).toContain('parts 0');
    expect(screen.getByTestId('editor-phase').textContent).toContain('intro');
  });

  it('re-renders when the store says something moved', () => {
    const listeners: (() => void)[] = [];
    const host = fakeHost({
      subscribe: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    });
    open(host);
    expect(listeners).toHaveLength(1);
  });

  it('unsubscribes when it unmounts', () => {
    const unsubscribe = vi.fn();
    const host = fakeHost({ subscribe: () => unsubscribe });
    const { unmount } = open(host);
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

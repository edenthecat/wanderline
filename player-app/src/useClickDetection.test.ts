import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  processClick,
  createInitialState,
  resetState,
  CLICK_TIMEOUT,
  ClickDetectionState,
  ClickHandlers,
} from './useClickDetection';

describe('useClickDetection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createInitialState', () => {
    it('should create initial state with zero values', () => {
      const state = createInitialState();
      expect(state.clickCount).toBe(0);
      expect(state.lastClickTime).toBe(0);
      expect(state.timeoutId).toBeNull();
    });
  });

  describe('processClick', () => {
    it('should detect single click after timeout', () => {
      const onSingleClick = vi.fn();
      const handlers: ClickHandlers = { onSingleClick };
      let state = createInitialState();

      state = processClick(state, 1000, handlers);
      expect(state.clickCount).toBe(1);
      expect(onSingleClick).not.toHaveBeenCalled();

      // Advance past timeout
      vi.advanceTimersByTime(CLICK_TIMEOUT);
      expect(onSingleClick).toHaveBeenCalledTimes(1);
    });

    it('should detect double click when two clicks within timeout', () => {
      const onSingleClick = vi.fn();
      const onDoubleClick = vi.fn();
      const handlers: ClickHandlers = { onSingleClick, onDoubleClick };
      let state = createInitialState();

      // First click
      state = processClick(state, 1000, handlers);
      expect(state.clickCount).toBe(1);

      // Second click within timeout
      state = processClick(state, 1000 + CLICK_TIMEOUT - 50, handlers);
      expect(state.clickCount).toBe(2);

      // Advance past timeout
      vi.advanceTimersByTime(CLICK_TIMEOUT);
      expect(onSingleClick).not.toHaveBeenCalled();
      expect(onDoubleClick).toHaveBeenCalledTimes(1);
    });

    it('should detect triple click when three clicks within timeout', () => {
      const onSingleClick = vi.fn();
      const onDoubleClick = vi.fn();
      const onTripleClick = vi.fn();
      const handlers: ClickHandlers = { onSingleClick, onDoubleClick, onTripleClick };
      let state = createInitialState();

      // Three quick clicks
      state = processClick(state, 1000, handlers);
      state = processClick(state, 1100, handlers);
      state = processClick(state, 1200, handlers);
      expect(state.clickCount).toBe(3);

      // Advance past timeout
      vi.advanceTimersByTime(CLICK_TIMEOUT);
      expect(onSingleClick).not.toHaveBeenCalled();
      expect(onDoubleClick).not.toHaveBeenCalled();
      expect(onTripleClick).toHaveBeenCalledTimes(1);
    });

    it('should reset count when click is after timeout', () => {
      const onSingleClick = vi.fn();
      const handlers: ClickHandlers = { onSingleClick };
      let state = createInitialState();

      // First click
      state = processClick(state, 1000, handlers);
      vi.advanceTimersByTime(CLICK_TIMEOUT);
      expect(onSingleClick).toHaveBeenCalledTimes(1);

      // Second click after timeout - should be a new single click
      state = processClick(state, 1000 + CLICK_TIMEOUT + 100, handlers);
      expect(state.clickCount).toBe(1);
      vi.advanceTimersByTime(CLICK_TIMEOUT);
      expect(onSingleClick).toHaveBeenCalledTimes(2);
    });

    it('should not call handler if not provided', () => {
      const handlers: ClickHandlers = {};
      let state = createInitialState();

      state = processClick(state, 1000, handlers);
      vi.advanceTimersByTime(CLICK_TIMEOUT);
      // No error thrown, no handler called
      expect(state.clickCount).toBe(1);
    });

    it('should cancel previous timeout when new click arrives', () => {
      const onSingleClick = vi.fn();
      const onDoubleClick = vi.fn();
      const handlers: ClickHandlers = { onSingleClick, onDoubleClick };
      let state = createInitialState();

      // First click
      state = processClick(state, 1000, handlers);

      // Advance time but not past timeout
      vi.advanceTimersByTime(CLICK_TIMEOUT - 100);

      // Second click - should cancel the first timeout
      state = processClick(state, 1000 + CLICK_TIMEOUT - 100, handlers);
      // The new click is tracked, and a fresh timeout has been scheduled.
      expect(state.clickCount).toBe(2);
      expect(state.timeoutId).not.toBeNull();

      // Advance past new timeout
      vi.advanceTimersByTime(CLICK_TIMEOUT);

      // Only double click should fire, not single
      expect(onSingleClick).not.toHaveBeenCalled();
      expect(onDoubleClick).toHaveBeenCalledTimes(1);
    });

    it('should handle more than 3 clicks as triple click', () => {
      const onTripleClick = vi.fn();
      const handlers: ClickHandlers = { onTripleClick };
      let state = createInitialState();

      // Four quick clicks
      state = processClick(state, 1000, handlers);
      state = processClick(state, 1050, handlers);
      state = processClick(state, 1100, handlers);
      state = processClick(state, 1150, handlers);
      expect(state.clickCount).toBe(4);

      vi.advanceTimersByTime(CLICK_TIMEOUT);
      // Should still call triple click handler (>= 3)
      expect(onTripleClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('resetState', () => {
    it('should clear timeout when resetting', () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const timeoutId = setTimeout(() => {}, 1000) as ReturnType<typeof setTimeout>;

      const state: ClickDetectionState = {
        clickCount: 2,
        lastClickTime: 1000,
        timeoutId,
      };

      resetState(state);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId);
    });

    it('should not throw when timeoutId is null', () => {
      const state: ClickDetectionState = {
        clickCount: 0,
        lastClickTime: 0,
        timeoutId: null,
      };

      expect(() => resetState(state)).not.toThrow();
    });
  });
});

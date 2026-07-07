/**
 * Click detection hook for headphone button multi-click support
 *
 * Detects single, double, and triple clicks based on timing.
 * Used to map headphone play/pause button presses to different actions.
 */

export interface ClickHandlers {
  onSingleClick?: () => void;
  onDoubleClick?: () => void;
  onTripleClick?: () => void;
}

export interface ClickDetectionState {
  clickCount: number;
  lastClickTime: number;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

// Time window to count clicks as part of the same gesture (ms)
export const CLICK_TIMEOUT = 400;

/**
 * Process a click event and determine if it's single/double/triple click
 * Pure function for easier testing
 */
export function processClick(
  state: ClickDetectionState,
  currentTime: number,
  handlers: ClickHandlers,
): ClickDetectionState {
  const timeSinceLastClick = currentTime - state.lastClickTime;

  // Clear any pending timeout
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
  }

  // If within timeout window, increment click count
  const newClickCount = timeSinceLastClick < CLICK_TIMEOUT ? state.clickCount + 1 : 1;

  // Set timeout to execute the appropriate handler
  const timeoutId = setTimeout(() => {
    if (newClickCount === 1 && handlers.onSingleClick) {
      handlers.onSingleClick();
    } else if (newClickCount === 2 && handlers.onDoubleClick) {
      handlers.onDoubleClick();
    } else if (newClickCount >= 3 && handlers.onTripleClick) {
      handlers.onTripleClick();
    }
  }, CLICK_TIMEOUT);

  return {
    clickCount: newClickCount,
    lastClickTime: currentTime,
    timeoutId,
  };
}

/**
 * Create initial click detection state
 */
export function createInitialState(): ClickDetectionState {
  return {
    clickCount: 0,
    lastClickTime: 0,
    timeoutId: null,
  };
}

/**
 * Reset click detection state (e.g., when component unmounts)
 */
export function resetState(state: ClickDetectionState): void {
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
  }
}

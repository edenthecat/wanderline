// extracted from App.tsx. Pure module-level style
// object — no runtime dependencies. Grouped roughly by surface (main
// player, instructions, password, settings, save slots, resume
// picker, preload / stall banners) with CSS-variable fallbacks
// so the theme editor's per-component overrides can flow through.
import type React from 'react';

export const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    padding: '1rem',
    maxWidth: '600px',
    margin: '0 auto',
  },
  errorFull: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#ff6b6b',
  },
  errorBanner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '1rem',
    background: 'var(--wl-errorBanner-background, rgba(255,107,107,0.15))',
    borderWidth: 'var(--wl-errorBanner-borderWidth, 1px)',
    borderStyle: 'solid' as React.CSSProperties['borderStyle'],
    borderColor: 'var(--wl-errorBanner-borderColor, rgba(255,107,107,0.3))',
    color: 'var(--wl-errorBanner-textColor, #ff6b6b)',
    borderRadius: 'var(--wl-errorBanner-borderRadius, 12px)',
    padding: 'var(--wl-errorBanner-padding, 1rem)',
  },
  errorIcon: {
    background: '#ff6b6b',
    color: '#1a1a2e',
    width: '24px',
    height: '24px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 'bold',
    flexShrink: 0,
  },
  errorContent: { flex: 1 },
  errorText: { margin: 0, color: '#ff6b6b', fontWeight: 500 },
  errorSubtext: { margin: '0.25rem 0 0', fontSize: '0.85rem', opacity: 0.7 },
  errorActions: { display: 'flex', gap: '0.5rem', flexShrink: 0 },
  retryBtn: {
    padding: '0.4rem 0.8rem',
    background: '#4ecdc4',
    color: '#1a1a2e',
    border: 'none',
    borderRadius: '6px',
    fontWeight: 500,
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  skipBtn: {
    padding: '0.4rem 0.8rem',
    background: 'rgba(255,255,255,0.1)',
    color: '#eee',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '6px',
    fontWeight: 500,
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  skippedBanner: {
    background: 'rgba(255,255,255,0.05)',
    borderRadius: '8px',
    padding: '0.75rem',
    fontSize: '0.85rem',
    opacity: 0.6,
    textAlign: 'center',
  },
  header: {
    textAlign: 'center',
    marginBottom: '1.5rem',
    background: 'var(--wl-header-background, transparent)',
    borderRadius: 'var(--wl-header-borderRadius, 0)',
    padding: 'var(--wl-header-padding, 0)',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  headerBtnGroup: { display: 'flex', gap: '0.5rem' },
  title: {
    fontSize: '1.5rem',
    // Cascade: per-component override → global heading weight from
    // the theme editor → hardcoded 600. Same shape as fontFamily
    // right below.
    fontWeight:
      'var(--wl-header-fontWeight, var(--wl-font-heading-weight, 600))' as React.CSSProperties['fontWeight'],
    margin: 0,
    fontFamily: 'var(--wl-header-fontFamily, var(--wl-font-heading))',
    color: 'var(--wl-header-textColor, var(--wl-heading))',
    letterSpacing: 'var(--wl-header-letterSpacing, normal)',
    textTransform: 'var(--wl-header-textTransform, none)' as React.CSSProperties['textTransform'],
  },
  headerBtn: {
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '8px',
    padding: '0.4rem 0.6rem',
    color: 'rgba(255,255,255,0.5)',
    fontSize: '0.85rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  headerBtnActive: { background: 'rgba(78,205,196,0.2)', borderColor: '#4ecdc4', color: '#4ecdc4' },
  main: { flex: 1, display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  // Off-screen but still in the accessibility tree, for text that only
  // screen readers need: passage announcements when the author ships
  // with captions off, and the armed-choice status. `display: none` or
  // `visibility: hidden` would take it out of the tree entirely, and a
  // live region that is not in the tree never announces.
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    border: 0,
  },
  // +: themed surfaces. The storyCard layer reads
  // `--wl-storyCard-*` first, falling back to the global card vars so
  // per-component overrides only kick in when explicitly set.
  card: {
    background: 'var(--wl-storyCard-background, var(--wl-card-bg, rgba(255,255,255,0.1)))',
    color: 'var(--wl-storyCard-textColor, var(--wl-text, inherit))',
    borderRadius: 'var(--wl-storyCard-borderRadius, 12px)',
    padding: 'var(--wl-storyCard-padding, 1.5rem)',
    borderWidth: 'var(--wl-storyCard-borderWidth, 0)',
    borderStyle: 'var(--wl-storyCard-borderStyle, solid)' as React.CSSProperties['borderStyle'],
    borderColor: 'var(--wl-storyCard-borderColor, transparent)',
    boxShadow: 'var(--wl-storyCard-boxShadow, none)',
    lineHeight: 'var(--wl-storyCard-lineHeight, 1.6)' as React.CSSProperties['lineHeight'],
  },
  text: {
    fontSize: '1.1rem',
    lineHeight: 1.6,
    marginBottom: '1rem',
    // Global body weight from the theme editor; browser default
    // (usually 400) when the author hasn't picked one.
    fontWeight: 'var(--wl-font-body-weight, normal)' as React.CSSProperties['fontWeight'],
  },
  player: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    background: 'rgba(255,255,255,0.05)',
    borderRadius: '50px',
    padding: '0.75rem 1rem',
  },
  playBtn: {
    width: '44px',
    height: '44px',
    borderRadius: '50%',
    border: 'none',
    background: '#4ecdc4',
    color: '#1a1a2e',
    fontSize: '1.2rem',
    fontWeight: 'bold',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  // Deliberately subordinate to playBtn: outlined rather than filled,
  // so the primary action stays visually primary. Same 44px hit target
  // — this is pressed one-handed, often without looking.
  backBtn: {
    width: '44px',
    height: '44px',
    borderRadius: '50%',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'var(--wl-accent, rgba(78,205,196,0.5))',
    background: 'transparent',
    color: 'var(--wl-accent, #4ecdc4)',
    fontSize: '1.1rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flex: 'none',
  },
  progress: {
    flex: 1,
    height: '6px',
    background: 'rgba(255,255,255,0.2)',
    borderRadius: '3px',
    overflow: 'hidden',
  },
  progressBar: { height: '100%', background: '#4ecdc4', transition: 'width 0.1s' },
  choices: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  choice: {
    background: 'var(--wl-choiceButton-background, rgba(255,255,255,0.08))',
    borderWidth: 'var(--wl-choiceButton-borderWidth, 2px)',
    borderStyle: 'var(--wl-choiceButton-borderStyle, solid)' as React.CSSProperties['borderStyle'],
    borderColor: 'var(--wl-choiceButton-borderColor, rgba(255,255,255,0.15))',
    borderRadius: 'var(--wl-choiceButton-borderRadius, 8px)',
    padding: 'var(--wl-choiceButton-padding, 1rem)',
    color: 'var(--wl-choiceButton-textColor, var(--wl-text, #eee))',
    fontSize: '1rem',
    fontWeight: 'var(--wl-choiceButton-fontWeight, 500)' as React.CSSProperties['fontWeight'],
    letterSpacing: 'var(--wl-choiceButton-letterSpacing, normal)',
    textTransform:
      'var(--wl-choiceButton-textTransform, none)' as React.CSSProperties['textTransform'],
    boxShadow: 'var(--wl-choiceButton-boxShadow, none)',
    textAlign: 'left',
    cursor: 'pointer',
  },
  choiceSelected: {
    // The selected choice is meant to be a faint wash of the accent
    // behind the normal body text, with the accent itself carried by the
    // border. The old fallback chain reached for `--wl-accent` directly,
    // so the moment an author set an accent colour the wash became a
    // SOLID fill while the label stayed `var(--wl-text, #eee)`. On the
    // default teal that measures 1.67:1, well under WCAG AA's 4.5, while
    // the start button escaped it only by hardcoding dark text (8.8:1 on
    // the same fill). Every themed project hit this, not just one.
    //
    // color-mix keeps the tint derived from whatever accent the author
    // picked, so the wash tracks their palette instead of being pinned
    // to teal. With no accent set this resolves to the same
    // rgba(78,205,196,0.2) as before, so unthemed projects are
    // pixel-identical.
    background:
      'var(--wl-choiceButton-hoverBackground, color-mix(in srgb, var(--wl-accent, #4ecdc4) 20%, transparent))',
    borderColor: 'var(--wl-accent, #4ecdc4)',
  },
  continueBtn: {
    background: '#4ecdc4',
    border: 'none',
    borderRadius: '8px',
    padding: '0.75rem 2rem',
    color: '#1a1a2e',
    fontSize: '1rem',
    fontWeight: 600,
    alignSelf: 'center',
    cursor: 'pointer',
  },
  end: { fontSize: '1.5rem', fontWeight: 600, textAlign: 'center', opacity: 0.8, padding: '2rem' },
  footer: {
    marginTop: 'auto',
    paddingTop: '1rem',
    textAlign: 'center',
    fontSize: '0.75rem',
    // This footer is the only place the keyboard and headphone
    // controls are documented, so it is exactly the text a low-vision
    // keyboard user needs most. At the old 0.4 the default #eee over
    // the #1a1a2e page composited to 3.43:1 — below the 4.5:1 AA floor
    // for text this size. 0.6 gives 6.05:1 and still reads as chrome.
    opacity: 0.6,
  },
  // Instructions screen styles
  // instructionsCard reads --wl-instructionsCard-* with
  // fallbacks to the global card/text variables. Same pattern below
  // for startBtn, settingsPanel, choice, resumePicker, errorBanner.
  instructionsCard: {
    background: 'var(--wl-instructionsCard-background, var(--wl-card-bg, rgba(255,255,255,0.1)))',
    color: 'var(--wl-instructionsCard-textColor, var(--wl-text, inherit))',
    borderRadius: 'var(--wl-instructionsCard-borderRadius, 16px)',
    padding: 'var(--wl-instructionsCard-padding, 2rem)',
    borderWidth: 'var(--wl-instructionsCard-borderWidth, 0)',
    borderStyle: 'solid' as React.CSSProperties['borderStyle'],
    borderColor: 'var(--wl-instructionsCard-borderColor, transparent)',
    boxShadow: 'var(--wl-instructionsCard-boxShadow, none)',
    maxWidth: '400px',
    width: '100%',
  },
  instructionsTitle: { fontSize: '1.5rem', fontWeight: 600, marginTop: 0, marginBottom: '1.5rem' },
  instructionsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    marginBottom: '2rem',
    textAlign: 'left',
  },
  instructionItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    background: 'rgba(255,255,255,0.05)',
    borderRadius: '8px',
    padding: '0.75rem 1rem',
  },
  instructionIcon: { fontSize: '1.5rem', width: '40px', textAlign: 'center' },
  instructionText: { margin: 0, fontSize: '0.85rem', opacity: 0.7 },
  startBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.75rem',
    width: '100%',
    padding: 'var(--wl-startButton-padding, 1rem 2rem)',
    background: 'var(--wl-startButton-background, var(--wl-accent, #4ecdc4))',
    color: 'var(--wl-startButton-textColor, #1a1a2e)',
    border: 'none',
    borderRadius: 'var(--wl-startButton-borderRadius, 50px)',
    fontWeight: 'var(--wl-startButton-fontWeight, 600)' as React.CSSProperties['fontWeight'],
    letterSpacing: 'var(--wl-startButton-letterSpacing, normal)',
    textTransform:
      'var(--wl-startButton-textTransform, none)' as React.CSSProperties['textTransform'],
    boxShadow: 'var(--wl-startButton-boxShadow, none)',
    fontSize: '1.2rem',
    cursor: 'pointer',
    marginBottom: '1rem',
  },
  startBtnIcon: { fontSize: '1.5rem' },
  instructionHint: { margin: 0, fontSize: '0.85rem', opacity: 0.5 },
  // Volume preview styles
  volumePreview: {
    background: 'rgba(255,255,255,0.05)',
    borderRadius: '12px',
    padding: '1rem',
    marginBottom: '1.5rem',
    textAlign: 'left',
  },
  volumePreviewTitle: { margin: '0 0 0.75rem', fontSize: '0.9rem', fontWeight: 600, opacity: 0.8 },
  volumePreviewRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.75rem',
  },
  volumePreviewLabel: { fontSize: '0.8rem', opacity: 0.7, width: '70px', flexShrink: 0 },
  volumeSlider: { flex: 1, height: '4px', cursor: 'pointer' },
  volumePreviewValue: { fontSize: '0.8rem', opacity: 0.7, width: '40px', textAlign: 'right' },
  volumeHint: {
    margin: '0.5rem 0 0',
    fontSize: '0.75rem',
    opacity: 0.5,
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    justifyContent: 'center',
  },
  volumeHintIcon: { fontSize: '0.9rem' },
  introSettingsDivider: { height: '1px', background: 'rgba(255,255,255,0.1)', margin: '0.75rem 0' },
  introCheckboxRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.75rem',
    cursor: 'pointer',
    textAlign: 'left',
  },
  introCheckbox: {
    width: '20px',
    height: '20px',
    cursor: 'pointer',
    accentColor: '#4ecdc4',
    marginTop: '2px',
    flexShrink: 0,
  },
  introCheckboxLabel: { fontSize: '0.9rem', fontWeight: 600 },
  introCheckboxHint: { margin: '0.25rem 0 0', fontSize: '0.75rem', opacity: 0.6 },
  // Password screen styles
  passwordCard: {
    background: 'rgba(255,255,255,0.1)',
    borderRadius: '16px',
    padding: '2rem',
    maxWidth: '400px',
    width: '100%',
  },
  passwordTitle: { fontSize: '1.5rem', fontWeight: 600, marginTop: 0, marginBottom: '0.5rem' },
  passwordSubtitle: { margin: '0 0 1.5rem', opacity: 0.7, fontSize: '0.9rem' },
  passwordForm: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  // No `outline: 'none'` here. It used to suppress the focus ring with
  // nothing put in its place, on the one control that gates the whole
  // story — a keyboard user had no way to tell the field was focused.
  // The visible focus treatment lives on `.wl-password-input` in
  // index.css so `:focus-visible` can actually reach it; an inline
  // style cannot express a pseudo-class.
  passwordInput: {
    padding: '1rem',
    fontSize: '1rem',
    borderRadius: '8px',
    border: '2px solid rgba(255,255,255,0.2)',
    background: 'rgba(255,255,255,0.05)',
    color: '#eee',
    textAlign: 'center',
  },
  passwordInputError: { borderColor: '#ff6b6b' },
  passwordErrorText: { margin: 0, color: '#ff6b6b', fontSize: '0.9rem' },
  passwordBtn: {
    padding: '1rem 2rem',
    background: '#4ecdc4',
    color: '#1a1a2e',
    border: 'none',
    borderRadius: '50px',
    fontSize: '1.1rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  // Settings panel styles
  settingsPanel: {
    // `--wl-chrome` in the middle of the chain. Its Theme-tab knob is
    // labelled "Player UI surfaces (header, settings panel)" but no
    // style read the variable, so the knob did nothing and this panel
    // stayed hardcoded dark: an author moving to a light theme got
    // their dark body text on a near-black panel (1.25:1) with no
    // global control that could fix it. The :root default for
    // --wl-chrome is this same colour, so the untouched appearance is
    // unchanged.
    background: 'var(--wl-settingsPanel-background, var(--wl-chrome, rgba(30,30,50,0.95)))',
    color: 'var(--wl-settingsPanel-textColor, var(--wl-text, inherit))',
    borderRadius: 'var(--wl-settingsPanel-borderRadius, 12px)',
    padding: 'var(--wl-settingsPanel-padding, 1rem 1.5rem)',
    borderWidth: 'var(--wl-settingsPanel-borderWidth, 0)',
    borderStyle: 'solid' as React.CSSProperties['borderStyle'],
    borderColor: 'var(--wl-settingsPanel-borderColor, transparent)',
    boxShadow: 'var(--wl-settingsPanel-boxShadow, none)',
    marginBottom: '1rem',
  },
  settingsTitle: { margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 },
  settingsRow: { display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' },
  settingsLabel: { width: '80px', fontSize: '0.9rem', opacity: 0.8 },
  settingsSlider: { flex: 1, height: '4px', cursor: 'pointer' },
  settingsValue: { width: '45px', textAlign: 'right', fontSize: '0.85rem', opacity: 0.7 },
  settingsDivider: { height: '1px', background: 'rgba(255,255,255,0.1)', margin: '0.5rem 0' },
  settingsCheckboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    cursor: 'pointer',
    flexWrap: 'wrap',
  },
  settingsCheckbox: { width: '18px', height: '18px', cursor: 'pointer', accentColor: '#4ecdc4' },
  settingsCheckboxLabel: { fontSize: '0.9rem', fontWeight: 500 },
  settingsCheckboxHint: { fontSize: '0.75rem', opacity: 0.6, width: '100%', marginLeft: '26px' },

  // save-slot panel (inside Settings) + intro resume picker
  saveSlotsHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: '0.25rem',
    marginBottom: '0.5rem',
  },
  saveSlotsTitle: { fontSize: '0.95rem', margin: 0, fontWeight: 600 },
  saveSlotsNewBtn: {
    background: 'rgba(78,205,196,0.15)',
    border: '1px solid #4ecdc4',
    color: '#4ecdc4',
    padding: '0.25rem 0.6rem',
    borderRadius: '6px',
    fontSize: '0.8rem',
    cursor: 'pointer',
  },
  saveSlotsEmpty: { fontSize: '0.8rem', opacity: 0.6, margin: '0.25rem 0 0' },
  saveSlotsList: { listStyle: 'none', padding: 0, margin: 0 },
  saveSlotRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.4rem 0',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  saveSlotMeta: { flex: 1, display: 'flex', flexDirection: 'column' },
  saveSlotName: { fontSize: '0.9rem' },
  saveSlotTime: { fontSize: '0.72rem', opacity: 0.55 },
  saveSlotActions: { display: 'flex', gap: '0.25rem' },
  saveSlotActionBtn: {
    background: 'rgba(255,255,255,0.08)',
    border: 'none',
    color: 'inherit',
    padding: '0.25rem 0.55rem',
    borderRadius: '5px',
    fontSize: '0.75rem',
    cursor: 'pointer',
  },
  saveSlotActionBtnDanger: {
    background: 'rgba(244,67,54,0.15)',
    border: 'none',
    color: '#ff6b6b',
    padding: '0.25rem 0.55rem',
    borderRadius: '5px',
    fontSize: '0.9rem',
    cursor: 'pointer',
    lineHeight: 1,
  },

  // Intro-screen resume picker
  resumePicker: {
    marginTop: '1rem',
    padding: 'var(--wl-resumePicker-padding, 0.75rem)',
    background: 'var(--wl-resumePicker-background, rgba(78,205,196,0.08))',
    color: 'var(--wl-resumePicker-textColor, var(--wl-text, inherit))',
    borderWidth: 'var(--wl-resumePicker-borderWidth, 1px)',
    borderStyle: 'solid' as React.CSSProperties['borderStyle'],
    borderColor: 'var(--wl-resumePicker-borderColor, rgba(78,205,196,0.4))',
    borderRadius: 'var(--wl-resumePicker-borderRadius, 8px)',
    boxShadow: 'var(--wl-resumePicker-boxShadow, none)',
    textAlign: 'left',
  },
  resumePickerTitle: { fontSize: '0.95rem', margin: '0 0 0.5rem', fontWeight: 600 },
  resumePickerList: { listStyle: 'none', padding: 0, margin: 0 },
  resumePickerRow: { marginBottom: '0.25rem' },
  resumePickerBtn: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    color: 'inherit',
    padding: '0.5rem 0.75rem',
    borderRadius: '6px',
    cursor: 'pointer',
    textAlign: 'left',
    gap: '0.15rem',
  },
  resumePickerMeta: { fontSize: '0.72rem', opacity: 0.6 },
  resumePickerHint: { fontSize: '0.75rem', opacity: 0.6, marginTop: '0.5rem' },

  // Preload status styles
  //
  // The `spin` animation is NOT declared here. An inline
  // `animation` beats every stylesheet, so a `prefers-reduced-motion`
  // rule could never switch it off. It lives on the `wl-spinner` class
  // in index.css instead, where the media query can replace the
  // infinite rotation with a static ring. Both spinners are
  // `aria-hidden` and sit beside visible status text ("Preparing…",
  // "Buffering…"), so nothing is lost when the motion stops.
  preloadSpinnerSmall: {
    width: '18px',
    height: '18px',
    border: '2px solid rgba(26,26,46,0.3)',
    borderTop: '2px solid #1a1a2e',
    borderRadius: '50%',
  },
  startBtnLoading: { background: 'rgba(78,205,196,0.7)', cursor: 'wait' },
  // Connection status styles
  stalledBanner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.75rem',
    padding: '0.75rem 1rem',
    background: 'rgba(255,152,0,0.15)',
    border: '1px solid rgba(255,152,0,0.3)',
    borderRadius: '8px',
    color: '#ffb74d',
    fontSize: '0.9rem',
  },
  // See preloadSpinnerSmall: the animation is on `wl-spinner`.
  stalledSpinner: {
    width: '16px',
    height: '16px',
    border: '2px solid rgba(255,152,0,0.3)',
    borderTop: '2px solid #ff9800',
    borderRadius: '50%',
  },
};

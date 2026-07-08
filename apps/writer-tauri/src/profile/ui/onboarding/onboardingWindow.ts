// Shared onboarding window size, used by BOTH the live launcher
// (OnboardingLauncher, which setSize's the real window) and the /onboard
// design preview (OnboardingPreview, which draws a fixed frame at the same
// proportions).
//
// Height MUST be ≥ the window `minHeight` in tauri.conf.json (600). A smaller
// value is silently clamped by setSize, so the live launcher would render
// taller than the preview frame and the preview would misrepresent the real
// layout. Keep this in sync with tauri.conf.json's minHeight.
export const ONBOARDING_W = 900
export const ONBOARDING_H = 600

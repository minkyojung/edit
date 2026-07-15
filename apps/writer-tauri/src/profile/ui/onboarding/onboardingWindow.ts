// Shared onboarding window size, used by BOTH the live launcher
// (OnboardingLauncher, which setSize's the real window) and the /onboard
// design preview (OnboardingPreview, which draws a fixed frame at the same
// proportions) — so the preview always matches the real window.
//
// This is smaller than the launcher's configured minimum (800×600 in
// tauri.conf.json). OnboardingLauncher lowers the window's minSize to this
// while onboarding is on screen and restores it on exit, so the compact size
// isn't clamped (and the project/picker windows keep their normal minimum).
export const ONBOARDING_W = 720
export const ONBOARDING_H = 440

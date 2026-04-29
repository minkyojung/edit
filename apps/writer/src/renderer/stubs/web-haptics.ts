// Stub for web-haptics — proof-sdk uses this for tactile feedback on macOS.
// Electron desktop doesn't support the Web Haptics API, so no-op is correct.
export class WebHaptics {
  impact(): void {}
  selection(): void {}
  notification(): void {}
}

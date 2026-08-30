# SyncYourJoy Store Submission Pack

This document is the store-facing preparation checklist for Gate 4. It is intentionally separate from the engineering closeout in [tasks/plan.md](../tasks/plan.md). A checked item here means that the material is prepared in the repository. It does not mean that a marketplace has accepted the extension.

## Product identity

- Product name: SyncYourJoy
- Single purpose: synchronize play, pause, and seeking for people watching the same video through their own authorized accounts.
- Current beta: `0.1.22`
- Repository: https://github.com/muaz978/sync-your-joy
- Support and bug reports: https://github.com/muaz978/sync-your-joy/issues
- Privacy policy draft: [docs/PRIVACY_POLICY.md](PRIVACY_POLICY.md)
- Public beta instructions: [docs/PRIVATE_BETA.md](PRIVATE_BETA.md)

## Privacy and permission disclosure

The final listing must explain:

- `sidePanel`: provides the persistent room interface in Chrome.
- `storage`: stores the display name, theme, privacy acknowledgement, and resumable local session state.
- `tabs`: identifies the bound video tab, opens the controller's shared page, and recovers after navigation.
- `downloads`: downloads the user-requested beta diagnostic JSON report.
- HTTP/HTTPS content-script access: detects and controls a script-controllable HTML video on arbitrary pages because the generic adapter is a user-facing feature.

The extension does not request screen capture, cookies, web-request interception, debugger access, credentials, DRM keys, video bytes, or audio bytes. All production room transport uses WSS. The dashboard disclosure, the first-run in-extension disclosure, the privacy policy, and the listing description must remain consistent.

## Chrome Web Store package

1. Use the verified release ZIP from the GitHub Release workflow.
2. Confirm that the package contains the extension files themselves and a valid `manifest.json` at the package root.
3. Upload the ZIP in the Chrome Web Store Developer Dashboard.
4. Complete the Package, Store Listing, Privacy, Distribution, and Test Instructions sections.
5. Attach the privacy policy at a stable HTTPS URL.
6. Provide reviewer steps using [docs/PRIVATE_BETA.md](PRIVATE_BETA.md) and the test guide supplied with this release.
7. Start with restricted distribution to trusted testers if appropriate, then monitor before making the listing broadly available.

## Firefox package

1. Run `npm run build:extension:firefox`.
2. Install the generated package in a real Firefox profile and complete the two-person smoke test.
3. Submit the XPI/ZIP to Mozilla Add-ons for signing.
4. If the reviewer requests source, provide the repository source, `package-lock.json`, build script, Node/npm versions, and the exact build commands.
5. Confirm that the submitted source reproduces the uploaded extension files.

## Safari package

1. Run the Safari Web Extension packager on macOS after the Chrome/Firefox package is frozen.
2. Review manifest warnings and unsupported APIs.
3. Build the generated macOS app in Xcode and test the extension in Safari.
4. Decide whether distribution is through App Store Connect/TestFlight or a Developer ID signed and notarized macOS app.
5. Do not describe Safari as supported until the converted package has passed the real Safari smoke test.

## Listing assets to prepare

- 16, 32, 48, and 128 pixel extension icons, plus any marketplace-specific artwork.
- Screenshots of room creation, joining, readiness, automatic playback, seeking, recovery, diagnostics, and the hidden mini-controller.
- Short description and long description.
- Browser support statement.
- Provider compatibility statement that distinguishes verified providers from generic HTML5 fallback.
- Privacy policy URL.
- Support URL and monitored contact.
- Changelog and current version.
- Clear statement that every participant uses their own service account.
- Clear statement that SyncYourJoy does not capture, retransmit, decrypt, or proxy media.
- Clear non-affiliation statement for third-party provider names.

## Reviewer test account policy

Do not provide streaming-service passwords, cookies, payment information, or subscription credentials. If a marketplace requires a test account, use a dedicated non-personal test account only if the service and its terms allow it. Otherwise provide a generic HTML5 fixture and instructions for the reviewer to test the synchronization protocol without protected media.

## Submission exit criteria

- All Gate 1-3 engineering and acceptance items are checked.
- No open P0 or P1 synchronization defects.
- Privacy contact and policy URL are real and monitored.
- Store declarations match the shipped manifest and behavior.
- Chrome package checksum is verified.
- Firefox package and source build are reproducible.
- Safari package status is either verified or explicitly deferred from the first launch.
- Rollback and support procedures are documented.

# Chrome on macOS

Usage Meter 0.2.13 adds the Apple Events automation entitlement and an app usage description explaining Chrome access. The project-owned entitlement file preserves the existing Electron runtime permissions. This is a shell change, so install the new app/DMG once; older shells reject this Core.

Select **Sign In** in Usage Meter. Version 0.2.14 selects a Chrome profile when its saved email uniquely matches the Claude account; otherwise bring the matching profile forward first. Allow Usage Meter to control Google Chrome if macOS asks. Chrome **View > Developer > Allow JavaScript from Apple Events** must be enabled in that profile. Keep Chrome open for background refreshes. A closed usage tab is reopened in the matching profile when it can be identified.

The app does not alter Chrome or macOS permission settings. Credentials stay in Chrome. Disconnecting or deleting a row removes its local tab association and preserves the shared browser login; use Claude's own menu to sign out of the website.

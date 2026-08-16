ShiftPilot v10

This build fixes the v9 dashboard runtime problems.

Fixes
- Fixed dashboard JavaScript stopping during startup.
- Fixed Home → UPDATE PRICE button.
- Fixed Home → START / END SHIFT button.
- Fixed Vehicle → Save vehicle.
- Fixed Order Checker after the v9 redesign.
- Fixed weekly Home stats to use the real stored weekly data.
- Fixed Today's Plan to read the actual schedule structure.
- Added safer rendering so missing optional cards do not break the whole app.
- Updated PWA cache to shiftpilot-v10.

Queensland fuel pricing
- The existing Netlify fuel-prices function remains included.
- Home UPDATE PRICE now opens More and scrolls to the Queensland fuel-price section.
- More → Get government fuel price calls the deployed Netlify function.
- Success should show QLD GOV and the government price.
- Failure should display a visible error instead of silently doing nothing.

Deploy
Replace your GitHub repository files with the extracted v10 contents and commit to main.
Netlify should automatically deploy the commit.

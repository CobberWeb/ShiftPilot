ShiftPilot v7

Fuel-price integration
- Added a real Queensland Government Open Data lookup through a Netlify Function.
- Enter a Queensland suburb/area and fuel type under More.
- ShiftPilot dynamically finds the newest published monthly Queensland Fuel Prices dataset.
- It calculates the latest price per station for the selected suburb/fuel type.
- Shows:
  - median/typical price
  - cheapest price
  - number of matching stations
  - up to five cheapest stations
  - government dataset month/source
- The median government price becomes the price used for ShiftPilot fuel-cost estimates.
- This is deliberately labelled a government SNAPSHOT, not live fuel pricing, because the free public Open Data series is published monthly.

Deploy requirements
- Deploy the ENTIRE extracted ShiftPilot_v7 folder to Netlify.
- Keep netlify.toml and the netlify/functions folder.
- Netlify will deploy the included fuel-prices serverless function automatically.

Existing features remain:
- live shift timer with seconds
- shift history + delete shift
- start/end odometer
- total / on-order / off-order km
- expenses main tab
- manual fuel price only when recording an actual Fuel expense
- tax reports under More

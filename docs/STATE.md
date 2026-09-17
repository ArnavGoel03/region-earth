# Meridian state

18 September 2026 restart review. Source lives in `ArnavGoel03/region-earth`,
with canonical checkout `~/dev/region-earth`. Static Vercel site, no application
build step. README describes the renderer, geography and fallback architecture.

## Current availability

`https://region-earth.vercel.app` returns HTTP 503 with
`x-vercel-error: DEPLOYMENT_PAUSED`. This supersedes README's historical live
link as an availability claim. No hosting setting or spending limit changed.

## Performance audit continuation

The continuous frame loop in `app.js` updates the orbit, uniforms and renderer.
Normal motion intentionally animates the full-screen globe and network pulses;
reduced motion freezes time-dependent values but still schedules frames.
The conditional recommendation is to measure idle/reduced-motion GPU and CPU
cost before changing scheduling. An optimization must preserve inertia,
selection/search slerp, resize, density changes, hover and backend fallback.

All 19 existing geography/camera tests pass with
`node --test test/geo.test.js`. No runtime source changed. Browser connection
selection reports unavailable and discovery returns `[]`, so GPU profiles,
rendered backend comparisons and real frame counts remain unexecuted. No speed
or energy improvement is claimed. Do not infer a rendering pass from math tests.

Outstanding: hosting restoration and a browser for the conditional measurement.
The cross-project queue is tracked in Portfolio's performance audit records.

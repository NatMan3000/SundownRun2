#!/bin/bash
# usage: _run.sh <TestName>   (TEST_RUNNER_* env vars pass through to the test)
# Builds the XCUITest bundle once into $IOS_SIM_OUT/dd, then runs a single test on the booted simulator.
. "$(dirname "${BASH_SOURCE[0]}")/_env.sh"
LOG="$IOS_SIM_OUT/last-run.log"
cd "$RIG_DIR/proj" || exit 1
if [ ! -d "$IOS_SIM_OUT/dd/Build/Products" ]; then
  command -v xcodegen >/dev/null || { echo "xcodegen missing: brew install xcodegen" >&2; exit 1; }
  xcodegen generate --quiet || exit 1
  xcodebuild build-for-testing -project Rig.xcodeproj -scheme Rig -destination "id=$SIM_UDID" -derivedDataPath "$IOS_SIM_OUT/dd" > "$IOS_SIM_OUT/build.log" 2>&1 \
    || { echo "build failed, see $IOS_SIM_OUT/build.log" >&2; exit 1; }
fi
xcodebuild test-without-building -project Rig.xcodeproj -scheme Rig -destination "id=$SIM_UDID" -derivedDataPath "$IOS_SIM_OUT/dd" -only-testing:UITests/RigTests/"$1" > "$LOG" 2>&1
grep -E "Test (Case|Suite).*(passed|failed)|TEST (SUCCEEDED|FAILED)|error:" "$LOG" | tail -3

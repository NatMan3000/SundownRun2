# Sourced by the rig scripts. Finds the booted iPhone 17 Pro, and where build output and shots go.
RIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_SIM_OUT="${IOS_SIM_OUT:-/tmp/sr2/ios-sim}"
mkdir -p "$IOS_SIM_OUT"
# "iPhone 17 Pro (<udid>) (Booted)" - the Pro Max has its own name, so the exact name is matched
SIM_UDID="$(xcrun simctl list devices booted | sed -nE 's/^ *iPhone 17 Pro \(([0-9A-Fa-f-]{36})\) \(Booted\).*/\1/p' | head -1)"
if [ -z "$SIM_UDID" ]; then
  echo "no booted iPhone 17 Pro: run  xcrun simctl boot \"iPhone 17 Pro\"  first" >&2
  exit 1
fi

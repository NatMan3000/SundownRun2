#!/bin/bash
# usage: pinch.sh scale velocity [label]   (two real fingers: scale above 1 with a positive velocity spreads them, below 1 with a negative one squeezes;
# centred on the page's web view, or on the first element whose label contains [label]; about 3 minutes on a live game page)
TEST_RUNNER_SCALE=$1 TEST_RUNNER_VELOCITY=$2 TEST_RUNNER_LABEL=$3 exec "$(dirname "${BASH_SOURCE[0]}")/_run.sh" testPinch

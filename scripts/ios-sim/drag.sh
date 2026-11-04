#!/bin/bash
# usage: drag.sh x1 y1 x2 y2   (same coordinates as tap.sh; about 3 minutes on a live game page)
TEST_RUNNER_X1=$1 TEST_RUNNER_Y1=$2 TEST_RUNNER_X2=$3 TEST_RUNNER_Y2=$4 exec "$(dirname "${BASH_SOURCE[0]}")/_run.sh" testDrag
